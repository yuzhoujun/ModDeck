import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CharacterInfo,
  GameId,
  ImportCandidate,
  ImportCommitRequest,
  ImportParseRequest,
  ImportParseResult,
  ImportRequest,
  ImportResult,
  ImportResultItem,
  MetadataStore,
  Settings
} from '../../shared/types'
import { ensureDir, isDirectory, pathExists, readdirSafe, uniqueName } from '../core/fsx'
import { isInside, sanitizeSegment } from '../core/safe-path'
import { requireGame } from '../core/games'
import { matchCharacterForMod } from '../core/roster'
import { decodeCp437Mojibake, extractArchive, fixMojibakeTree, isArchiveFile } from './archive'

interface FoundMod {
  character?: string
  dir: string
  name: string
  hasIni: boolean
}

export interface ImportContext {
  baseDir: string
  settings: Settings
  metadata: MetadataStore
  existingCharacters?: CharacterInfo[]
}

interface ActiveImportSession {
  id: string
  gameId: GameId
  tempRoot: string
  createdAt: number
  candidates: Map<
    string,
    ImportCandidate & {
      isArchiveSource: boolean
      sourceRoot: string
    }
  >
}

const activeSessions = new Map<string, ActiveImportSession>()

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

/** 去掉压缩包外层包装：Xxx/Mods/... 或单层同名包装目录。 */
async function unwrapBase(root: string): Promise<string> {
  let current = root
  for (let index = 0; index < 4; index += 1) {
    const entries = await readdirSafe(current)
    const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    if (dirs.length === 0) break
    const modsChild = dirs.find((entry) => entry.name.toLowerCase() === 'mods')
    if (modsChild) {
      current = path.join(current, modsChild.name)
      continue
    }
    if (dirs.length === 1 && files.length === 0) {
      const only = path.join(current, dirs[0].name)
      // 如果唯一子目录本身直接含 .ini，说明它就是一个单独的 Mod 目录，保留在这一层方便识别
      if (await hasIni(only, 0)) {
        break
      }
      current = only
      continue
    }
    break
  }
  return current
}

/**
 * 识别解压目录或文件夹里的结构，返回候选 mod 目录。
 * 支持：单个 <mod>、合集目录 <pack>/<mod1..N>、<角色>/<mod1..N>、Mods/<角色>/<mod>。
 */
export async function analyzeExtracted(root: string): Promise<FoundMod[]> {
  const base = await unwrapBase(root)

  if (await hasIni(base, 0)) {
    return [{ dir: base, name: path.basename(base), hasIni: true }]
  }

  const entries = await dirsOf(base)
  const results: FoundMod[] = []

  for (const entry of entries) {
    const full = path.join(base, entry.name)
    if (await hasIni(full, 0)) {
      results.push({ dir: full, name: entry.name, hasIni: true })
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
          name: modName,
          hasIni: true
        })
      }
      continue
    }
    if (await hasAnyFile(full, 1)) {
      results.push({
        dir: full,
        name: entry.name,
        hasIni: await hasIni(full, 2)
      })
    }
  }

  if (results.length === 0 && (await hasAnyFile(base, 2))) {
    results.push({
      dir: base,
      name: path.basename(base),
      hasIni: await hasIni(base, 2)
    })
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

async function moveDirectoryOrCopy(sourceDir: string, destination: string): Promise<void> {
  try {
    await fs.rename(sourceDir, destination)
  } catch {
    await fs.cp(sourceDir, destination, { recursive: true, force: false, errorOnExist: true })
    await fs.rm(sourceDir, { recursive: true, force: true })
  }
}

async function placeMod(
  context: ImportContext,
  gameId: GameId,
  modsPath: string,
  characterFolder: string,
  modName: string,
  sourceDir: string,
  canMoveDirect = false
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

  if (canMoveDirect) {
    await moveDirectoryOrCopy(sourceDir, destination)
  } else {
    await fs.cp(sourceDir, destination, { recursive: true, force: false, errorOnExist: true })
  }
  await fixMojibakeTree(destination).catch(() => undefined)
  return name
}

export async function discardImportSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId)
  if (!session) return
  activeSessions.delete(sessionId)
  await fs.rm(session.tempRoot, { recursive: true, force: true }).catch(() => undefined)
}

