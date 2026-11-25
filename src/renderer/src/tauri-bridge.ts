import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ModDeckApi, StateChangedEvent } from '../../shared/ipc'
import type {
  AutoDetectPathsResult,
  Bootstrap,
  CharacterHashConflict,
  ClearShaderCacheResult,
  ConfigBundleInspection,
  D3dxSyncStatus,
  EnvironmentCheck,
  ExportPresetResult,
  GameConflictAuditReport,
  GameSnapshot,
  ImportConfigBundleResult,
  ImportParseResult,
  ImportPresetsResult,
  ImportResult,
  ImportRosterResult,
  InstallModeInfo,
  LegacyCleanupResult,
  ModDetails,
  ModInfo,
  ModStaticAnalysis,
  ModVariantPreset,
  RosterPreset,
  RosterSchemeImportInspection,
  RosterSyncResult,
  RosterSyncStatus,
  SaveModPresetResult,
  Settings,
  SimpleResult,
  StorageOverview,
  ToggleResult,
  UpdateCheckResult,
  UpdateInstallResult
} from '../../shared/types'

/**
 * Resolves a local path for a dropped File; in Tauri WebView2 (with HTML5 drag-drop enabled),
 * `File.path` is unavailable so non-empty dropped files are staged into the backend temp dir.
 */
export async function resolveDroppedFilePath(file: File): Promise<string> {
  const direct = window.moddeck?.getPathForFile(file) || ''
  if (direct) return direct
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && file.size > 0) {
    try {
      const buffer = await file.arrayBuffer()
      return await invoke<string>('stage_dropped_file', buffer, {
        headers: { 'x-file-name': encodeURIComponent(file.name) }
      })
    } catch {
      return ''
    }
  }
  return ''
}

const MAX_DROP_STAGING_BYTES = 2 * 1024 * 1024 * 1024

interface CollectedDropDirFile {
  relPath: string
  file: File
}

async function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = []
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (batch.length === 0) break
    all.push(...batch)
  }
  return all
}

async function collectDirectoryFiles(
  entry: FileSystemDirectoryEntry,
  prefix = entry.name
): Promise<CollectedDropDirFile[]> {
  const children = await readAllDirectoryEntries(entry.createReader())
  const collected: CollectedDropDirFile[] = []
  for (const child of children) {
    const childRel = `${prefix}/${child.name}`
    if (child.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        ;(child as FileSystemFileEntry).file(resolve, reject)
      })
      collected.push({ relPath: childRel, file })
    } else if (child.isDirectory) {
      const nested = await collectDirectoryFiles(child as FileSystemDirectoryEntry, childRel)
      collected.push(...nested)
    }
  }
  return collected
}

/**
 * Captures dropped items synchronously before any `await`, supporting both files and directories.
 */
export async function resolveDroppedItems(
  dataTransfer: DataTransfer
): Promise<{ paths: string[]; tooLarge?: boolean }> {
  type CapturedItem =
    | { kind: 'dir'; entry: FileSystemDirectoryEntry }
    | { kind: 'file'; file: File }

  const captured: CapturedItem[] = []
  const itemList = Array.from(dataTransfer.items || [])
  for (const item of itemList) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isDirectory) {
      captured.push({ kind: 'dir', entry: entry as FileSystemDirectoryEntry })
    } else {
      const file = item.getAsFile()
      if (file) captured.push({ kind: 'file', file })
    }
  }
  if (captured.length === 0) {
    for (const file of Array.from(dataTransfer.files || [])) {
      captured.push({ kind: 'file', file })
    }
  }

  const hasDirs = captured.some((item) => item.kind === 'dir')
  if (!hasDirs) {
    const paths = (
      await Promise.all(
        captured
          .filter((item): item is { kind: 'file'; file: File } => item.kind === 'file')
          .map((item) => resolveDroppedFilePath(item.file))
      )
    ).filter((item): item is string => Boolean(item))
    return { paths }
  }

  // First collect all directory files to verify total size before staging over IPC.
  const dirFileBatches: Array<{ rootName: string; files: CollectedDropDirFile[] }> = []
  let totalBytes = 0
  for (const item of captured) {
    if (item.kind === 'dir') {
      const files = await collectDirectoryFiles(item.entry, item.entry.name)
      for (const f of files) totalBytes += f.file.size
      dirFileBatches.push({ rootName: item.entry.name, files })
    } else {
      totalBytes += item.file.size
    }
  }

  if (totalBytes > MAX_DROP_STAGING_BYTES) {
    return { paths: [], tooLarge: true }
  }

  const paths: string[] = []
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  for (const batch of dirFileBatches) {
    let stagedRoot = ''
    for (const item of batch.files) {
      const buffer = await item.file.arrayBuffer()
      stagedRoot = await invoke<string>('stage_dropped_folder_file', buffer, {
        headers: {
          'x-drop-session': sessionId,
          'x-rel-path': encodeURIComponent(item.relPath)
        }
      })
    }
    if (stagedRoot) paths.push(stagedRoot)
  }

  for (const item of captured) {
    if (item.kind === 'file') {
      const resolved = await resolveDroppedFilePath(item.file)
      if (resolved) paths.push(resolved)
    }
  }

  return { paths }
}

