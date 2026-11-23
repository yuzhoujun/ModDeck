import type {
  AppInfo,
  AutoDetectPathsResult,
  CharacterHashConflict,
  ClearShaderCacheResult,
  ConfigBundleInspection,
  D3dxSyncStatus,
  GameConflictAuditReport,
  ImportConfigBundleOptions,
  ImportConfigBundleResult,
  ModVariantPreset,
  ModStaticAnalysis,
  RosterPreset,
  SaveModPresetOptions,
  SaveModPresetResult,
  SaveRosterPresetInput,
  Bootstrap,
  CharacterMeta,
  CreateCharacterInput,
  EnvironmentCheck,
  ExportPresetResult,
  GameDef,
  GameId,
  GameSettings,
  GameSnapshot,
  ImportCommitRequest,
  ImportParseRequest,
  ImportParseResult,
  ImportPresetsResult,
  ImportRequest,
  ImportResult,
  ImportRosterResult,
  InstallModeInfo,
  LegacyCleanupResult,
  ModDetails,
  ModInfo,
  OverlayDetailRequest,
  RosterPresetExportFile,
  RosterSchemeImportInspection,
  RosterSyncResult,
  RosterSyncStatus,
  Settings,
  SettingsPatch,
  SimpleResult,
  StorageOverview,
  ToggleResult,
  UpdateCheckResult,
  UpdateInstallResult
} from './types'

