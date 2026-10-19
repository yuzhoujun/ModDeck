export type GameId =
  | 'wuthering-waves'
  | 'honkai-star-rail'
  | 'zzz'
  | 'endfield'
  | 'neverness-to-everness'

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
}

export interface UiSettings {
  language: 'zh-CN' | 'en'
  sortCharacters: 'custom' | 'name' | 'count'
  sortMods: 'name' | 'recent' | 'enabled'
  showHidden: boolean
}

export interface ImportSettings {
  deleteArchiveAfter: boolean
  overwriteExisting: boolean
}

export interface Settings {
  schemaVersion: 1
  activeGameId: GameId
  games: Record<string, GameSettings>
  ui: UiSettings
  import: ImportSettings
}

export interface CharacterMeta {
  displayName?: string
  aliases?: string[]
  canonicalEnName?: string
  coverFile?: string
  order?: number
  hidden?: boolean
  note?: string
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

export interface GameSnapshot {
  game: GameDef
  settings: GameSettings
  characters: CharacterInfo[]
  totalMods: number
  enabledMods: number
  modsPathExists: boolean
}

export interface Bootstrap {
  settings: Settings
  games: GameDef[]
  snapshot: GameSnapshot | null
  appVersion: string
}

export interface ImportRequest {
  gameId: GameId
  archivePaths?: string[]
  folderPaths?: string[]
  targetCharacter?: string
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