export async function parseImportSources(
  context: ImportContext,
  request: ImportParseRequest
): Promise<ImportParseResult> {
  const game = requireGame(request.gameId)
  const gameSettings = context.settings.games[game.id]
  if (!gameSettings?.modsPath) throw new Error('请先在设置里选择这个游戏的 Mods 目录')
  if (!(await isDirectory(gameSettings.modsPath))) {
    throw new Error(`Mods 目录不存在: ${gameSettings.modsPath}`)
  }

  const rawPaths = Array.from(
    new Set((request.paths ?? []).map((item) => String(item || '').trim()).filter(Boolean))
  )
  if (rawPaths.length === 0) throw new Error('没有选择要导入的文件或文件夹')

  const sessionId = randomUUID()
  const tempRoot = path.join(context.baseDir, 'tmp', `parse-${sessionId}`)
  await ensureDir(tempRoot)

  const candidates: ImportCandidate[] = []
  const errors: Array<{ source: string; message: string }> = []
  const candidateMap = new Map<
    string,
    ImportCandidate & { isArchiveSource: boolean; sourceRoot: string }
  >()
  const existingCharacters = context.existingCharacters ?? []

  for (let index = 0; index < rawPaths.length; index += 1) {
    const source = rawPaths[index]
    const sourceName = path.basename(source)
    try {
      if (!(await pathExists(source))) throw new Error('路径不存在')
      let sourceRoot = source
      let isArchiveSource = false

      if (isArchiveFile(source)) {
        isArchiveSource = true
        sourceRoot = path.join(tempRoot, `src-${index}`)
        await extractArchive(source, sourceRoot)
      } else if (!(await isDirectory(source))) {
        throw new Error('不支持的文件格式，仅支持 .zip / .7z / .rar 压缩包或解压后的文件夹')
      }

      const found = await analyzeExtracted(sourceRoot)
      if (found.length === 0) {
        throw new Error('未在其中找到可导入的 Mod 文件')
      }

      const rawArchiveBase = isArchiveSource
        ? path.basename(source, path.extname(source))
        : path.basename(source)
      const archiveBase = decodeCp437Mojibake(rawArchiveBase)

      for (let subIndex = 0; subIndex < found.length; subIndex += 1) {
        const entry = found[subIndex]
        const rawModName =
          found.length === 1 && entry.dir === sourceRoot ? archiveBase : entry.name
        const modName = decodeCp437Mojibake(rawModName)
        const entryCharacter = entry.character ? decodeCp437Mojibake(entry.character) : ''

        let suggestedCharacter = '其他'
        let matchReason = '未匹配（默认其他）'

        if (request.targetCharacter) {
          suggestedCharacter = request.targetCharacter
          matchReason = '当前角色页'
        } else {
          const texts = [entryCharacter, modName, archiveBase]
          const matched = matchCharacterForMod(game.id, existingCharacters, texts)
          suggestedCharacter = matched.folder
          matchReason = matched.reason
        }

        const id = `${index}-${subIndex}`
        const candidate: ImportCandidate = {
          id,
          sourcePath: source,
          sourceName,
          modName,
          extractedDir: entry.dir,
          suggestedCharacter,
          matchReason,
          hasIni: entry.hasIni
        }
        candidates.push(candidate)
        candidateMap.set(id, {
          ...candidate,
          isArchiveSource,
          sourceRoot
        })
      }
    } catch (error) {
      errors.push({
        source: sourceName || source,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  activeSessions.set(sessionId, {
    id: sessionId,
    gameId: game.id,
    tempRoot,
    createdAt: Date.now(),
    candidates: candidateMap
  })

  return {
    sessionId,
    candidates,
    errors
  }
}

export async function commitImportSession(
  context: ImportContext,
  request: ImportCommitRequest
): Promise<ImportResult> {
  const session = activeSessions.get(request.sessionId)
  if (!session) throw new Error('导入会话已过期，请重新选择或拖入文件')

  const game = requireGame(request.gameId)
  const gameSettings = context.settings.games[game.id]
  if (!gameSettings?.modsPath) throw new Error('请先在设置里选择这个游戏的 Mods 目录')
  if (!(await isDirectory(gameSettings.modsPath))) {
    throw new Error(`Mods 目录不存在: ${gameSettings.modsPath}`)
  }

  const items: ImportResultItem[] = []
  const createdCharacters = new Set<string>()
  let importedMods = 0

  const isMoveMode =
    context.settings.import.mode === 'move' || context.settings.import.deleteArchiveAfter

  // Track which sources had ALL their candidates selected and succeeded, so we can safely remove archive/folder in move mode
  const selectedIdsBySource = new Map<string, Set<string>>()
  const succeededIdsBySource = new Map<string, Set<string>>()

  for (const commitItem of request.items) {
    const candidate = session.candidates.get(commitItem.id)
    if (!candidate) continue
    if (!selectedIdsBySource.has(candidate.sourcePath)) {
      selectedIdsBySource.set(candidate.sourcePath, new Set())
      succeededIdsBySource.set(candidate.sourcePath, new Set())
    }
    selectedIdsBySource.get(candidate.sourcePath)!.add(candidate.id)
  }

  try {
    for (const commitItem of request.items) {
      const candidate = session.candidates.get(commitItem.id)
      if (!candidate) continue

      const itemResult: ImportResultItem = {
        source: candidate.sourcePath,
        ok: false
      }
      items.push(itemResult)

      try {
        const characterFolder = sanitizeSegment(
          commitItem.characterFolder || candidate.suggestedCharacter || '其他',
          '其他'
        )
        const charDir = path.join(gameSettings.modsPath, characterFolder)
        const charExisted = await pathExists(charDir)
        if (!charExisted) createdCharacters.add(characterFolder)

        const finalModName = (commitItem.modName || candidate.modName || 'mod').trim()
        const canMoveDirect =
          isMoveMode &&
          !candidate.isArchiveSource &&
          candidate.extractedDir === candidate.sourcePath

        const placed = await placeMod(
          context,
          game.id,
          gameSettings.modsPath,
          characterFolder,
          finalModName,
          candidate.extractedDir,
          canMoveDirect
        )
        importedMods += 1
        itemResult.ok = true
        itemResult.characters = [characterFolder]
        itemResult.mods = [placed]
        succeededIdsBySource.get(candidate.sourcePath)?.add(candidate.id)
      } catch (error) {
        itemResult.ok = false
        itemResult.message = error instanceof Error ? error.message : String(error)
      }
    }

    if (isMoveMode) {
      for (const [sourcePath, succeededSet] of succeededIdsBySource.entries()) {
        const totalCandidatesForSource = Array.from(session.candidates.values()).filter(
          (c) => c.sourcePath === sourcePath
        )
        // Only delete original source if all candidates from this source were selected and succeeded
        if (
          succeededSet.size > 0 &&
          succeededSet.size === totalCandidatesForSource.length &&
          (await pathExists(sourcePath))
        ) {
          await fs.rm(sourcePath, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  } finally {
    await discardImportSession(request.sessionId)
  }

  return {
    items,
    importedMods,
    createdCharacters: Array.from(createdCharacters)
  }
}

export async function runImport(context: ImportContext, request: ImportRequest): Promise<ImportResult> {
  const sources = [
    ...(request.archivePaths ?? []),
    ...(request.folderPaths ?? [])
  ]
  const parsed = await parseImportSources(context, {
    gameId: request.gameId,
    paths: sources,
    targetCharacter: request.targetCharacter
  })
  if (parsed.candidates.length === 0) {
    await discardImportSession(parsed.sessionId)
    return {
      items: parsed.errors.map((err) => ({
        source: err.source,
        ok: false,
        message: err.message
      })),
      importedMods: 0,
      createdCharacters: []
    }
  }
  return commitImportSession(context, {
    sessionId: parsed.sessionId,
    gameId: request.gameId,
    items: parsed.candidates.map((candidate) => ({
      id: candidate.id,
      characterFolder: request.targetCharacter || candidate.suggestedCharacter || '其他',
      modName: candidate.modName
    }))
  })
}
