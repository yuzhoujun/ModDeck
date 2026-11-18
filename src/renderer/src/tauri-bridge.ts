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
  StorageOverview,
  ToggleResult
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

function notMigrated<T>(feature: string, fallback: T): Promise<T> {
  console.warn(`[ModDeck Tauri POC] "${feature}" is scheduled for a later migration stage.`)
  return Promise.resolve(fallback)
}

export function ensureTauriBridge(): void {
  if (typeof window === 'undefined') return
  if (window.moddeck) return
  if (!('__TAURI_INTERNALS__' in window)) return

  const pocError = (feature: string) => ({
    ok: false as const,
    error: `Stage 0 POC: ${feature} not yet migrated`
  })

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
    showOverlayDetail: () => notMigrated('showOverlayDetail', pocError('showOverlayDetail')),
    hideOverlayDetail: () => notMigrated('hideOverlayDetail', undefined),
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
    launchGame: () => notMigrated('launchGame', pocError('launchGame')),
    launchLoader: () => notMigrated('launchLoader', pocError('launchLoader')),
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
    auditGameConflicts: (gameId) => invoke<GameConflictAuditReport>('audit_game_conflicts', { gameId }),
    exportConflictAuditReport: (gameId, report) =>
      invoke<ExportPresetResult>('export_conflict_audit_report', { gameId, report }),
    getStorageOverview: () => invoke<StorageOverview>('get_storage_overview'),
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
