import type { GameDef, GameId } from '../../shared/types'

export const GAMES: GameDef[] = [
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