export async function cleanupStagedDrops(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      await invoke<void>('cleanup_staged_drops', { paths })
    } catch {
      // ignore cleanup failures
    }
  }
}

export function ensureTauriBridge(): void {
  if (typeof window === 'undefined') return
  if (window.moddeck) return
  if (!('__TAURI_INTERNALS__' in window)) return

  const api: ModDeckApi = {
    bootstrap: () => invoke<Bootstrap>('bootstrap'),
    appInfo: () => invoke('app_info'),
    saveSettings: (patch) => invoke<Settings>('save_settings_cmd', { patch }),
    switchGame: (gameId) => invoke<GameSnapshot | null>('switch_game', { gameId }),
    scanGame: (gameId) => invoke<GameSnapshot | null>('scan_game', { gameId }),
    saveCustomGame: (gameDef, gameSettings) =>
      invoke('save_custom_game', { gameDef, gameSettings }),
    deleteCustomGame: (gameId) => invoke('delete_custom_game', { gameId }),
    toggleGameVisibility: (gameId, visible) =>
      invoke('toggle_game_visibility', { gameId, visible }),
    setOnlyShowConfiguredGames: (enabled) =>
      invoke('set_only_show_configured_games', { enabled }),
    getMods: (gameId, characterFolder) =>
      invoke<ModInfo[]>('get_mods', { gameId, characterFolder }),
    toggleMod: (gameId, characterFolder, modFolder, enable, exclusive = false) =>
      invoke('toggle_mod_cmd', { gameId, characterFolder, modFolder, enable, exclusive }),
    deleteMod: (gameId, characterFolder, modFolder) =>
      invoke<ToggleResult>('delete_mod', { gameId, characterFolder, modFolder }),
    deleteMods: (gameId, characterFolder, modFolders) =>
      invoke<ToggleResult>('delete_mods', { gameId, characterFolder, modFolders }),
    openModFolder: (gameId, characterFolder, modFolder) =>
      invoke('open_mod_folder', { gameId, characterFolder, modFolder }),
    openCharacterFolder: (gameId, characterFolder) =>
      invoke('open_character_folder', { gameId, characterFolder }),
    openPath: (kind, gameId) => invoke('open_path', { kind, gameId }),
    openBackupFolder: (backupId) => invoke<ToggleResult>('open_backup_folder', { backupId }),
    openExternalUrl: (url) => invoke<SimpleResult>('open_external_url', { url }),
    pickModsFolder: () => invoke<string | null>('pick_mods_folder'),
    pickXxmiRoot: () => invoke<AutoDetectPathsResult>('pick_xxmi_root'),
    autoDetectPaths: () => invoke<AutoDetectPathsResult>('auto_detect_paths'),
    pickGameExe: () => invoke<string | null>('pick_game_exe'),
    pickLoader: () => invoke<string | null>('pick_loader'),
    pickImportFiles: () => invoke<string[]>('pick_import_files'),
    pickImportFolder: () => invoke<string | null>('pick_import_folder'),
    pickImportFolders: () => invoke<string[]>('pick_import_folders'),
    pickCover: () => invoke<string | null>('pick_cover'),
    importRun: (request) => invoke<ImportResult>('import_run', { request }),
    importParse: (request) => invoke<ImportParseResult>('import_parse', { request }),
    importCommit: (request) => invoke<ImportResult>('import_commit', { request }),
    importDiscard: (sessionId) => invoke<void>('import_discard', { sessionId }),
    getPathForFile: (file: File) => (file as File & { path?: string }).path || '',
    updateCharacterMeta: (gameId, characterFolder, patch) =>
      invoke<GameSnapshot | null>('update_character_meta', { gameId, characterFolder, patch }),
    setCharacterCover: (gameId, characterFolder) =>
      invoke<ToggleResult>('set_character_cover', { gameId, characterFolder }),
    resetCharacterMeta: (gameId, characterFolder) =>
      invoke<GameSnapshot | null>('reset_character_meta', { gameId, characterFolder }),
    createCharacter: (gameId, input) =>
      invoke<GameSnapshot | null>('create_character', { gameId, input }),
    saveCharacterCoverData: (gameId, characterFolder, dataUrl) =>
      invoke<GameSnapshot | null>('save_character_cover_data', {
        gameId,
        characterFolder,
        dataUrl
      }),
    clearCharacterCover: (gameId, characterFolder) =>
      invoke<GameSnapshot | null>('clear_character_cover', { gameId, characterFolder }),
    setModsEnabled: async (gameId, characterFolder, folders, enable) => {
      for (const folder of folders) {
        const res = await api.toggleMod(gameId, characterFolder, folder, enable, false)
        if (!res.ok) return res
      }
      return { ok: true }
    },
    setOverlayPinned: (pinned) => invoke('set_overlay_pinned', { pinned }),
    showOverlayDetail: (request) => invoke<ToggleResult>('show_overlay_detail', { request }),
    hideOverlayDetail: async () => {
      await invoke('hide_overlay_detail')
    },
    sendModHotkey: (key) => invoke('send_mod_hotkey', { key }),
    getRosterPresets: (gameId) => invoke<RosterPreset[]>('get_roster_presets', { gameId }),
    saveRosterPreset: (gameId, input) =>
      invoke<ToggleResult>('save_roster_preset', { gameId, input }),
    applyRosterPreset: (gameId, presetId) =>
      invoke<ToggleResult>('apply_roster_preset', { gameId, presetId }),
    deleteRosterPreset: (gameId, presetId) =>
      invoke<ToggleResult>('delete_roster_preset', { gameId, presetId }),
    getD3dxAutoSaveInterval: (gameId) => invoke<number>('get_d3dx_auto_save_interval', { gameId }),
    setD3dxAutoSaveInterval: (gameId, interval) =>
      invoke<ToggleResult>('set_d3dx_auto_save_interval', { gameId, interval }),
    getD3dxSyncStatus: (gameId) => invoke<D3dxSyncStatus>('get_d3dx_sync_status', { gameId }),
    analyzeModIni: (gameId, characterFolder, modFolder) =>
      invoke<ModStaticAnalysis>('analyze_mod_ini', { gameId, characterFolder, modFolder }),
    scanCharacterHashConflicts: (gameId, characterFolder) =>
      invoke<CharacterHashConflict[]>('scan_character_hash_conflicts', {
        gameId,
        characterFolder
      }),
    addVariableIgnoreRule: (rule, scope, target) =>
      invoke<ToggleResult>('add_variable_ignore_rule', { rule, scope, target: target ?? null }),
    getModPresets: (gameId, characterFolder, modFolder) =>
      invoke<ModVariantPreset[]>('get_mod_presets', { gameId, characterFolder, modFolder }),
    saveModPreset: (gameId, characterFolder, modFolder, presetName, options) =>
      invoke<SaveModPresetResult>('save_mod_preset', {
        gameId,
        characterFolder,
        modFolder,
        presetName,
        options: options ?? null
      }),
    applyModPreset: (gameId, characterFolder, modFolder, presetId) =>
      invoke<ToggleResult>('apply_mod_preset', {
        gameId,
        characterFolder,
        modFolder,
        presetId
      }),
    deleteModPreset: (gameId, characterFolder, modFolder, presetId) =>
      invoke<ToggleResult>('delete_mod_preset', {
        gameId,
        characterFolder,
        modFolder,
        presetId
      }),
    exportModPresets: (gameId, characterFolder, modFolder, presetId) =>
      invoke<ExportPresetResult>('export_mod_presets', {
        gameId,
        characterFolder,
        modFolder,
        presetId: presetId ?? null
      }),
    importModPresets: (gameId, characterFolder, modFolder) =>
      invoke<ImportPresetsResult>('import_mod_presets', {
        gameId,
        characterFolder,
        modFolder
      }),
    importModPresetsFromPath: (gameId, characterFolder, modFolder, filePath) =>
      invoke<ImportPresetsResult>('import_mod_presets_from_path', {
        gameId,
        characterFolder,
        modFolder,
        filePath
      }),
    exportRosterPreset: (gameId, presetId) =>
      invoke<ExportPresetResult>('export_roster_preset', { gameId, presetId }),
    inspectRosterPresetFile: (gameId) =>
      invoke<RosterSchemeImportInspection>('inspect_roster_preset_file', { gameId }),
    inspectRosterPresetFileFromPath: (gameId, filePath) =>
      invoke<RosterSchemeImportInspection>('inspect_roster_preset_file_from_path', {
        gameId,
        filePath
      }),
    confirmImportRosterPreset: (gameId, rawExport, customName) =>
      invoke<ImportRosterResult>('confirm_import_roster_preset', {
        gameId,
        rawExport,
        customName: customName ?? null
      }),
    getModDetails: (gameId, characterFolder, modFolder) =>
      invoke<ModDetails>('get_mod_details_cmd', { gameId, characterFolder, modFolder }),
    setModPreview: (gameId, characterFolder, modFolder, sourcePath) =>
      invoke<ToggleResult>('set_mod_preview', {
        gameId,
        characterFolder,
        modFolder,
        sourcePath
      }),
    reorderCharacters: (gameId, folders) =>
      invoke<ToggleResult>('reorder_characters', { gameId, folders }),
    reorderMods: (gameId, characterFolder, folders) =>
      invoke<ToggleResult>('reorder_mods', { gameId, characterFolder, folders }),
    launchGame: (gameId) => invoke<SimpleResult>('launch_game', { gameId }),
    launchLoader: (gameId) => invoke<SimpleResult>('launch_loader', { gameId }),
    getOverlayHotkey: () => invoke<string>('get_overlay_hotkey'),
    setOverlayHotkey: (hotkey) => invoke('set_overlay_hotkey', { hotkey }),
    overlayHide: async () => {
      await invoke('overlay_hide')
    },
    overlayOpenManager: async () => {
      await invoke('overlay_open_manager')
    },
    toggleOverlay: async () => {
      await invoke('toggle_overlay')
    },
    checkEnvironment: (gameId) => invoke<EnvironmentCheck[]>('check_environment', { gameId: gameId ?? null }),
    openEnvironmentFolder: (gameId) => invoke<ToggleResult>('open_environment_folder', { gameId }),
    clearShaderCache: (gameId) => invoke<ClearShaderCacheResult>('clear_shader_cache', { gameId }),
    setCacheShaders: (gameId, enabled) => invoke<ToggleResult>('set_cache_shaders', { gameId, enabled }),
    setExcludeDisabledRule: (gameId, enabled) =>
      invoke<ToggleResult>('set_exclude_disabled_rule', { gameId, enabled }),
    getInstallMode: () => invoke<InstallModeInfo>('get_install_mode'),
    checkAppUpdate: (mirrorMode, customMirror) =>
      invoke<UpdateCheckResult>('check_app_update', {
        mirrorMode: mirrorMode ?? null,
        customMirror: customMirror ?? null
      }),
    installAppUpdate: (assetUrl, assetName, expectedSize) =>
      invoke<UpdateInstallResult>('install_app_update', {
        assetUrl,
        assetName,
        expectedSize: expectedSize ?? null
      }),
    auditGameConflicts: (gameId) => invoke<GameConflictAuditReport>('audit_game_conflicts', { gameId }),
    exportConflictAuditReport: (gameId, report) =>
      invoke<ExportPresetResult>('export_conflict_audit_report', { gameId, report }),
    getStorageOverview: () => invoke<StorageOverview>('get_storage_overview'),
    cleanLegacyElectronData: () => invoke<LegacyCleanupResult>('clean_legacy_electron_data'),
    restoreModBackup: (backupId) => invoke<ToggleResult>('restore_mod_backup', { backupId }),
    deleteModBackup: (backupId) => invoke<ToggleResult>('delete_mod_backup', { backupId }),
    pruneModBackups: (olderThanDays) => invoke('prune_mod_backups', { olderThanDays }),
    exportConfigBundle: () => invoke<ExportPresetResult>('export_config_bundle'),
    inspectConfigBundle: () => invoke<ConfigBundleInspection>('inspect_config_bundle'),
    importConfigBundle: (filePath, options) =>
      invoke<ImportConfigBundleResult>('import_config_bundle', { filePath, options }),
    reloadF10: () => invoke('reload_f10'),
    setReloadHotkey: (hotkey) => invoke('set_reload_hotkey', { hotkey }),
    getPendingPresetCount: (gameId) =>
      invoke<number>('get_pending_preset_count', { gameId: gameId ?? null }),
    getRosterStatus: () => invoke<RosterSyncStatus>('get_roster_status'),
    syncRemoteRoster: (customUrl) => invoke<RosterSyncResult>('sync_remote_roster', { customUrl }),
    onStateChanged: (listener) => {
      let unlisten: UnlistenFn | null = null
      let disposed = false
      listen<StateChangedEvent>('app:state-changed', (event) => {
        if (!disposed) listener(event.payload ?? {})
      })
        .then((fn) => {
          if (disposed) fn()
          else unlisten = fn
        })
        .catch(() => undefined)
      return () => {
        disposed = true
        if (unlisten) unlisten()
      }
    }
  }

  window.moddeck = api
}
