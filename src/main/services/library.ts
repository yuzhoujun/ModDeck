import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CharacterInfo,
  GameDef,
  GameId,
  GameSettings,
  GameSnapshot,
  MetadataStore,
  ModInfo
} from '../../shared/types'
import { isDirectory, pathExists, readdirSafe } from '../core/fsx'
import { isInside, isSafeSegment } from '../core/safe-path'
import { getCharacterMeta } from './metadata'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])
const PREVIEW_PATTERN = /^(preview|cover|thumbnail|thumb|screen|screenshot|showcase)/i
const LEGACY_CONTAINERS = new Set(['character', 'characters'])

const iniCache = new Map<string, { stamp: number; value: boolean }>()
const previewCache = new Map<string, { stamp: number; value: string | null }>()
const statCache = new Map<string, { stamp: number; value: number }>()

async function dirStamp(dir: string): Promise<number> {
  try {
    const stat = await fs.stat(dir)
    return stat.mtimeMs
  } catch {
    return 0
  }
}

function ignoredCharacterName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_')
}

function ignoredModName(name: string): boolean {
  return name.startsWith('.')
}

/** 兼容旧布局：Mods/Characters/<角色> 或 Mods/<角色>。 */
export async function resolveCharacterBase(modsPath: string): Promise<string> {
  const entries = await readdirSafe(modsPath)
  const legacy = entries.find(
    (entry) => entry.isDirectory() && LEGACY_CONTAINERS.has(entry.name.toLowerCase())
  )
  if (legacy) {
    const legacyPath = path.join(modsPath, legacy.name)
    const children = await readdirSafe(legacyPath)
    if (children.some((child) => child.isDirectory())) return legacyPath
  }
  return modsPath
}

export async function listCharacterFolderNames(modsPath: string): Promise<string[]> {
  const base = await resolveCharacterBase(modsPath)
  const entries = await readdirSafe(base)
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !LEGACY_CONTAINERS.has(entry.name.toLowerCase()) &&
        !ignoredCharacterName(entry.name)
    )
    .map((entry) => entry.name)
}

export async function resolveCharacterDir(modsPath: string, characterFolder: string): Promise<string> {
  if (!isSafeSegment(characterFolder)) throw new Error(`角色目录名不合法: ${characterFolder}`)
  const base = await resolveCharacterBase(modsPath)
  const target = path.join(base, characterFolder)
  if (!isInside(base, target)) throw new Error('角色目录越界')
  if (!(await isDirectory(target))) throw new Error(`角色目录不存在: ${characterFolder}`)
  return target
}

async function hasIniWithin(dir: string, depth: number): Promise<boolean> {
  const stamp = await dirStamp(dir)
  const cached = iniCache.get(dir)
  if (cached && cached.stamp === stamp) return cached.value

  let found = false
  const walk = async (current: string, remaining: number): Promise<void> => {
    if (found) return
    const entries = await readdirSafe(current)
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.ini')) {
        found = true
        return
      }
      if (remaining > 0 && entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(path.join(current, entry.name), remaining - 1)
      }
    }
  }
  await walk(dir, depth)
  iniCache.set(dir, { stamp, value: found })
  return found
}

async function findPreview(dir: string): Promise<string | null> {
  const stamp = await dirStamp(dir)
  const cached = previewCache.get(dir)
  if (cached && cached.stamp === stamp) return cached.value

  const entries = await readdirSafe(dir)
  const images = entries
    .filter((entry) => entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)

  const preferred = images.find((name) => PREVIEW_PATTERN.test(name))
  const value = preferred
    ? path.join(dir, preferred)
    : images.length > 0
      ? path.join(dir, images[0])
      : null

  previewCache.set(dir, { stamp, value })
  return value
}

function sortCharacters(entries: CharacterInfo[], mode: 'custom' | 'name' | 'count'): CharacterInfo[] {
  return [...entries].sort((left, right) => {
    if (mode === 'count' && right.modCount !== left.modCount) return right.modCount - left.modCount
    if (mode === 'custom') {
      const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
    }
    return left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')
  })
}

