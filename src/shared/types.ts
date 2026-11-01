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
  nameEn?: string
  shortName: string
  shortNameEn?: string
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
  language: 'auto' | 'zh-CN' | 'en-US' | 'en' | (string & {})
  sortCharacters: 'custom' | 'name' | 'count'
  sortMods: 'name' | 'recent' | 'enabled' | 'custom'
  showHidden: boolean
  characterFilter: 'all' | 'withMods' | 'empty' | 'characters' | 'utility'
  overlayHotkey: string
  reloadHotkey: string
  overlayPinned: boolean
  modSelectMode: 'single' | 'multi'
  allowHotkeySend: boolean
  envCheckEnabled: boolean
  envCheckNeverPrompt: boolean
  autoReloadF10: boolean
  autoReloadModToggle: boolean
  autoReloadModPreset: boolean
  autoReloadRosterPreset: boolean
  postReloadSyncDelay?: number
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
  xxmiRoot?: string
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
  canonicalEnName?: string
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
  coverDataUrl?: string
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
  createdFoldersCount?: number
  error?: string
  status?: RosterSyncStatus
}

export interface Bootstrap {
  pendingPresetCount?: number
  settings: Settings
  games: GameDef[]
  snapshot: GameSnapshot | null
  appVersion: string
  rosterMap?: Record<GameId, string[]>
  customLocales?: Record<string, Record<string, any>>
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
  xxmiRoot?: string
  games?: Record<string, Partial<GameSettings>>
  ui?: Partial<UiSettings>
  import?: Partial<ImportSettings>
}

export interface AutoDetectPathsResult {
  ok: boolean
  xxmiRoot?: string
  detectedGames: GameId[]
  settings?: Settings
  error?: string
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

export interface ModVariantPreset {
  id: string
  name: string
  modName: string
  characterFolder: string
  activeIniFiles: string[]
  variables?: Record<string, string> // 3DMigoto/XXMI 变量快照（如 "$\endmin\clothcolor": "1"）
  isActive?: boolean
  isPending?: boolean
  updatedAt: number
}

export interface SaveModPresetInput {
  name: string
  activeIniFiles?: string[]
  variables?: Record<string, string>
}

export interface ModAssignmentItem {
  modName: string // 纯净名（不带 DISABLED_）
  presetId?: string // 绑定的单 Mod 变体预设 id（如 '__default__' 或 自定义预设 id）
}

export interface CharacterModAssignment {
  modName?: string // 兼容旧版单一 Mod 纯净名
  presetId?: string // 兼容旧版单一预设 id
  mods?: ModAssignmentItem[] // 新版支持多 Mod 配置列表（单选或多选）
}

export function getAssignmentModItems(
  assignment?: CharacterModAssignment | null
): ModAssignmentItem[] {
  if (!assignment) return []
  if (Array.isArray(assignment.mods) && assignment.mods.length > 0) {
    return assignment.mods.filter((m) => !!m.modName)
  }
  if (assignment.modName) {
    return [{ modName: assignment.modName, presetId: assignment.presetId }]
  }
  return []
}

export interface RosterPreset {
  id: string
  name: string
  gameId: GameId
  updatedAt: number
  assignments: Record<string, CharacterModAssignment> // key: characterFolder
}

export interface SaveRosterPresetInput {
  name: string
  assignments: Record<string, CharacterModAssignment>
}

/**
 * 单 Mod 预设导出/导入文件结构 (*.moddeck-preset.json)
 */
export interface ModPresetExportFile {
  moddeckFileType: 'mod-preset'
  version: 1
  gameId: GameId
  characterFolder: string
  modName: string
  exportedAt: number
  presets: Array<{
    name: string
    activeIniFiles: string[]
    variables: Record<string, string>
  }>
}

/**
 * 全角色池方案导出/导入文件结构 (*.moddeck-scheme.json)
 * 增强携带预设名称、变体变量与 ini 映射，确保跨设备导入时可自动匹配并恢复变体
 */
export interface RosterPresetExportFile {
  moddeckFileType: 'roster-scheme'
  version: 1
  gameId: GameId
  exportedAt: number
  scheme: {
    name: string
    gameId: GameId
    assignments: Record<
      string,
      {
        mods: Array<{
          modName: string
          presetId?: string
          presetName?: string
          presetVariables?: Record<string, string>
          presetActiveInis?: string[]
        }>
      }
    >
  }
}

/**
 * 方案导入检查与匹配预览报告
 */
export interface RosterSchemeImportInspection {
  ok: boolean
  error?: string
  schemeName?: string
  sourceGameId?: GameId
  targetGameId?: GameId
  totalCharacters: number
  matchedCharacters: number
  totalMods: number
  matchedMods: number
  missingCharacters: string[]
  missingMods: Array<{ characterFolder: string; modName: string }>
  matchedItems: Array<{ characterFolder: string; modName: string; presetName?: string }>
  rawExport?: RosterPresetExportFile
}

export interface ExportPresetResult {
  ok: boolean
  error?: string
  filePath?: string
  count?: number
}

export interface ImportPresetsResult {
  ok: boolean
  error?: string
  count?: number
  names?: string[]
}

export interface ImportRosterResult {
  ok: boolean
  error?: string
  schemeId?: string
  schemeName?: string
}

/**
 * 判断是否为非独立角色的功能/工具/UI/世界等系统级分类目录
 */
export function isUtilityCategory(char: { displayName?: string; folder?: string; kind?: string }): boolean {
  if (char.kind === 'utility') return true
  const testStr = `${char.displayName || ''} ${char.folder || ''}`
  return /(?:UI|界面|功能|工具|其他|其它|世界|大世界|NPC|武器|Weapon|Glider|Vehicle|Others?|Tools?|Function|OpenWorld)/i.test(testStr)
}
