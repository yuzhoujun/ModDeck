import fsSync from 'node:fs'
import path from 'node:path'
import type {
  GameDef,
  GameId,
  GameSettings,
  RecentMod,
  Settings,
  SettingsPatch
} from '../../shared/types'
import { BUILTIN_GAMES, getAllGames, isGameId, setCustomGames } from '../core/games'
import { readJsonSafe, writeJsonAtomic } from '../core/fsx'

export const SETTINGS_FILE = 'settings.json'

export function defaultSettings(): Settings {
  const games: Record<string, GameSettings> = {}
  for (const game of BUILTIN_GAMES) games[game.id] = { modsPath: '' }
  return {
    schemaVersion: 1,
    activeGameId: BUILTIN_GAMES[0].id,
    xxmiRoot: '',
    games,
    customGames: [],
    hiddenGameIds: [],
    onlyShowConfiguredGames: false,
    ui: {
      language: 'auto',
      sortCharacters: 'custom',
      sortMods: 'name',
      showHidden: false,
      characterFilter: 'all',
      overlayHotkey: 'Alt+Shift+M',
      reloadHotkey: 'F10',
      overlayPinned: true,
      modSelectMode: 'multi',
      allowHotkeySend: true,
      envCheckEnabled: true,
      envCheckNeverPrompt: false,
      autoReloadF10: false,
      autoReloadModToggle: false,
      autoReloadModPreset: true,
      autoReloadRosterPreset: true,
      postReloadSyncDelay: 6,
      recentModCount: 8,
      closeBehavior: 'quit'
    },
    import: {
      mode: 'copy',
      deleteArchiveAfter: false,
      overwriteExisting: false,
      rosterRemoteUrl: 'https://raw.githubusercontent.com/yuzhoujun/ModDeck/main/roster.json'
    },
    characterOrders: {},
    modOrders: {},
    recentMods: []
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function inferXxmiRootFromPath(candidatePath: string): string {
  let current = candidatePath.trim().replace(/[\\/]+$/, '')
  if (!current) return ''
  try {
    if (fsSync.existsSync(current) && fsSync.statSync(current).isFile()) {
      current = path.dirname(current)
    }
  } catch {
    // ignore
  }
  for (let i = 0; i < 5 && current; i++) {
    try {
      if (
        fsSync.existsSync(path.join(current, 'XXMI Launcher Config.json')) ||
        fsSync.existsSync(path.join(current, 'Resources', 'Bin', 'XXMI Launcher.exe'))
      ) {
        return current
      }
    } catch {
      // ignore
    }
    const parent = path.dirname(current)
    if (!parent || parent === current) break
    current = parent
  }
  return ''
}

/** 允许用户选择 EFMI 根目录；内部统一落到它的 Mods 子目录。 */
export function normalizeModsPath(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  if (path.basename(trimmed).toLowerCase() === 'mods') return trimmed

  const modsPath = path.join(trimmed, 'Mods')
  try {
    if (fsSync.statSync(modsPath).isDirectory()) return modsPath
  } catch {
    // ignore
  }
  if (fsSync.existsSync(path.join(trimmed, 'd3dx.ini'))) return modsPath
  return trimmed
}

function normalizeGameSettings(raw: Partial<GameSettings> | undefined): GameSettings {
  return {
    modsPath: normalizeModsPath(asString(raw?.modsPath)),
    gamePath: asString(raw?.gamePath),
    loaderPath: asString(raw?.loaderPath),
    launchArgs: asString(raw?.launchArgs)

  }
}

function normalizeOrders(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {}
  const orders: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const list = value.map((item) => String(item || '').trim()).filter(Boolean)
    if (list.length > 0) orders[key] = list
  }
  return orders
}

function normalizeRecentMods(raw: unknown, limit: number): RecentMod[] {
  if (!Array.isArray(raw) || limit <= 0) return []
  const result: RecentMod[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Partial<RecentMod>
    if (!isGameId(entry.gameId)) continue
    if (typeof entry.characterFolder !== 'string' || !entry.characterFolder) continue
    if (typeof entry.modFolder !== 'string' || !entry.modFolder) continue
    if (typeof entry.name !== 'string' || !entry.name) continue
    result.push({
      gameId: entry.gameId,
      characterFolder: entry.characterFolder,
      modFolder: entry.modFolder,
      name: entry.name,
      at: typeof entry.at === 'number' ? entry.at : 0
    })
  }
  return result.slice(0, Math.min(15, limit))
}

export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const defaults = defaultSettings()
  const source = raw ?? {}

  const customGames = Array.isArray(source.customGames)
    ? source.customGames
        .filter(
          (g): g is GameDef =>
            Boolean(
              g &&
                typeof g.id === 'string' &&
                g.id.trim() &&
                typeof g.name === 'string' &&
                g.name.trim()
            )
        )
        .map((g) => ({
          ...g,
          id: g.id.trim().toLowerCase(),
          name: g.name.trim(),
          shortName: (g.shortName || g.name).trim(),
          loader: (g.loader || '3DMigoto').trim(),
          accent: (g.accent || '#10b981').trim(),
          isCustom: true
        }))
    : []

  setCustomGames(customGames)

  const allGames = getAllGames()
  const games: Record<string, GameSettings> = {}
  for (const game of allGames) {
    games[game.id] = normalizeGameSettings(source.games?.[game.id])
  }

  const hiddenGameIds = Array.isArray(source.hiddenGameIds)
    ? source.hiddenGameIds.filter(
        (id): id is string => typeof id === 'string' && Boolean(id.trim())
      )
    : []

  const onlyShowConfiguredGames = source.onlyShowConfiguredGames === true

  const activeGameId: GameId = isGameId(source.activeGameId)
    ? source.activeGameId
    : defaults.activeGameId
  const recentModCount =
    typeof source.ui?.recentModCount === 'number' && Number.isFinite(source.ui.recentModCount)
      ? Math.max(0, Math.min(15, Math.floor(source.ui.recentModCount)))
      : 8

  let xxmiRoot = asString(source.xxmiRoot).trim().replace(/[\\/]+$/, '')
  if (xxmiRoot) {
    xxmiRoot = inferXxmiRootFromPath(xxmiRoot) || xxmiRoot
  } else {
    for (const g of Object.values(games)) {
      const inferred =
        (g.loaderPath ? inferXxmiRootFromPath(g.loaderPath) : '') ||
        (g.modsPath ? inferXxmiRootFromPath(g.modsPath) : '')
      if (inferred) {
        xxmiRoot = inferred
        break
      }
    }
  }

  return {
    schemaVersion: 1,
    activeGameId,
    xxmiRoot,
    games,
    customGames,
    hiddenGameIds,
    onlyShowConfiguredGames,
    ui: {
      language: source.ui?.language || 'auto',
      sortCharacters:
        source.ui?.sortCharacters === 'name' || source.ui?.sortCharacters === 'count'
          ? source.ui.sortCharacters
          : 'custom',
      sortMods:
        source.ui?.sortMods === 'recent' ||
        source.ui?.sortMods === 'enabled' ||
        source.ui?.sortMods === 'custom'
          ? source.ui.sortMods
          : 'name',
      showHidden: source.ui?.showHidden === true,
      characterFilter:
        source.ui?.characterFilter === 'withMods' ||
        source.ui?.characterFilter === 'empty' ||
        source.ui?.characterFilter === 'characters' ||
        source.ui?.characterFilter === 'utility'
          ? source.ui.characterFilter
          : 'all',
      overlayHotkey:
        typeof source.ui?.overlayHotkey === 'string'
          ? source.ui.overlayHotkey.trim()
          : 'Alt+Shift+M',
      reloadHotkey:
        typeof source.ui?.reloadHotkey === 'string' && source.ui.reloadHotkey.trim()
          ? source.ui.reloadHotkey.trim()
          : 'F10',
      overlayPinned: source.ui?.overlayPinned !== false,
      modSelectMode: source.ui?.modSelectMode === 'single' ? 'single' : 'multi',
      allowHotkeySend: source.ui?.allowHotkeySend !== false,
      envCheckEnabled: source.ui?.envCheckEnabled !== false,
      envCheckNeverPrompt: source.ui?.envCheckNeverPrompt === true,
      autoReloadF10: source.ui?.autoReloadF10 === true,
      autoReloadModToggle: source.ui?.autoReloadModToggle === true,
      autoReloadModPreset: source.ui?.autoReloadModPreset !== false,
      autoReloadRosterPreset: source.ui?.autoReloadRosterPreset !== false,
      postReloadSyncDelay:
        typeof source.ui?.postReloadSyncDelay === 'number' && source.ui.postReloadSyncDelay > 0
          ? source.ui.postReloadSyncDelay
          : 6,
      recentModCount,
      closeBehavior: source.ui?.closeBehavior === 'minimize' ? 'minimize' : 'quit'
    },
    import: {
      mode: source.import?.mode === 'move' ? 'move' : 'copy',
      deleteArchiveAfter: source.import?.deleteArchiveAfter === true,
      overwriteExisting: source.import?.overwriteExisting === true,
      rosterRemoteUrl:
        typeof source.import?.rosterRemoteUrl === 'string' &&
        source.import.rosterRemoteUrl.trim() &&
        source.import.rosterRemoteUrl.trim() !==
          'https://raw.githubusercontent.com/moddeck/ModDeck/main/roster.json'
          ? source.import.rosterRemoteUrl.trim()
          : defaults.import.rosterRemoteUrl
    },
    characterOrders: normalizeOrders(source.characterOrders),
    modOrders: normalizeOrders(source.modOrders),
    recentMods: normalizeRecentMods(source.recentMods, recentModCount)
  }
}