export interface ScanOptions {
  coverUrlFor: (meta: ReturnType<typeof getCharacterMeta>) => string | null
  showHidden: boolean
  sortCharacters: 'custom' | 'name' | 'count'
}

export async function scanCharacters(
  modsPath: string,
  gameId: GameId,
  metadata: MetadataStore,
  options: ScanOptions
): Promise<CharacterInfo[]> {
  const base = await resolveCharacterBase(modsPath)
  const entries = await readdirSafe(base)
  const characters: CharacterInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (LEGACY_CONTAINERS.has(entry.name.toLowerCase())) continue
    if (ignoredCharacterName(entry.name)) continue

    const meta = getCharacterMeta(metadata, gameId, entry.name)
    if (meta.hidden && !options.showHidden) continue

    const characterPath = path.join(base, entry.name)
    const children = await readdirSafe(characterPath)
    let modCount = 0
    let enabledCount = 0
    for (const child of children) {
      if (!child.isDirectory() || ignoredModName(child.name)) continue
      modCount += 1
      if (!/^DISABLED_/i.test(child.name)) enabledCount += 1
    }

    const displayName = meta.displayName || entry.name
    const cover = options.coverUrlFor(meta)

    characters.push({
      folder: entry.name,
      displayName,
      aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
      modCount,
      enabledCount,
      hiddenCount: modCount - enabledCount,
      hasCover: Boolean(cover),
      coverUrl: cover,
      known: Boolean(meta.displayName || meta.canonicalEnName || meta.aliases?.length),
      order: typeof meta.order === 'number' ? meta.order : Number.MAX_SAFE_INTEGER
    })
  }

  return sortCharacters(characters, options.sortCharacters)
}

export async function listMods(
  modsPath: string,
  gameId: GameId,
  characterFolder: string,
  assetUrl: (absolutePath: string) => string,
  sortMode: 'name' | 'recent' | 'enabled'
): Promise<ModInfo[]> {
  const characterPath = await resolveCharacterDir(modsPath, characterFolder)
  const entries = await readdirSafe(characterPath)
  const mods: ModInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredModName(entry.name)) continue
    const enabled = !/^DISABLED_/i.test(entry.name)
    const name = entry.name.replace(/^DISABLED_/i, '')
    const modPath = path.join(characterPath, entry.name)
    const ini = await hasIniWithin(modPath, 2)
    const preview = await findPreview(modPath)
    let updatedAt = 0
    try {
      updatedAt = (await fs.stat(modPath)).mtimeMs
    } catch {
      // ignore
    }

    mods.push({
      characterFolder,
      folderName: entry.name,
      name,
      enabled,
      hasIni: ini,
      previewUrl: preview ? assetUrl(preview) : null,
      updatedAt,
      fileCount: undefined
    })
  }

  if (sortMode === 'recent') {
    mods.sort((left, right) => right.updatedAt - left.updatedAt)
  } else if (sortMode === 'enabled') {
    mods.sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-Hans-CN')
    })
  } else {
    mods.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
  }

  return mods
}

export async function buildSnapshot(
  game: GameDef,
  gameSettings: GameSettings,
  metadata: MetadataStore,
  options: ScanOptions
): Promise<GameSnapshot> {
  const modsPath = gameSettings.modsPath
  const exists = Boolean(modsPath) && (await pathExists(modsPath))
  if (!exists) {
    return {
      game,
      settings: gameSettings,
      characters: [],
      totalMods: 0,
      enabledMods: 0,
      modsPathExists: false
    }
  }

  const characters = await scanCharacters(modsPath, game.id, metadata, options)
  return {
    game,
    settings: gameSettings,
    characters,
    totalMods: characters.reduce((sum, entry) => sum + entry.modCount, 0),
    enabledMods: characters.reduce((sum, entry) => sum + entry.enabledCount, 0),
    modsPathExists: true
  }
}

export function isValidCharacterFolder(modsPath: string, characterFolder: string): boolean {
  if (!isSafeSegment(characterFolder)) return false
  return isInside(modsPath, path.join(modsPath, characterFolder))
}

export { statCache }
