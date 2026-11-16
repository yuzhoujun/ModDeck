import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ModDeckApi, StateChangedEvent } from '../../shared/ipc'
import type {
  AutoDetectPathsResult,
  Bootstrap,
  ClearShaderCacheResult,
  EnvironmentCheck,
  GameSnapshot,
  ModDetails,
  ModInfo,
  RosterSyncResult,
  RosterSyncStatus,
  Settings,
  ToggleResult
} from '../../shared/types'

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
    deleteMod: () => notMigrated('deleteMod', pocError('deleteMod')),
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
    pickImportFiles: () => notMigrated('pickImportFiles', []),
    pickImportFolder: () => notMigrated('pickImportFolder', null),
    pickImportFolders: () => notMigrated('pickImportFolders', []),
    pickCover: () => invoke<string | null>('pick_cover'),
    importRun: () =>
      notMigrated('importRun', { items: [], importedMods: 0, createdCharacters: [] }),
    importParse: () =>
      notMigrated('importParse', {
        sessionId: '',
        candidates: [],
        errors: [{ source: 'poc', message: 'Stage 0 POC' }]
      }),
    importCommit: () =>
      notMigrated('importCommit', { items: [], importedMods: 0, createdCharacters: [] }),
    importDiscard: () => notMigrated('importDiscard', undefined),
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
    getRosterPresets: () => notMigrated('getRosterPresets', []),
    saveRosterPreset: () => notMigrated('saveRosterPreset', pocError('saveRosterPreset')),
    applyRosterPreset: () => notMigrated('applyRosterPreset', pocError('applyRosterPreset')),
    deleteRosterPreset: () => notMigrated('deleteRosterPreset', pocError('deleteRosterPreset')),
    getD3dxAutoSaveInterval: () => notMigrated('getD3dxAutoSaveInterval', 60),
    setD3dxAutoSaveInterval: () =>
      notMigrated('setD3dxAutoSaveInterval', pocError('setD3dxAutoSaveInterval')),
    getD3dxSyncStatus: () =>
      notMigrated('getD3dxSyncStatus', {
        exists: false,
        mtimeMs: 0,
        autoSaveInterval: 60,
        gameRunning: false,
        pendingCount: 0
      }),
    analyzeModIni: () =>
      notMigrated('analyzeModIni', {
        variables: [],
        dependencies: [],
        hashes: [],
        nonPersistControlVars: [],
        localIgnoreRules: [],
        hasLocalIgnoreFile: false
      }),
    scanCharacterHashConflicts: () => notMigrated('scanCharacterHashConflicts', []),
    addVariableIgnoreRule: () =>
      notMigrated('addVariableIgnoreRule', pocError('addVariableIgnoreRule')),
    getModPresets: () => notMigrated('getModPresets', []),
    saveModPreset: () => notMigrated('saveModPreset', pocError('saveModPreset')),
    applyModPreset: () => notMigrated('applyModPreset', pocError('applyModPreset')),
    deleteModPreset: () => notMigrated('deleteModPreset', pocError('deleteModPreset')),
    exportModPresets: () => notMigrated('exportModPresets', pocError('exportModPresets')),
    importModPresets: () => notMigrated('importModPresets', pocError('importModPresets')),
    importModPresetsFromPath: () =>
      notMigrated('importModPresetsFromPath', pocError('importModPresetsFromPath')),
    exportRosterPreset: () => notMigrated('exportRosterPreset', pocError('exportRosterPreset')),
    inspectRosterPresetFile: () =>
      notMigrated('inspectRosterPresetFile', {
        ok: false,
        error: 'Stage 0 POC',
        totalCharacters: 0,
        matchedCharacters: 0,
        totalMods: 0,
        matchedMods: 0,
        missingCharacters: [],
        missingMods: [],
        matchedItems: []
      }),
    inspectRosterPresetFileFromPath: () =>
      notMigrated('inspectRosterPresetFileFromPath', {
        ok: false,
        error: 'Stage 0 POC',
        totalCharacters: 0,
        matchedCharacters: 0,
        totalMods: 0,
        matchedMods: 0,
        missingCharacters: [],
        missingMods: [],
        matchedItems: []
      }),
    confirmImportRosterPreset: () =>
      notMigrated('confirmImportRosterPreset', pocError('confirmImportRosterPreset')),
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
    auditGameConflicts: () =>
      notMigrated('auditGameConflicts', {
        gameId: '',
        modsPath: '',
        scannedAt: Date.now(),
        scannedMods: 0,
        scannedIniFiles: 0,
        items: [],
        summary: { high: 0, warning: 0, info: 0 }
      }),
    exportConflictAuditReport: () =>
      notMigrated('exportConflictAuditReport', pocError('exportConflictAuditReport')),
    getStorageOverview: () =>
      notMigrated('getStorageOverview', {
        dataDir: '',
        totalBytes: 0,
        categories: [],
        backups: []
      }),
    restoreModBackup: () => notMigrated('restoreModBackup', pocError('restoreModBackup')),
    deleteModBackup: () => notMigrated('deleteModBackup', pocError('deleteModBackup')),
    pruneModBackups: () => notMigrated('pruneModBackups', pocError('pruneModBackups')),
    exportConfigBundle: () => notMigrated('exportConfigBundle', pocError('exportConfigBundle')),
    inspectConfigBundle: () => notMigrated('inspectConfigBundle', pocError('inspectConfigBundle')),
    importConfigBundle: () => notMigrated('importConfigBundle', pocError('importConfigBundle')),
    reloadF10: () => invoke('reload_f10'),
    setReloadHotkey: (hotkey) => invoke('set_reload_hotkey', { hotkey }),
    getPendingPresetCount: () => invoke<number>('get_pending_preset_count'),
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