export const IPC = {
  bootstrap: 'app:bootstrap',
  appInfo: 'app:info',
  saveSettings: 'settings:save',
  switchGame: 'game:switch',
  scanGame: 'game:scan',
  saveCustomGame: 'game:save-custom',
  deleteCustomGame: 'game:delete-custom',
  toggleGameVisibility: 'game:toggle-visibility',
  setOnlyShowConfiguredGames: 'game:set-only-configured',
  getMods: 'mods:list',
  toggleMod: 'mods:toggle',
  deleteMod: 'mods:delete',
  deleteMods: 'mods:delete-batch',
  openModFolder: 'shell:open-mod-folder',
  openCharacterFolder: 'shell:open-character-folder',
  openPath: 'shell:open-path',
  openExternalUrl: 'shell:open-external-url',
  pickModsFolder: 'dialog:mods-folder',
  pickXxmiRoot: 'dialog:xxmi-root',
  autoDetectPaths: 'settings:auto-detect-paths',
  pickGameExe: 'dialog:game-exe',
  pickLoader: 'dialog:loader',
  pickImportFiles: 'dialog:import-files',
  pickImportFolder: 'dialog:import-folder',
  pickImportFolders: 'dialog:import-folders',
  pickCover: 'dialog:cover',
  importRun: 'import:run',
  importParse: 'import:parse',
  importCommit: 'import:commit',
  importDiscard: 'import:discard',
  updateCharacterMeta: 'character:update-meta',
  setCharacterCover: 'character:set-cover',
  resetCharacterMeta: 'character:reset-meta',
  createCharacter: 'character:create',
  saveCharacterCoverData: 'character:save-cover-data',
  clearCharacterCover: 'character:clear-cover',
  getModDetails: 'mods:details',
  getModPresets: 'presets:get-mod-presets',
  saveModPreset: 'presets:save-mod-preset',
  applyModPreset: 'presets:apply-mod-preset',
  deleteModPreset: 'presets:delete-mod-preset',
  getRosterPresets: 'presets:get-roster-presets',
  saveRosterPreset: 'presets:save-roster-preset',
  applyRosterPreset: 'presets:apply-roster-preset',
  deleteRosterPreset: 'presets:delete-roster-preset',
  exportModPresets: 'presets:export-mod-presets',
  importModPresets: 'presets:import-mod-presets',
  importModPresetsFromPath: 'presets:import-mod-presets-from-path',
  exportRosterPreset: 'presets:export-roster-preset',
  inspectRosterPresetFile: 'presets:inspect-roster-preset-file',
  inspectRosterPresetFileFromPath: 'presets:inspect-roster-preset-file-from-path',
  confirmImportRosterPreset: 'presets:confirm-import-roster-preset',
  getD3dxAutoSaveInterval: 'd3dx:get-auto-save-interval',
  setD3dxAutoSaveInterval: 'd3dx:set-auto-save-interval',
  getD3dxSyncStatus: 'd3dx:get-sync-status',
  analyzeModIni: 'mods:analyze-ini',
  scanCharacterHashConflicts: 'character:scan-hash-conflicts',
  addVariableIgnoreRule: 'presets:add-variable-ignore-rule',
  setModPreview: 'mods:set-preview',
  setModsEnabled: 'mods:set-enabled',
  reorderCharacters: 'character:reorder',
  reorderMods: 'mods:reorder',
  launchGame: 'launch:game',
  launchLoader: 'launch:loader',
  getOverlayHotkey: 'overlay:get-hotkey',
  setOverlayHotkey: 'overlay:set-hotkey',
  setOverlayPinned: 'overlay:set-pinned',
  showOverlayDetail: 'overlay:show-detail',
  hideOverlayDetail: 'overlay:hide-detail',
  sendModHotkey: 'overlay:send-hotkey',
  overlayHide: 'overlay:hide',
  overlayOpenManager: 'overlay:open-manager',
  overlayToggle: 'overlay:toggle',
  checkEnvironment: 'env:check',
  openEnvironmentFolder: 'env:open-folder',
  clearShaderCache: 'env:clear-shader-cache',
  setCacheShaders: 'env:set-cache-shaders',
  setExcludeDisabledRule: 'env:set-exclude-disabled-rule',
  getInstallMode: 'updater:install-mode',
  checkAppUpdate: 'updater:check',
  installAppUpdate: 'updater:install',
  auditGameConflicts: 'mods:audit-conflicts',
  exportConflictAuditReport: 'mods:export-conflict-report',
  getStorageOverview: 'storage:overview',
  restoreModBackup: 'storage:restore-backup',
  deleteModBackup: 'storage:delete-backup',
  pruneModBackups: 'storage:prune-backups',
  exportConfigBundle: 'bundle:export',
  inspectConfigBundle: 'bundle:inspect',
  importConfigBundle: 'bundle:import',
  reloadF10: 'env:reload-f10',
  setReloadHotkey: 'env:set-reload-hotkey',
  getPendingPresetCount: 'preset:pending-count',
  rosterStatus: 'roster:status',
  rosterSync: 'roster:sync',
  stateChanged: 'app:state-changed'
} as const

export interface StateChangedEvent {
  gameId?: GameId
  characterFolder?: string
  pendingPresetCount?: number
}