export async function loadSettings(baseDir: string): Promise<Settings> {
  const raw = await readJsonSafe<Partial<Settings> | null>(
    path.join(baseDir, SETTINGS_FILE),
    null
  )
  return normalizeSettings(raw)
}

export async function saveSettings(baseDir: string, settings: Settings): Promise<void> {
  await writeJsonAtomic(path.join(baseDir, SETTINGS_FILE), settings)
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = {
    ...current,
    games: { ...current.games },
    customGames: current.customGames ? [...current.customGames] : [],
    hiddenGameIds: current.hiddenGameIds ? [...current.hiddenGameIds] : [],
    onlyShowConfiguredGames: current.onlyShowConfiguredGames ?? false,
    ui: { ...current.ui },
    import: { ...current.import },
    characterOrders: { ...current.characterOrders },
    modOrders: { ...current.modOrders },
    recentMods: [...current.recentMods]
  }

  if (Array.isArray(patch.customGames)) {
    next.customGames = patch.customGames
  }
  if (Array.isArray(patch.hiddenGameIds)) {
    next.hiddenGameIds = patch.hiddenGameIds
  }
  if (typeof patch.onlyShowConfiguredGames === 'boolean') {
    next.onlyShowConfiguredGames = patch.onlyShowConfiguredGames
  }

  if (isGameId(patch.activeGameId)) next.activeGameId = patch.activeGameId
  if (typeof patch.xxmiRoot === 'string') next.xxmiRoot = patch.xxmiRoot.trim()

  if (patch.games) {
    for (const [gameId, value] of Object.entries(patch.games)) {
      if (!isGameId(gameId) || !value) continue
      next.games[gameId] = {
        ...next.games[gameId],
        ...normalizeGameSettings({ ...next.games[gameId], ...value })
      }
    }
  }

  if (patch.ui) {
    next.ui = {
      ...next.ui,
      ...patch.ui,
      language: patch.ui.language !== undefined ? patch.ui.language : next.ui.language,
      showHidden:
        typeof patch.ui.showHidden === 'boolean' ? patch.ui.showHidden : next.ui.showHidden
    }
  }

  if (patch.import) {
    next.import = {
      ...next.import,
      ...patch.import
    }
  }

  return normalizeSettings(next)
}
