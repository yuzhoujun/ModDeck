import path from 'node:path'
import type { GameId, GameSettings, Settings, SettingsPatch } from '../../shared/types'
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
      overlayHotkey: 'Alt+Shift+F'
    },
    import: {
      deleteArchiveAfter: false,
      overwriteExisting: false
    },
    characterOrders: {},
    modOrders: {}
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeGameSettings(raw: Partial<GameSettings> | undefined): GameSettings {
  return {
    modsPath: asString(raw?.modsPath),
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
          : 'Alt+Shift+F'
    },
    import: {
      deleteArchiveAfter: source.import?.deleteArchiveAfter === true,
      overwriteExisting: source.import?.overwriteExisting === true
    },
    characterOrders: normalizeOrders(source.characterOrders),
    modOrders: normalizeOrders(source.modOrders)
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
    modOrders: { ...current.modOrders }
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
