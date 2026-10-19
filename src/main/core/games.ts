import type { GameDef, GameId } from '../../shared/types'

export const GAMES: GameDef[] = [
  {
    id: 'wuthering-waves',
    name: '鸣潮',
    shortName: '鸣潮',
    loader: 'WWMI',
    exeHint: 'Wuthering Waves.exe',
    accent: '#5eead4'
  },
  {
    id: 'honkai-star-rail',
    name: '崩坏：星穹铁道',
    shortName: '星穹铁道',
    loader: 'SRMI',
    exeHint: 'StarRail.exe',
    accent: '#a78bfa'
  },
  {
    id: 'zzz',
    name: '绝区零',
    shortName: '绝区零',
    loader: 'ZZMI',
    exeHint: 'ZenlessZoneZero.exe',
    accent: '#facc15'
  },
  {
    id: 'endfield',
    name: '明日方舟：终末地',
    shortName: '终末地',
    loader: 'EFMI',
    exeHint: 'Endfield.exe',
    accent: '#fb923c'
  },
  {
    id: 'neverness-to-everness',
    name: '异环',
    shortName: '异环',
    loader: 'NEMI',
    exeHint: 'NTELauncher.exe',
    accent: '#38bdf8'
  }
]

const GAME_MAP = new Map<string, GameDef>(GAMES.map((game) => [game.id, game]))

export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && GAME_MAP.has(value)
}

export function getGame(id: string): GameDef | null {
  return GAME_MAP.get(id) ?? null
}

export function requireGame(id: string): GameDef {
  const game = getGame(id)
  if (!game) throw new Error(`未知游戏: ${id}`)
  return game
}
