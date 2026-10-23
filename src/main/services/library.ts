import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CharacterInfo,
  GameDef,
  GameId,
  GameSettings,
  GameSnapshot,
  MetadataStore,
  ModDetails,
  ModHotkey,
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

async function inspectModIniStatus(
  dir: string,
  depth: number
): Promise<{ hasIni: boolean; hasActiveIni: boolean; hasDisabledIni: boolean }> {
  let hasIni = false
  let hasActiveIni = false
  let hasDisabledIni = false
  const walk = async (current: string, remaining: number): Promise<void> => {
    const entries = await readdirSafe(current)
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.ini')) {
        if (entry.name.toLowerCase() === 'desktop.ini') continue
        hasIni = true
        if (/^disabled_/i.test(entry.name)) hasDisabledIni = true
        else hasActiveIni = true
      } else if (remaining > 0 && entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(path.join(current, entry.name), remaining - 1)
      }
    }
  }
  await walk(dir, depth)
  return { hasIni, hasActiveIni, hasDisabledIni }
}

async function isModFolderEffectivelyEnabled(folderName: string, modPath: string): Promise<boolean> {
  if (/^DISABLED_/i.test(folderName)) return false
  const status = await inspectModIniStatus(modPath, 2)
  if (status.hasDisabledIni && !status.hasActiveIni) return false
  return true
}

async function hasIniWithin(dir: string, depth: number): Promise<boolean> {
  const stamp = await dirStamp(dir)
  const cached = iniCache.get(dir)
  if (cached && cached.stamp === stamp) return cached.value

  const status = await inspectModIniStatus(dir, depth)
  iniCache.set(dir, { stamp, value: status.hasIni })
  return status.hasIni
}

const CHARACTER_COVER_NAMES = [
  '.preview.png',
  '.preview.jpg',
  '.preview.jpeg',
  '.preview.webp',
  '_cover.png',
  '_cover.jpg',
  '_cover.jpeg',
  '_cover.webp'
]

const MOD_CUSTOM_PREVIEW_NAMES = [
  '.preview.png',
  '.preview.jpg',
  '.preview.jpeg',
  '.preview.webp',
  '.preview.gif',
  '.preview.avif'
]

const IGNORED_PREVIEW_SUBDIRS = new Set([
  'res',
  'textures',
  'texture',
  'tex',
  'hlsl',
  'meshes',
  'mesh',
  'buffer',
  'buffers',
  'tattoos',
  'shaderfixes',
  'shaders'
])

export function invalidatePreviewCache(dir?: string): void {
  if (dir) previewCache.delete(dir)
  else previewCache.clear()
}

async function findCharacterCoverFile(dir: string): Promise<string | null> {
  const entries = await readdirSafe(dir)
  const files = new Map(
    entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLowerCase(), entry.name])
  )
  for (const name of CHARACTER_COVER_NAMES) {
    const actual = files.get(name)
    if (actual) return path.join(dir, actual)
  }
  return null
}

async function findPreview(dir: string): Promise<string | null> {
  const stamp = await dirStamp(dir)
  const cached = previewCache.get(dir)
  if (cached && cached.stamp === stamp) return cached.value

  const entries = await readdirSafe(dir)
  const fileMap = new Map(
    entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLowerCase(), entry.name])
  )

  // 1. 最高优先级：用户通过管理器主动设置的专属预览图 (.preview.*)
  for (const customName of MOD_CUSTOM_PREVIEW_NAMES) {
    const actual = fileMap.get(customName)
    if (actual) {
      const value = path.join(dir, actual)
      previewCache.set(dir, { stamp, value })
      return value
    }
  }

  // 2. 次优先级：Mod 根目录下的 preview/cover/thumb 等标准预览图或普通图片
  const images = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith('.') &&
        IMAGE_EXT.has(path.extname(entry.name).toLowerCase())
    )
    .map((entry) => entry.name)

  const preferred = images.find((name) => PREVIEW_PATTERN.test(name))
  if (preferred) {
    const value = path.join(dir, preferred)
    previewCache.set(dir, { stamp, value })
    return value
  }
  if (images.length > 0) {
    const value = path.join(dir, images[0])
    previewCache.set(dir, { stamp, value })
    return value
  }

  // 3. 兜底：扫描一层非贴图子目录中的 preview/cover 等命名的预览图
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (IGNORED_PREVIEW_SUBDIRS.has(entry.name.toLowerCase())) continue
    const subDir = path.join(dir, entry.name)
    const subEntries = await readdirSafe(subDir)
    const subImages = subEntries
      .filter(
        (sub) =>
          sub.isFile() &&
          !sub.name.startsWith('.') &&
          IMAGE_EXT.has(path.extname(sub.name).toLowerCase())
      )
      .map((sub) => sub.name)
    const subPreferred = subImages.find((name) => PREVIEW_PATTERN.test(name))
    if (subPreferred) {
      const value = path.join(subDir, subPreferred)
      previewCache.set(dir, { stamp, value })
      return value
    }
  }

  previewCache.set(dir, { stamp, value: null })
  return null
}

function sortCharacters(
  entries: CharacterInfo[],
  mode: 'custom' | 'name' | 'count',
  customOrder: string[] = []
): CharacterInfo[] {
  const orderIndex = new Map(customOrder.map((folder, index) => [folder, index]))
  return [...entries].sort((left, right) => {
    if (mode === 'count' && right.modCount !== left.modCount) return right.modCount - left.modCount
    if (mode === 'custom') {
      const leftCustom = orderIndex.get(left.folder)
      const rightCustom = orderIndex.get(right.folder)
      if (leftCustom !== undefined && rightCustom !== undefined && leftCustom !== rightCustom) {
        return leftCustom - rightCustom
      }
      if (leftCustom !== undefined && rightCustom === undefined) return -1
      if (leftCustom === undefined && rightCustom !== undefined) return 1
      const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
    }
    return left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')
  })
}

