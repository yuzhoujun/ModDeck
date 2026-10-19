import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  GameId,
  ImportRequest,
  ImportResult,
  ImportResultItem,
  MetadataStore,
  Settings
} from '../../shared/types'
import { ensureDir, isDirectory, pathExists, readdirSafe, uniqueName } from '../core/fsx'
import { isInside, sanitizeSegment } from '../core/safe-path'
import { requireGame } from '../core/games'
import { extractArchive, isArchiveFile } from './archive'

interface FoundMod {
  character?: string
  dir: string
  name: string
}

export interface ImportContext {
  baseDir: string
  settings: Settings
  metadata: MetadataStore
}

async function dirsOf(dir: string): Promise<import('node:fs').Dirent[]> {
  return (await readdirSafe(dir)).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.')
  )
}

async function hasIni(dir: string, depth: number): Promise<boolean> {
  const entries = await readdirSafe(dir)
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.ini')) return true
    if (depth > 0 && entry.isDirectory() && !entry.name.startsWith('.')) {
      if (await hasIni(path.join(dir, entry.name), depth - 1)) return true
    }
  }
  return false
}

async function hasAnyFile(dir: string, depth: number): Promise<boolean> {
  const entries = await readdirSafe(dir)
  for (const entry of entries) {
    if (entry.isFile()) return true
    if (depth > 0 && entry.isDirectory() && !entry.name.startsWith('.')) {
      if (await hasAnyFile(path.join(dir, entry.name), depth - 1)) return true
    }
  }
  return false
}

/** 去掉压缩包外层包装：Xxx/Mods/... 或 Xxx/。 */
async function unwrapBase(root: string): Promise<string> {
  let current = root
  for (let index = 0; index < 4; index += 1) {
    const dirs = await dirsOf(current)
    if (dirs.length === 0) break
    const modsChild = dirs.find((entry) => entry.name.toLowerCase() === 'mods')
    if (modsChild) {
      current = path.join(current, modsChild.name)
      continue
    }
    if (dirs.length === 1) {
      const only = dirs[0]
      const grandChildren = await dirsOf(path.join(current, only.name))
      if (grandChildren.some((entry) => entry.name.toLowerCase() === 'mods')) {
        current = path.join(current, only.name)
        continue
      }
    }
    break
  }
  return current
}

/**
 * 识别解压目录里的结构，返回候选 mod 目录。
 * 支持 Mods/<角色>/<mod>、<角色>/<mod>、单个 <mod>。
 */
export async function analyzeExtracted(root: string): Promise<FoundMod[]> {
  const base = await unwrapBase(root)

  if (await hasIni(base, 0)) {
    return [{ dir: base, name: path.basename(base) }]
  }

  const entries = await dirsOf(base)
  const results: FoundMod[] = []

  for (const entry of entries) {
    const full = path.join(base, entry.name)
    if (await hasIni(full, 0)) {
      results.push({ dir: full, name: entry.name })
      continue
    }
    const children = await dirsOf(full)
    const modChildren: string[] = []
    for (const child of children) {
      if (await hasIni(path.join(full, child.name), 1)) modChildren.push(child.name)
    }
    if (modChildren.length > 0) {
      for (const modName of modChildren) {
        results.push({
          character: entry.name,
          dir: path.join(full, modName),
          name: modName
        })
      }
      continue
    }
    if (await hasAnyFile(full, 1)) {
      results.push({ dir: full, name: entry.name })
    }
  }

  if (results.length === 0 && (await hasAnyFile(base, 2))) {
    results.push({ dir: base, name: path.basename(base) })
  }

  return results
}

async function backupExisting(
  baseDir: string,
  gameId: GameId,
  destination: string
): Promise<void> {
  const relative = destination.split(path.sep).slice(-3).join(path.sep)
  const target = path.join(
    baseDir,
    'backups',
    new Date().toISOString().replace(/[:.]/g, '-'),
    gameId,
    relative
  )
  await ensureDir(path.dirname(target))
  await fs.rename(destination, target)
}

async function placeMod(
  context: ImportContext,
  gameId: GameId,
  modsPath: string,
  characterFolder: string,
  modName: string,
  sourceDir: string
): Promise<string> {
  const characterDir = path.join(modsPath, characterFolder)
  if (!isInside(modsPath, characterDir)) throw new Error('目标角色目录越界')
  await ensureDir(characterDir)

  let name = sanitizeSegment(modName, 'mod')
  let destination = path.join(characterDir, name)
  if (await pathExists(destination)) {
    if (context.settings.import.overwriteExisting) {
      await backupExisting(context.baseDir, gameId, destination)
    } else {
      name = await uniqueName(characterDir, name)
      destination = path.join(characterDir, name)
    }
  }

  await fs.cp(sourceDir, destination, { recursive: true, force: false, errorOnExist: true })
  return name
}

export async function runImport(context: ImportContext, request: ImportRequest): Promise<ImportResult> {
  const game = requireGame(request.gameId)
  const gameSettings = context.settings.games[game.id]
  if (!gameSettings?.modsPath) throw new Error('请先在设置里选择这个游戏的 Mods 目录')
  if (!(await isDirectory(gameSettings.modsPath))) {
    throw new Error(`Mods 目录不存在: ${gameSettings.modsPath}`)
  }

  const sources = [
    ...(request.archivePaths ?? []),
    ...(request.folderPaths ?? [])
  ]
  if (sources.length === 0) throw new Error('没有选择要导入的文件')

  const tempRoot = path.join(context.baseDir, 'tmp', `import-${randomUUID()}`)
  await ensureDir(tempRoot)

  const items: ImportResultItem[] = []
  const createdCharacters = new Set<string>()
  let importedMods = 0

  try {
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]
      const item: ImportResultItem = { source, ok: false }
      items.push(item)

      try {
        if (!(await pathExists(source))) throw new Error('文件不存在')
        let sourceRoot = source
        let archive = false

        if (isArchiveFile(source)) {
          archive = true
          sourceRoot = path.join(tempRoot, `src-${index}`)
          await extractArchive(source, sourceRoot)
        } else if (!(await isDirectory(source))) {
          throw new Error('不支持的来源，只接受 zip / 7z / rar 或文件夹')
        }

        const found = await analyzeExtracted(sourceRoot)
        if (found.length === 0) throw new Error('没有在压缩包内找到 mod 目录')

        const archiveBase = path.basename(source, path.extname(source))
        const characters: string[] = []
        const mods: string[] = []

        for (const entry of found) {
          const characterFolder = sanitizeSegment(
            request.targetCharacter || entry.character || '',
            ''
          )
          if (!characterFolder) {
            throw new Error('无法判断这个 mod 属于哪个角色，请进入角色页后再导入')
          }

          const charDir = path.join(gameSettings.modsPath, characterFolder)
          const charExisted = await pathExists(charDir)
          if (!charExisted) createdCharacters.add(characterFolder)

          const modName =
            found.length === 1 && entry.dir === sourceRoot ? archiveBase : entry.name
          const placed = await placeMod(
            context,
            game.id,
            gameSettings.modsPath,
            characterFolder,
            modName,
            entry.dir
          )
          importedMods += 1
          if (!characters.includes(characterFolder)) characters.push(characterFolder)
          mods.push(placed)
        }

        item.ok = true
        item.characters = characters
        item.mods = mods
        if (archive && context.settings.import.deleteArchiveAfter) {
          await fs.rm(source, { force: true })
        }
      } catch (error) {
        item.ok = false
        item.message = error instanceof Error ? error.message : String(error)
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  return {
    items,
    importedMods,
    createdCharacters: Array.from(createdCharacters)
  }
}
