import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CharacterMeta, GameId, MetadataStore } from '../../shared/types'
import { ensureDir, readJsonSafe, readdirSafe, writeJsonAtomic } from '../core/fsx'

export const METADATA_FILE = 'characters.json'
export const COVERS_DIR = 'covers'

const ALLOWED_COVER_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])

export function emptyMetadata(): MetadataStore {
  return { schemaVersion: 1, games: {}, rosterInitialized: {} }
}

export async function loadMetadata(baseDir: string): Promise<MetadataStore> {
  const raw = await readJsonSafe<MetadataStore | null>(path.join(baseDir, METADATA_FILE), null)
  if (!raw || typeof raw !== 'object' || typeof raw.games !== 'object' || !raw.games) {
    return emptyMetadata()
  }
  const games: MetadataStore['games'] = {}
  for (const [gameId, characters] of Object.entries(raw.games)) {
    if (!characters || typeof characters !== 'object') continue
    games[gameId] = characters
  }
  const rosterInitialized: Record<string, number> = {}
  if (raw.rosterInitialized && typeof raw.rosterInitialized === 'object') {
    for (const [gameId, timestamp] of Object.entries(raw.rosterInitialized)) {
      if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
        rosterInitialized[gameId] = timestamp
      }
    }
  }
  return { schemaVersion: 1, games, rosterInitialized }
}

/**
 * 第一次扫描某个游戏时，把当前所有角色登记为“已有角色”。
 * 之后再出现的目录没有元数据，就会被标记为新角色。
 */
export function markRosterInitialized(
  store: MetadataStore,
  gameId: GameId,
  folders: string[]
): MetadataStore {
  if (store.rosterInitialized?.[gameId]) return store
  const games = { ...store.games }
  const characters = { ...(games[gameId] ?? {}) }
  for (const folder of folders) {
    if (!characters[folder]) characters[folder] = { displayName: folder }
  }
  games[gameId] = characters
  return {
    ...store,
    games,
    rosterInitialized: { ...(store.rosterInitialized ?? {}), [gameId]: Date.now() }
  }
}

export async function saveMetadata(baseDir: string, store: MetadataStore): Promise<void> {
  await writeJsonAtomic(path.join(baseDir, METADATA_FILE), store)
}

export function getCharacterMeta(
  store: MetadataStore,
  gameId: GameId,
  folder: string
): CharacterMeta {
  return store.games[gameId]?.[folder] ?? {}
}

export function setCharacterMeta(
  store: MetadataStore,
  gameId: GameId,
  folder: string,
  meta: CharacterMeta
): MetadataStore {
  const games = { ...store.games }
  const characters = { ...(games[gameId] ?? {}) }
  const clean: CharacterMeta = {}
  if (typeof meta.displayName === 'string' && meta.displayName.trim()) {
    clean.displayName = meta.displayName.trim()
  }
  if (Array.isArray(meta.aliases)) {
    const aliases = Array.from(
      new Set(meta.aliases.map((item) => String(item || '').trim()).filter(Boolean))
    )
    if (aliases.length > 0) clean.aliases = aliases
  }
  if (typeof meta.canonicalEnName === 'string' && meta.canonicalEnName.trim()) {
    clean.canonicalEnName = meta.canonicalEnName.trim()
  }
  if (typeof meta.coverFile === 'string' && meta.coverFile) clean.coverFile = meta.coverFile
  if (typeof meta.order === 'number' && Number.isFinite(meta.order)) clean.order = meta.order
  if (meta.hidden === true) clean.hidden = true
  if (typeof meta.note === 'string' && meta.note.trim()) clean.note = meta.note.trim()

  if (Object.keys(clean).length === 0) {
    delete characters[folder]
  } else {
    characters[folder] = clean
  }
  if (Object.keys(characters).length === 0) {
    delete games[gameId]
  } else {
    games[gameId] = characters
  }
  return { ...store, games }
}

export function removeCharacterMeta(
  store: MetadataStore,
  gameId: GameId,
  folder: string
): MetadataStore {
  return setCharacterMeta(store, gameId, folder, {})
}

export function coverPath(baseDir: string, meta: CharacterMeta): string | null {
  if (!meta.coverFile) return null
  const abs = path.join(baseDir, COVERS_DIR, meta.coverFile)
  return abs
}

export function coverUrlFor(baseDir: string, meta: CharacterMeta): string | null {
  const abs = coverPath(baseDir, meta)
  return abs ?? null
}

export async function saveCover(
  baseDir: string,
  gameId: GameId,
  folder: string,
  sourcePath: string
): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase()
  if (!ALLOWED_COVER_EXT.has(ext)) {
    throw new Error('封面只支持 png / jpg / webp / gif / avif')
  }
  const stat = await fs.stat(sourcePath)
  if (!stat.isFile()) throw new Error('封面不是文件')
  if (stat.size > 12 * 1024 * 1024) throw new Error('封面图片过大（>12MB）')

  const hash = createHash('sha1').update(folder).digest('hex').slice(0, 16)
  const dir = path.join(baseDir, COVERS_DIR, gameId)
  await ensureDir(dir)

  for (const entry of await readdirSafe(dir)) {
    if (entry.isFile() && entry.name.startsWith(`${hash}.`)) {
      await fs.rm(path.join(dir, entry.name), { force: true })
    }
  }

  const fileName = `${hash}${ext}`
  await fs.copyFile(sourcePath, path.join(dir, fileName))
  return `${gameId}/${fileName}`
}
