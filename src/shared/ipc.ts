import type {
  AppInfo,
  ModVariantPreset,
  Bootstrap,
  CharacterMeta,
  CreateCharacterInput,
  EnvironmentCheck,
  GameId,
  GameSnapshot,
  ImportCommitRequest,
  ImportParseRequest,
  ImportParseResult,
  ImportRequest,
  ImportResult,
  ModDetails,
  ModInfo,
  OverlayDetailRequest,
  RosterSyncResult,
  RosterSyncStatus,
  Settings,
  SettingsPatch,
  SimpleResult,
  ToggleResult
} from './types'

export const IPC = {
  bootstrap: 'app:bootstrap',
  appInfo: 'app:info',
  saveSettings: 'settings:save',
  switchGame: 'game:switch',
  scanGame: 'game:scan',
  getMods: 'mods:list',
  toggleMod: 'mods:toggle',
  deleteMod: 'mods:delete',
  openModFolder: 'shell:open-mod-folder',
  openCharacterFolder: 'shell:open-character-folder',
  openPath: 'shell:open-path',
  pickModsFolder: 'dialog:mods-folder',
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
  reloadF10: 'env:reload-f10',
  rosterStatus: 'roster:status',
  rosterSync: 'roster:sync',
  stateChanged: 'app:state-changed'
} as const

export interface StateChangedEvent {
  gameId?: GameId
  characterFolder?: string
}

export interface ModDeckApi {
  bootstrap(): Promise<Bootstrap>
  appInfo(): Promise<AppInfo>
  saveSettings(patch: SettingsPatch): Promise<Settings>
  switchGame(gameId: GameId): Promise<GameSnapshot | null>
  scanGame(gameId: GameId): Promise<GameSnapshot | null>
  getMods(gameId: GameId, characterFolder: string): Promise<ModInfo[]>
  toggleMod(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    enable: boolean,
    exclusive?: boolean
  ): Promise<ToggleResult>
  deleteMod(gameId: GameId, characterFolder: string, modFolder: string): Promise<ToggleResult>
  openModFolder(gameId: GameId, characterFolder: string, modFolder: string): Promise<ToggleResult>
  openCharacterFolder(gameId: GameId, characterFolder: string): Promise<ToggleResult>
  openPath(kind: 'mods' | 'game' | 'loader' | 'data' | 'logs', gameId?: GameId): Promise<ToggleResult>
  pickModsFolder(): Promise<string | null>
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
  getModPresets(
    gameId: GameId,
    characterFolder: string,
    modFolder: string
  ): Promise<ModVariantPreset[]>
  saveModPreset(
    gameId: GameId,
    characterFolder: string,
    modFolder: string,
    presetName: string
  ): Promise<ToggleResult>
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
  reloadF10(): Promise<ToggleResult>
  getRosterStatus(): Promise<RosterSyncStatus>
  syncRemoteRoster(customUrl?: string): Promise<RosterSyncResult>
  onStateChanged(listener: (event: StateChangedEvent) => void): () => void
}

export type { Settings }
