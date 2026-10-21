import type {
  AppInfo,
  Bootstrap,
  CharacterMeta,
  CreateCharacterInput,
  GameId,
  GameSnapshot,
  ImportRequest,
  ImportResult,
  ModDetails,
  ModInfo,
  OverlayDetailRequest,
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
  pickCover: 'dialog:cover',
  importRun: 'import:run',
  updateCharacterMeta: 'character:update-meta',
  setCharacterCover: 'character:set-cover',
  resetCharacterMeta: 'character:reset-meta',
  createCharacter: 'character:create',
  saveCharacterCoverData: 'character:save-cover-data',
  clearCharacterCover: 'character:clear-cover',
  getModDetails: 'mods:details',
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
  overlayToggle: 'overlay:toggle'
} as const

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
  pickCover(): Promise<string | null>
  importRun(request: ImportRequest): Promise<ImportResult>
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
  getModDetails(
    gameId: GameId,
    characterFolder: string,
    modFolder: string
  ): Promise<ModDetails>
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
}

export type { Settings }
