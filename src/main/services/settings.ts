import fsSync from 'node:fs'
import path from 'node:path'
import type {
  GameId,
  GameSettings,
  RecentMod,
  Settings,
  SettingsPatch
} from '../../shared/types'
import { GAMES, isGameId } from '../core/games'
import { readJsonSafe, writeJsonAtomic } from '../core/fsx'

export const SETTINGS_FILE = 'settings.json'

export function defaultSettings(): Settings {
  const games: Record<string, GameSettings> = {}
  for (const game of GAMES) games[game.id] = { modsPath: '' }
  return {
    schemaVersion: 1,
    activeGameId: GAMES[0].id,
    games,
    ui: {
      language: 'zh-CN',
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
  const games: Record<string, GameSettings> = {}
  for (const game of GAMES) {
    games[game.id] = normalizeGameSettings(source.games?.[game.id])
  }
  const activeGameId: GameId = isGameId(source.activeGameId)
    ? source.activeGameId
    : defaults.activeGameId
  const recentModCount =
    typeof source.ui?.recentModCount === 'number' && Number.isFinite(source.ui.recentModCount)
      ? Math.max(0, Math.min(15, Math.floor(source.ui.recentModCount)))
      : 8

  return {
    schemaVersion: 1,
    activeGameId,
    games,
    ui: {
      language: source.ui?.language === 'en' ? 'en' : 'zh-CN',
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
        source.ui?.characterFilter === 'withMods' || source.ui?.characterFilter === 'empty'
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
    ui: { ...current.ui },
    import: { ...current.import },
    characterOrders: { ...current.characterOrders },
    modOrders: { ...current.modOrders },
    recentMods: [...current.recentMods]
  }

  if (isGameId(patch.activeGameId)) next.activeGameId = patch.activeGameId

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
      language: patch.ui.language === 'en' ? 'en' : next.ui.language,
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