export interface ScanOptions {
  coverUrlFor: (meta: ReturnType<typeof getCharacterMeta>) => string | null
  assetUrl: (absolutePath: string) => string
  showHidden: boolean
  sortCharacters: 'custom' | 'name' | 'count'
  characterOrder?: string[]
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
      const childModPath = path.join(characterPath, child.name)
      if (await isModFolderEffectivelyEnabled(child.name, childModPath)) enabledCount += 1
    }

    const displayName = meta.displayName || entry.name
    let cover = options.coverUrlFor(meta)
    if (!cover) {
      const coverFile = await findCharacterCoverFile(characterPath)
      if (coverFile) cover = options.assetUrl(coverFile)
    }

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
      order: typeof meta.order === 'number' ? meta.order : Number.MAX_SAFE_INTEGER,
      kind: meta.kind === 'utility' ? 'utility' : 'character'
    })
  }

  return sortCharacters(characters, options.sortCharacters, options.characterOrder)
}

export async function listMods(
  modsPath: string,
  gameId: GameId,
  characterFolder: string,
  assetUrl: (absolutePath: string) => string,
  sortMode: 'name' | 'recent' | 'enabled' | 'custom',
  customOrder: string[] = []
): Promise<ModInfo[]> {
  const characterPath = await resolveCharacterDir(modsPath, characterFolder)
  const entries = await readdirSafe(characterPath)
  const mods: ModInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredModName(entry.name)) continue
    const name = entry.name.replace(/^DISABLED_/i, '')
    const modPath = path.join(characterPath, entry.name)
    const enabled = await isModFolderEffectivelyEnabled(entry.name, modPath)
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
  } else if (sortMode === 'custom') {
    const orderIndex = new Map(customOrder.map((name, index) => [name, index]))
    mods.sort((left, right) => {
      const leftIndex = orderIndex.get(left.name)
      const rightIndex = orderIndex.get(right.name)
      if (leftIndex !== undefined && rightIndex !== undefined && leftIndex !== rightIndex) {
        return leftIndex - rightIndex
      }
      if (leftIndex !== undefined && rightIndex === undefined) return -1
      if (leftIndex === undefined && rightIndex !== undefined) return 1
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

export async function getModDetails(
  modsPath: string,
  characterFolder: string,
  modFolder: string,
  assetUrl: (absolutePath: string) => string
): Promise<ModDetails> {
  if (!isSafeSegment(modFolder)) throw new Error('Mod 名称不合法')
  const characterPath = await resolveCharacterDir(modsPath, characterFolder)
  const baseName = modFolder.replace(/^DISABLED_/i, '')
  let actualModFolder = modFolder
  let modPath = path.join(characterPath, actualModFolder)
  if (!isInside(characterPath, modPath)) throw new Error('Mod 路径越界')
  if (!(await isDirectory(modPath))) {
    const fallbackFolder = /^DISABLED_/i.test(modFolder) ? baseName : `DISABLED_${baseName}`
    const fallbackPath = path.join(characterPath, fallbackFolder)
    if (isInside(characterPath, fallbackPath) && (await isDirectory(fallbackPath))) {
      actualModFolder = fallbackFolder
      modPath = fallbackPath
    } else {
      throw new Error('Mod 目录不存在')
    }
  }

  let fileCount = 0
  let sizeBytes = 0
  const iniFiles: string[] = []

  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = await readdirSafe(current)
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(full, nextRelative)
        continue
      }
      fileCount += 1
      try {
        sizeBytes += (await fs.stat(full)).size
      } catch {
        // ignore
      }
      if (entry.name.toLowerCase().endsWith('.ini')) iniFiles.push(nextRelative)
    }
  }
  await walk(modPath, '')

  const hotkeys: ModHotkey[] = []
  for (const iniFile of iniFiles.slice(0, 20)) {
    try {
      const full = path.join(modPath, iniFile)
      const stat = await fs.stat(full)
      if (stat.size > 2 * 1024 * 1024) continue
      const text = await fs.readFile(full, 'utf8')
      let section = ''
      for (const rawLine of text.split(/\r?\n/)) {
        const sectionMatch = rawLine.match(/^\s*\[([^\]]+)\]/)
        if (sectionMatch) {
          section = sectionMatch[1].trim()
          continue
        }
        const keyMatch = rawLine.match(/^\s*(?:key|back)\s*=\s*(.+?)\s*$/i)
        if (keyMatch && section) {
          const cleanKey = keyMatch[1].split(';')[0].trim()
          if (cleanKey) hotkeys.push({ section, key: cleanKey })
        }
      }
    } catch {
      // ignore unreadable ini
    }
  }

  const preview = await findPreview(modPath)
  let updatedAt = 0
  try {
    updatedAt = (await fs.stat(modPath)).mtimeMs
  } catch {
    // ignore
  }

  const effectiveEnabled = await isModFolderEffectivelyEnabled(actualModFolder, modPath)

  return {
    characterFolder,
    folderName: actualModFolder,
    name: actualModFolder.replace(/^DISABLED_/i, ''),
    path: modPath,
    enabled: effectiveEnabled,
    fileCount,
    sizeBytes,
    updatedAt,
    iniFiles,
    hotkeys,
    previewUrl: preview ? assetUrl(preview) : null
  }
}

export function isValidCharacterFolder(modsPath: string, characterFolder: string): boolean {
  if (!isSafeSegment(characterFolder)) return false
  return isInside(modsPath, path.join(modsPath, characterFolder))
}

export { statCache }