export interface ModDeckApi {
  bootstrap(): Promise<Bootstrap>
  appInfo(): Promise<AppInfo>
  saveSettings(patch: SettingsPatch): Promise<Settings>
  switchGame(gameId: GameId): Promise<GameSnapshot | null>
  scanGame(gameId: GameId): Promise<GameSnapshot | null>
  saveCustomGame(
    gameDef: GameDef,
    gameSettings?: GameSettings
  ): Promise<{ ok: boolean; error?: string; snapshot?: GameSnapshot }>
  deleteCustomGame(
    gameId: string
  ): Promise<{ ok: boolean; error?: string; snapshot?: GameSnapshot }>
  toggleGameVisibility(
    gameId: string,
    visible?: boolean
  ): Promise<{ ok: boolean; hiddenGameIds: string[] }>
  setOnlyShowConfiguredGames(
    enabled: boolean
  ): Promise<{ ok: boolean; onlyShowConfiguredGames: boolean }>
  getMods(gameId: GameId, characterFolder: string): Promise<ModInfo[]>
  toggleMod(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    enable: boolean,
    exclusive?: boolean
  ): Promise<ToggleResult>
  deleteMod(gameId: GameId, characterFolder: string, modFolder: string): Promise<ToggleResult>
  deleteMods(gameId: GameId, characterFolder: string, modFolders: string[]): Promise<ToggleResult>
  openModFolder(gameId: GameId, characterFolder: string, modFolder: string): Promise<ToggleResult>
  openCharacterFolder(gameId: GameId, characterFolder: string): Promise<ToggleResult>
  openPath(kind: 'mods' | 'game' | 'loader' | 'data' | 'logs' | 'languages' | 'locales', gameId?: GameId): Promise<ToggleResult>
  openExternalUrl(url: string): Promise<SimpleResult>
  pickModsFolder(): Promise<string | null>
  pickXxmiRoot(): Promise<AutoDetectPathsResult>
  autoDetectPaths(): Promise<AutoDetectPathsResult>
  pickGameExe(): Promise<string | null>
  pickLoader(): Promise<string | null>
  pickImportFiles(): Promise<string[]>
  pickImportFolder(): Promise<string | null>
  pickImportFolders(): Promise<string[]>
  pickCover(): Promise<string | null>
  importRun(request: ImportRequest): Promise<ImportResult>
  importParse(request: ImportParseRequest): Promise<ImportParseResult>
  importCommit(request: ImportCommitRequest): Promise<ImportResult>
  importDiscard(sessionId: string): Promise<void>
  getPathForFile(file: File): string
  updateCharacterMeta(
    gameId: GameId,
    characterFolder: string,
    patch: Partial<CharacterMeta>
  ): Promise<GameSnapshot | null>
  setCharacterCover(gameId: GameId, characterFolder: string): Promise<ToggleResult>
  resetCharacterMeta(gameId: GameId, characterFolder: string): Promise<GameSnapshot | null>
  createCharacter(
    gameId: GameId,
    input: CreateCharacterInput
  ): Promise<GameSnapshot | null>
  saveCharacterCoverData(
    gameId: GameId,
    characterFolder: string,
    dataUrl: string
  ): Promise<GameSnapshot | null>
  clearCharacterCover(gameId: GameId, characterFolder: string): Promise<GameSnapshot | null>
  setModsEnabled(
    gameId: GameId,
    characterFolder: string,
    folders: string[],
    enable: boolean
  ): Promise<ToggleResult>
  setOverlayPinned(pinned: boolean): Promise<{ ok: boolean; error?: string }>
  showOverlayDetail(request: OverlayDetailRequest): Promise<ToggleResult>
  hideOverlayDetail(): Promise<void>
  sendModHotkey(key: string): Promise<ToggleResult>
  getRosterPresets(gameId: GameId): Promise<RosterPreset[]>
  saveRosterPreset(gameId: GameId, input: SaveRosterPresetInput): Promise<ToggleResult>
  applyRosterPreset(gameId: GameId, presetId: string): Promise<ToggleResult>
  deleteRosterPreset(gameId: GameId, presetId: string): Promise<ToggleResult>
  getD3dxAutoSaveInterval(gameId: GameId): Promise<number>
  setD3dxAutoSaveInterval(gameId: GameId, interval: number): Promise<ToggleResult>
  getD3dxSyncStatus(gameId: GameId): Promise<D3dxSyncStatus>
  analyzeModIni(
    gameId: GameId,
    characterFolder: string,
    modFolder: string
  ): Promise<ModStaticAnalysis>
  scanCharacterHashConflicts(
    gameId: GameId,
    characterFolder: string
  ): Promise<CharacterHashConflict[]>
  addVariableIgnoreRule(
    rule: string,
    scope: 'global' | 'local',
    target?: { gameId: GameId; characterFolder: string; modFolder: string }
  ): Promise<ToggleResult>
  getModPresets(
    gameId: GameId,
    characterFolder: string,
    modFolder: string
  ): Promise<ModVariantPreset[]>
  saveModPreset(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    presetName: string,
    options?: SaveModPresetOptions
  ): Promise<SaveModPresetResult>
  applyModPreset(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    presetId: string
  ): Promise<ToggleResult>
  deleteModPreset(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    presetId: string
  ): Promise<ToggleResult>
  exportModPresets(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    presetId?: string
  ): Promise<ExportPresetResult>
  importModPresets(
    gameId: GameId,
    characterFolder: string,
    modFolder: string
  ): Promise<ImportPresetsResult>
  importModPresetsFromPath(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    filePath: string
  ): Promise<ImportPresetsResult>
  exportRosterPreset(gameId: GameId, presetId: string): Promise<ExportPresetResult>
  inspectRosterPresetFile(gameId: GameId): Promise<RosterSchemeImportInspection>
  inspectRosterPresetFileFromPath(gameId: GameId, filePath: string): Promise<RosterSchemeImportInspection>
  confirmImportRosterPreset(
    gameId: GameId,
    rawExport: RosterPresetExportFile,
    customName?: string
  ): Promise<ImportRosterResult>
  getModDetails(
    gameId: GameId,
    characterFolder: string,
    modFolder: string
  ): Promise<ModDetails>
  setModPreview(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    sourcePath?: string
  ): Promise<ToggleResult>
  reorderCharacters(gameId: GameId, folders: string[]): Promise<ToggleResult>
  reorderMods(
    gameId: GameId,
    characterFolder: string,
    folders: string[]
  ): Promise<ToggleResult>
  launchGame(gameId: GameId): Promise<SimpleResult>
  launchLoader(gameId: GameId): Promise<SimpleResult>
  getOverlayHotkey(): Promise<string>
  setOverlayHotkey(hotkey: string): Promise<{ ok: boolean; hotkey?: string; error?: string }>
  overlayHide(): Promise<void>
  overlayOpenManager(): Promise<void>
  toggleOverlay(): Promise<void>
  checkEnvironment(gameId?: GameId): Promise<EnvironmentCheck[]>
  openEnvironmentFolder(gameId: GameId): Promise<ToggleResult>
  clearShaderCache(gameId: GameId): Promise<ClearShaderCacheResult>
  setCacheShaders(gameId: GameId, enabled: boolean): Promise<ToggleResult>
  setExcludeDisabledRule(gameId: GameId, enabled: boolean): Promise<ToggleResult>
  getInstallMode(): Promise<InstallModeInfo>
  checkAppUpdate(mirrorMode?: string, customMirror?: string): Promise<UpdateCheckResult>
  installAppUpdate(assetUrl: string, assetName: string, expectedSize?: number): Promise<UpdateInstallResult>
  auditGameConflicts(gameId: GameId): Promise<GameConflictAuditReport>
  exportConflictAuditReport(gameId: GameId, report: GameConflictAuditReport): Promise<ExportPresetResult>
  getStorageOverview(): Promise<StorageOverview>
  cleanLegacyElectronData(): Promise<LegacyCleanupResult>
  restoreModBackup(backupId: string): Promise<ToggleResult>
  deleteModBackup(backupId: string): Promise<ToggleResult>
  pruneModBackups(olderThanDays: number): Promise<{ ok: boolean; deletedCount?: number; freedBytes?: number; error?: string }>
  exportConfigBundle(): Promise<ExportPresetResult>
  inspectConfigBundle(): Promise<ConfigBundleInspection>
  importConfigBundle(filePath: string, options: ImportConfigBundleOptions): Promise<ImportConfigBundleResult>
  reloadF10(): Promise<ToggleResult>
  setReloadHotkey(hotkey: string): Promise<{ ok: boolean; hotkey?: string; error?: string }>
  getPendingPresetCount(gameId?: GameId): Promise<number>
  getRosterStatus(): Promise<RosterSyncStatus>
  syncRemoteRoster(customUrl?: string): Promise<RosterSyncResult>
  onStateChanged(listener: (event: StateChangedEvent) => void): () => void
}

export type { Settings }
