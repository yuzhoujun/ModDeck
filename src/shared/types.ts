export type GameId =
  | 'wuthering-waves'
  | 'honkai-star-rail'
  | 'zzz'
  | 'endfield'
  | 'neverness-to-everness'

export type CharacterKind = 'character' | 'utility'

export interface GameDef {
  id: GameId
  name: string
  shortName: string
  loader: string
  exeHint: string
  accent: string
}

export interface GameSettings {
  modsPath: string
  gamePath?: string
  loaderPath?: string
  launchArgs?: string
}

export interface UiSettings {
  language: 'zh-CN' | 'en'
  sortCharacters: 'custom' | 'name' | 'count'
  sortMods: 'name' | 'recent' | 'enabled' | 'custom'
  showHidden: boolean
  characterFilter: 'all' | 'withMods' | 'empty'
  overlayHotkey: string
  overlayPinned: boolean
  modSelectMode: 'single' | 'multi'
  allowHotkeySend: boolean
  envCheckEnabled: boolean
  envCheckNeverPrompt: boolean
  autoReloadF10: boolean
  recentModCount: number
  closeBehavior: 'quit' | 'minimize'
}

export interface RecentMod {
  gameId: GameId
  characterFolder: string
  modFolder: string
  name: string
  at: number
}

export type EnvironmentStatus = 'ok' | 'missing-line' | 'missing-file' | 'no-root'

export interface EnvironmentCheck {
  gameId: GameId
  modsPath: string
  root: string
  d3dxPath: string
  status: EnvironmentStatus
  detail?: string
}

export interface ImportSettings {
  mode?: 'copy' | 'move'
  deleteArchiveAfter: boolean
  overwriteExisting: boolean
  rosterRemoteUrl?: string
}

export interface Settings {
  schemaVersion: 1
  activeGameId: GameId
  games: Record<string, GameSettings>
  ui: UiSettings
  import: ImportSettings
  characterOrders: Record<string, string[]>
  modOrders: Record<string, string[]>
  recentMods: RecentMod[]
}

export interface CharacterMeta {
  displayName?: string
  aliases?: string[]
  canonicalEnName?: string
  coverFile?: string
  order?: number
  hidden?: boolean
  note?: string
  kind?: CharacterKind
}

export interface MetadataStore {
  schemaVersion: 1
  games: Record<string, Record<string, CharacterMeta>>
  /** 每个游戏第一次扫描的时间；用于区分“已有角色”和“后来新增的角色”。 */
  rosterInitialized?: Record<string, number>
}

export interface CharacterInfo {
  folder: string
  displayName: string
  aliases: string[]
  modCount: number
  enabledCount: number
  hiddenCount: number
  hasCover: boolean
  coverUrl: string | null
  known: boolean
  order: number
  kind: CharacterKind
}

export interface ModInfo {
  characterFolder: string
  folderName: string
  name: string
  enabled: boolean
  hasIni: boolean
  previewUrl: string | null
  updatedAt: number
  fileCount?: number
}

export interface ModHotkey {
  section: string
  key: string
}

export interface CreateCharacterInput {
  folder: string
  displayName?: string
  aliases?: string[]
  kind?: CharacterKind
}

export interface OverlayDetailRequest {
  gameId: GameId
  characterFolder: string
  modFolder: string
}

export interface ModDetails {
  characterFolder: string
  folderName: string
  name: string
  path: string
  enabled: boolean
  fileCount: number
  sizeBytes: number
  updatedAt: number
  iniFiles: string[]
  hotkeys: ModHotkey[]
  previewUrl: string | null
}

export interface GameSnapshot {
  game: GameDef
  settings: GameSettings
  characters: CharacterInfo[]
  totalMods: number
  enabledMods: number
  modsPathExists: boolean
}

export interface RosterSyncStatus {
  remoteUrl: string
  updatedAt?: string
  gameCounts: Record<GameId, number>
  hasRemoteCache: boolean
}

export interface RosterSyncResult {
  ok: boolean
  updatedAt?: string
  addedOrUpdated?: number
  error?: string
  status?: RosterSyncStatus
}

export interface Bootstrap {
  settings: Settings
  games: GameDef[]
  snapshot: GameSnapshot | null
  appVersion: string
  rosterMap?: Record<GameId, string[]>
}

export interface ImportRequest {
  gameId: GameId
  archivePaths?: string[]
  folderPaths?: string[]
  targetCharacter?: string
}

export interface ImportCandidate {
  id: string
  sourcePath: string
  sourceName: string
  modName: string
  extractedDir: string
  suggestedCharacter: string
  matchReason?: string
  hasIni: boolean
}

export interface ImportParseRequest {
  gameId: GameId
  paths: string[]
  targetCharacter?: string
}

export interface ImportParseResult {
  sessionId: string
  candidates: ImportCandidate[]
  errors: Array<{ source: string; message: string }>
}

export interface ImportCommitItem {
  id: string
  characterFolder: string
  modName?: string
}

export interface ImportCommitRequest {
  sessionId: string
  gameId: GameId
  items: ImportCommitItem[]
}

export interface ImportResultItem {
  source: string
  ok: boolean
  message?: string
  characters?: string[]
  mods?: string[]
}

export interface ImportResult {
  items: ImportResultItem[]
  importedMods: number
  createdCharacters: string[]
}

export interface SettingsPatch {
  activeGameId?: GameId
  games?: Record<string, Partial<GameSettings>>
  ui?: Partial<UiSettings>
  import?: Partial<ImportSettings>
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  userData: string
}

export interface ToggleResult {
  ok: boolean
  error?: string
}

export interface SimpleResult {
  ok: boolean
  error?: string
  path?: string
}
