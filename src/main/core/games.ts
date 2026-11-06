import type { GameDef, GameId } from '../../shared/types'

export const BUILTIN_GAMES: GameDef[] = [
  {
    id: 'wuthering-waves',
    name: '鸣潮',
    nameEn: 'Wuthering Waves',
    shortName: '鸣潮',
    shortNameEn: 'WuWa',
    loader: 'WWMI',
    exeHint: 'Wuthering Waves.exe',
    accent: '#5eead4'
  },
  {
    id: 'honkai-star-rail',
    name: '崩坏：星穹铁道',
    nameEn: 'Honkai: Star Rail',
    shortName: '星穹铁道',
    shortNameEn: 'Star Rail',
    loader: 'SRMI',
    exeHint: 'StarRail.exe',
    accent: '#a78bfa'
  },
  {
    id: 'zzz',
    name: '绝区零',
    nameEn: 'Zenless Zone Zero',
    shortName: '绝区零',
    shortNameEn: 'ZZZ',
    loader: 'ZZMI',
    exeHint: 'ZenlessZoneZero.exe',
    accent: '#facc15'
  },
  {
    id: 'endfield',
    name: '明日方舟：终末地',
    nameEn: 'Arknights: Endfield',
    shortName: '终末地',
    shortNameEn: 'Endfield',
    loader: 'EFMI',
    exeHint: 'Endfield.exe',
    accent: '#fb923c'
  },
  {
    id: 'neverness-to-everness',
    name: '异环',
    nameEn: 'Neverness to Everness',
    shortName: '异环',
    shortNameEn: 'NTE',
    loader: 'NEMI',
    exeHint: 'NTELauncher.exe',
    accent: '#38bdf8'
  }
]

let customGamesList: GameDef[] = []

export function setCustomGames(games: GameDef[]): void {
  customGamesList = Array.isArray(games) ? games : []
}

export function getCustomGames(): GameDef[] {
  return customGamesList
}

export function getAllGames(): GameDef[] {
  return [...BUILTIN_GAMES, ...customGamesList]
}

export const GAMES: GameDef[] = BUILTIN_GAMES

export function isBuiltinGame(id: string): boolean {
  return BUILTIN_GAMES.some((game) => game.id === id)
}

export function isGameId(value: unknown): value is GameId {
  if (typeof value !== 'string' || !value.trim()) return false
  return getAllGames().some((game) => game.id === value.trim())
}

export function getGame(id: string): GameDef | null {
  if (typeof id !== 'string' || !id.trim()) return null
  return getAllGames().find((game) => game.id === id.trim()) ?? null
}

export function requireGame(id: string): GameDef {
  const game = getGame(id)
  if (!game) throw new Error(`未知游戏: ${id}`)
  return game
}
