import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ConfigBundleInspection,
  ConfigBundleManifest,
  GameId,
  ImportConfigBundleOptions,
  ImportConfigBundleResult,
  MetadataStore,
  ModBackupEntry,
  RosterPreset,
  Settings,
  StorageCategoryStat,
  StorageOverview
} from '../../shared/types'
import { ensureDir, pathExists, readJsonSafe, writeJsonAtomic } from '../core/fsx'
import { isInside, isSafeSegment } from '../core/safe-path'
import { buildZipBuffer, readZipBuffer, type ZipMemoryEntry } from './archive'
import { resolveCharacterBase, scanGameCategoryCovers } from './library'
import { emptyMetadata, METADATA_FILE } from './metadata'

async function measurePathStats(targetPath: string): Promise<{ fileCount: number; totalBytes: number }> {
  if (!(await pathExists(targetPath))) return { fileCount: 0, totalBytes: 0 }
  const stat = await fs.stat(targetPath).catch(() => null)
  if (!stat) return { fileCount: 0, totalBytes: 0 }
  if (stat.isFile()) return { fileCount: 1, totalBytes: stat.size }
  if (!stat.isDirectory()) return { fileCount: 0, totalBytes: 0 }

  let fileCount = 0
  let totalBytes = 0
  const stack = [targetPath]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        const s = await fs.stat(full).catch(() => null)
        if (s) {
          fileCount += 1
          totalBytes += s.size
        }
      }
    }
  }
  return { fileCount, totalBytes }
}

function parseTimestampDir(name: string, fallbackMs: number): number {
  // backupExisting generates: 2026-11-13T12-30-45-123Z
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/)
  if (match) {
    const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallbackMs
}

async function moveOrCopyDir(sourceDir: string, destination: string): Promise<void> {
  try {
    await fs.rename(sourceDir, destination)
  } catch {
    await fs.cp(sourceDir, destination, { recursive: true, force: false, errorOnExist: true })
    await fs.rm(sourceDir, { recursive: true, force: true })
  }
}

async function cleanupEmptyParents(startDir: string, stopAtDir: string): Promise<void> {
  let current = startDir
  while (current && current !== stopAtDir && isInside(stopAtDir, current)) {
    const entries = await fs.readdir(current).catch(() => null)
    if (!entries || entries.length > 0) break
    await fs.rmdir(current).catch(() => undefined)
    current = path.dirname(current)
  }
}

async function collectModBackupLeafDirs(gameDir: string): Promise<string[]> {
  // backups/<timestamp>/<gameId>/<modsRootName>/<characterFolder>/<modName>
  // 找到最底层的备份 Mod 文件夹（depth === 3 或者直接含子文件/无深层角色层）
  const leaves: string[] = []
  const level1 = await fs.readdir(gameDir, { withFileTypes: true }).catch(() => [])
  for (const e1 of level1) {
    if (!e1.isDirectory()) continue
    const p1 = path.join(gameDir, e1.name)
    const level2 = await fs.readdir(p1, { withFileTypes: true }).catch(() => [])
    const subDirs2 = level2.filter((x) => x.isDirectory())
    if (subDirs2.length === 0) {
      leaves.push(p1)
      continue
    }
    for (const e2 of subDirs2) {
      const p2 = path.join(p1, e2.name)
      const level3 = await fs.readdir(p2, { withFileTypes: true }).catch(() => [])
      const subDirs3 = level3.filter((x) => x.isDirectory())
      // 判断 p2 下的子目录是否本身才是 modName（当 p1 是 mods 文件夹名时）
      if (subDirs3.length > 0 && level2.every((x) => x.isDirectory()) && e1.name.toLowerCase().includes('mod')) {
        for (const e3 of subDirs3) {
          leaves.push(path.join(p2, e3.name))
        }
      } else {
        // 标准 3 段：<modsDir>/<charFolder>/<modName> 中 e2 是 charFolder 且其子目录是 modName
        // 如果 level3 包含文件（比如 mod 的 ini/tex）则说明 p2 就是 modDir；否则检查是否还有 mod 文件夹
        const hasIniAtP2 = level3.some((f) => f.isFile() && f.name.toLowerCase().endsWith('.ini'))
        if (hasIniAtP2 || subDirs3.length === 0) {
          leaves.push(p2)
        } else {
          for (const e3 of subDirs3) {
            leaves.push(path.join(p2, e3.name))
          }
        }
      }
    }
  }
  return leaves
}

export async function getStorageOverview(baseDir: string, settings: Settings): Promise<StorageOverview> {
  const configFiles = ['settings.json', METADATA_FILE, 'roster-presets.json', 'roster-cache.json']
  let configCount = 0
  let configBytes = 0
  for (const f of configFiles) {
    const s = await measurePathStats(path.join(baseDir, f))
    configCount += s.fileCount
    configBytes += s.totalBytes
  }
  for (const dir of ['presets', 'languages']) {
    const s = await measurePathStats(path.join(baseDir, dir))
    configCount += s.fileCount
    configBytes += s.totalBytes
  }

  const coversStat = await measurePathStats(path.join(baseDir, 'covers'))
  let categoryCoverCount = 0
  let categoryCoverBytes = 0
  const seenModsPaths = new Set<string>()
  for (const gameSettings of Object.values(settings.games || {})) {
    const mp = gameSettings?.modsPath?.trim()
    if (!mp || seenModsPaths.has(mp.toLowerCase())) continue
    seenModsPaths.add(mp.toLowerCase())
    const foundCovers = await scanGameCategoryCovers(mp).catch(() => [])
    for (const c of foundCovers) {
      categoryCoverCount += 1
      categoryCoverBytes += c.size
    }
  }
  const backupsRoot = path.join(baseDir, 'backups')
  const backupsStat = await measurePathStats(backupsRoot)
  const logsStat = await measurePathStats(path.join(baseDir, 'logs'))

  const categories: StorageCategoryStat[] = [
    { key: 'config', fileCount: configCount, totalBytes: configBytes },
    {
      key: 'covers',
      fileCount: coversStat.fileCount + categoryCoverCount,
      totalBytes: coversStat.totalBytes + categoryCoverBytes
    },
    { key: 'backups', fileCount: backupsStat.fileCount, totalBytes: backupsStat.totalBytes },
    { key: 'logs', fileCount: logsStat.fileCount, totalBytes: logsStat.totalBytes }
  ]

  const backups: ModBackupEntry[] = []
  if (await pathExists(backupsRoot)) {
    const tsEntries = await fs.readdir(backupsRoot, { withFileTypes: true }).catch(() => [])
    for (const tsEntry of tsEntries) {
      if (!tsEntry.isDirectory() || tsEntry.name === 'config-snapshots') continue
      const tsPath = path.join(backupsRoot, tsEntry.name)
      const tsStat = await fs.stat(tsPath).catch(() => null)
      const createdAt = parseTimestampDir(tsEntry.name, tsStat?.mtimeMs ?? Date.now())

      const gameEntries = await fs.readdir(tsPath, { withFileTypes: true }).catch(() => [])
      for (const gameEntry of gameEntries) {
        if (!gameEntry.isDirectory()) continue
        const gameId = gameEntry.name as GameId
        const gameBackupDir = path.join(tsPath, gameEntry.name)
        const leaves = await collectModBackupLeafDirs(gameBackupDir)

        for (const leafPath of leaves) {
          const relFromGame = path.relative(gameBackupDir, leafPath)
          const parts = relFromGame.split(path.sep).filter(Boolean)
          if (parts.length === 0) continue

          const modName = parts[parts.length - 1]
          const characterFolder = parts.length >= 2 ? parts[parts.length - 2] : ''
          const leafStat = await measurePathStats(leafPath)
          const id = path.relative(backupsRoot, leafPath).split(path.sep).join('/')

          const modsPath = settings.games[gameId]?.modsPath || ''
          const expectedTarget =
            modsPath && characterFolder
              ? path.join(modsPath, characterFolder, modName)
              : modsPath
                ? path.join(modsPath, modName)
                : ''
          const targetExists = expectedTarget ? await pathExists(expectedTarget) : false

          backups.push({
            id,
            timestampDir: tsEntry.name,
            createdAt,
            gameId,
            characterFolder,
            modName,
            totalBytes: leafStat.totalBytes,
            fileCount: leafStat.fileCount,
            backupPath: leafPath,
            targetExists
          })
        }
      }
    }
  }

  backups.sort((a, b) => b.createdAt - a.createdAt)
  const totalBytes = categories.reduce((sum, item) => sum + item.totalBytes, 0)

  return {
    dataDir: baseDir,
    totalBytes,
    categories,
    backups
  }
}

export async function restoreModBackup(
  baseDir: string,
  backupId: string,
  settings: Settings
): Promise<void> {
  const backupsRoot = path.join(baseDir, 'backups')
  const relSegments = backupId.split('/').filter(Boolean)
  const backupPath = path.join(backupsRoot, ...relSegments)
  if (!isInside(backupsRoot, backupPath) || !(await pathExists(backupPath))) {
    throw new Error('备份目录不存在或路径无效')
  }

  const gameId = relSegments[1]
  const restParts = relSegments.slice(2)
  if (!gameId || restParts.length === 0) {
    throw new Error('备份结构不完整，无法还原')
  }

  const modsPath = settings.games[gameId]?.modsPath
  if (!modsPath || !(await pathExists(modsPath))) {
    throw new Error(`未配置或找不到游戏 ${gameId} 的 Mods 物理目录`)
  }

  const modName = restParts[restParts.length - 1]
  const characterFolder = restParts.length >= 2 ? restParts[restParts.length - 2] : ''
  const targetParent = characterFolder ? path.join(modsPath, characterFolder) : modsPath
  const targetDir = path.join(targetParent, modName)
  if (!isInside(modsPath, targetDir)) {
    throw new Error('还原目标路径越界')
  }

  await ensureDir(targetParent)
  if (await pathExists(targetDir)) {
    const safeBackupDest = path.join(
      backupsRoot,
      new Date().toISOString().replace(/[:.]/g, '-'),
      gameId,
      characterFolder || path.basename(modsPath),
      modName
    )
    await ensureDir(path.dirname(safeBackupDest))
    await moveOrCopyDir(targetDir, safeBackupDest)
  }

  await moveOrCopyDir(backupPath, targetDir)
  await cleanupEmptyParents(path.dirname(backupPath), backupsRoot)
}

export async function deleteModBackup(baseDir: string, backupId: string): Promise<void> {
  const backupsRoot = path.join(baseDir, 'backups')
  const relSegments = backupId.split('/').filter(Boolean)
  const backupPath = path.join(backupsRoot, ...relSegments)
  if (!isInside(backupsRoot, backupPath) || !(await pathExists(backupPath))) {
    throw new Error('备份目录不存在')
  }
  await fs.rm(backupPath, { recursive: true, force: true })
  await cleanupEmptyParents(path.dirname(backupPath), backupsRoot)
}

export async function pruneModBackups(
  baseDir: string,
  olderThanDays: number
): Promise<{ deletedCount: number; freedBytes: number }> {
  const backupsRoot = path.join(baseDir, 'backups')
  if (!(await pathExists(backupsRoot))) return { deletedCount: 0, freedBytes: 0 }

  const cutoff = olderThanDays <= 0 ? Number.POSITIVE_INFINITY : Date.now() - olderThanDays * 86_400_000
  const tsEntries = await fs.readdir(backupsRoot, { withFileTypes: true }).catch(() => [])
  let deletedCount = 0
  let freedBytes = 0

  for (const tsEntry of tsEntries) {
    if (!tsEntry.isDirectory() || tsEntry.name === 'config-snapshots') continue
    const tsPath = path.join(backupsRoot, tsEntry.name)
    const stat = await fs.stat(tsPath).catch(() => null)
    const createdAt = parseTimestampDir(tsEntry.name, stat?.mtimeMs ?? Date.now())
    if (createdAt < cutoff) {
      const measured = await measurePathStats(tsPath)
      await fs.rm(tsPath, { recursive: true, force: true })
      deletedCount += 1
      freedBytes += measured.totalBytes
    }
  }

  return { deletedCount, freedBytes }
}

async function collectDirZipEntries(baseDir: string, subDirName: string): Promise<ZipMemoryEntry[]> {
  const rootDir = path.join(baseDir, subDirName)
  if (!(await pathExists(rootDir))) return []
  const result: ZipMemoryEntry[] = []
  const stack = [rootDir]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    const entries = await fs.readdir(cur, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, full).split(path.sep).join('/')
        const data = await fs.readFile(full)
        result.push({ name: rel, data })
      }
    }
  }
  return result
}

export async function exportConfigBundle(
  baseDir: string,
  appVersion: string,
  outputPath: string
): Promise<ConfigBundleManifest> {
  const entries: ZipMemoryEntry[] = []
  for (const name of ['settings.json', METADATA_FILE, 'roster-presets.json']) {
    const src = path.join(baseDir, name)
    if (await pathExists(src)) {
      entries.push({ name, data: await fs.readFile(src) })
    }
  }

  const coverEntries = await collectDirZipEntries(baseDir, 'covers')
  const presetEntries = await collectDirZipEntries(baseDir, 'presets')
  const langEntries = await collectDirZipEntries(baseDir, 'languages')
  entries.push(...coverEntries, ...presetEntries, ...langEntries)

  const settingsData = await readJsonSafe<Settings | null>(path.join(baseDir, 'settings.json'), null)
  const metaData = await readJsonSafe<MetadataStore | null>(path.join(baseDir, METADATA_FILE), null)
  const rosterData = await readJsonSafe<{ presets?: Record<string, RosterPreset[]> } | null>(
    path.join(baseDir, 'roster-presets.json'),
    null
  )

  // 一并打包各已配置游戏 Mods 分类目录中直接保存的 .preview.* / _cover.* 分类封面（跨机迁移不丢失）
  const categoryCoverEntries: ZipMemoryEntry[] = []
  for (const [gId, gameSettings] of Object.entries(settingsData?.games || {})) {
    const mp = gameSettings?.modsPath?.trim()
    if (!mp) continue
    const found = await scanGameCategoryCovers(mp).catch(() => [])
    for (const item of found) {
      const data = await fs.readFile(item.filePath).catch(() => null)
      if (!data) continue
      categoryCoverEntries.push({
        name: `category-covers/${gId}/${item.folder}/${item.fileName}`,
        data
      })
    }
  }
  entries.push(...categoryCoverEntries)

  const characterMetaCount = metaData?.games
    ? Object.values(metaData.games).reduce((acc, map) => acc + Object.keys(map || {}).length, 0)
    : 0
  const rosterPresetsCount = rosterData?.presets
    ? Object.values(rosterData.presets).reduce(
        (acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0),
        0
      )
    : 0

  const manifest: ConfigBundleManifest = {
    moddeckFileType: 'config-bundle',
    version: 1,
    appVersion,
    exportedAt: Date.now(),
    stats: {
      customGames: Array.isArray(settingsData?.customGames) ? settingsData.customGames.length : 0,
      characterMeta: characterMetaCount,
      coverFiles: coverEntries.length + categoryCoverEntries.length,
      modPresetFiles: presetEntries.length,
      rosterPresets: rosterPresetsCount,
      languageFiles: langEntries.length
    }
  }

  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') })
  const zipBuf = buildZipBuffer(entries)
  await ensureDir(path.dirname(outputPath))
  await fs.writeFile(outputPath, zipBuf)
  return manifest
}

export async function inspectConfigBundle(archivePath: string): Promise<ConfigBundleInspection> {
  try {
    const zipBuf = await fs.readFile(archivePath)
    const entries = readZipBuffer(zipBuf)
    const manifestEntry = entries.find((e) => e.name === 'manifest.json')
    const manifest = manifestEntry
      ? (JSON.parse(manifestEntry.data.toString('utf8')) as ConfigBundleManifest)
      : null
    if (!manifest || manifest.moddeckFileType !== 'config-bundle' || manifest.version !== 1) {
      return {
        ok: false,
        error: '无效的 ModDeck 配置迁移归档包（缺少有效的 manifest.json）'
      }
    }
    return {
      ok: true,
      filePath: archivePath,
      manifest
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function createConfigSnapshot(baseDir: string): Promise<string> {
  const snapshotDir = path.join(
    baseDir,
    'backups',
    'config-snapshots',
    new Date().toISOString().replace(/[:.]/g, '-')
  )
  await ensureDir(snapshotDir)
  for (const file of ['settings.json', METADATA_FILE, 'roster-presets.json']) {
    const src = path.join(baseDir, file)
    if (await pathExists(src)) {
      await fs.copyFile(src, path.join(snapshotDir, file)).catch(() => undefined)
    }
  }
  for (const dir of ['covers', 'presets', 'languages']) {
    const src = path.join(baseDir, dir)
    if (await pathExists(src)) {
      await fs.cp(src, path.join(snapshotDir, dir), { recursive: true }).catch(() => undefined)
    }
  }
  return snapshotDir
}

function parseEntryJson<T>(entries: ZipMemoryEntry[], fileName: string): T | null {
  const entry = entries.find((e) => e.name === fileName)
  if (!entry) return null
  try {
    return JSON.parse(entry.data.toString('utf8')) as T
  } catch {
    return null
  }
}

export async function importConfigBundle(
  baseDir: string,
  archivePath: string,
  currentSettings: Settings,
  options: ImportConfigBundleOptions
): Promise<ImportConfigBundleResult> {
  try {
    const zipBuf = await fs.readFile(archivePath)
    const entries = readZipBuffer(zipBuf)
    const manifest = parseEntryJson<ConfigBundleManifest>(entries, 'manifest.json')
    if (!manifest || manifest.moddeckFileType !== 'config-bundle' || manifest.version !== 1) {
      return { ok: false, error: '无效的配置迁移包格式' }
    }

    const snapshotDir = await createConfigSnapshot(baseDir)

    let customGamesRestored = 0
    let characterMetaRestored = 0
    let coverFilesRestored = 0
    let modPresetFilesRestored = 0
    let rosterPresetsRestored = 0
    let languageFilesRestored = 0

    let mergedSettingsRef: Settings = currentSettings

    // 1. 合并 settings.json
    const incomingSettings = parseEntryJson<Settings>(entries, 'settings.json')
    if (incomingSettings) {
      const mergedGames: Settings['games'] = { ...currentSettings.games }
      for (const [gId, incGame] of Object.entries(incomingSettings.games || {})) {
        const localGame = currentSettings.games[gId] || { modsPath: '', gamePath: '', loaderPath: '' }
        if (options.preserveExistingPaths) {
          const keepOrCheck = async (localVal: string | undefined, incVal: string | undefined) => {
            if (localVal) return localVal
            if (incVal && (await pathExists(incVal))) return incVal
            return ''
          }
          mergedGames[gId] = {
            ...incGame,
            modsPath: await keepOrCheck(localGame.modsPath, incGame.modsPath),
            gamePath: await keepOrCheck(localGame.gamePath, incGame.gamePath),
            loaderPath: await keepOrCheck(localGame.loaderPath, incGame.loaderPath)
          }
        } else {
          mergedGames[gId] = { ...incGame }
        }
      }

      const customMap = new Map(
        (currentSettings.customGames || []).map((g) => [g.id, g] as const)
      )
      for (const cg of incomingSettings.customGames || []) {
        customMap.set(cg.id, cg)
        customGamesRestored += 1
      }

      const nextSettings: Settings = {
        ...currentSettings,
        ...incomingSettings,
        xxmiRoot: options.preserveExistingPaths
          ? currentSettings.xxmiRoot || incomingSettings.xxmiRoot
          : incomingSettings.xxmiRoot,
        games: mergedGames,
        customGames: Array.from(customMap.values()),
        ui: {
          ...currentSettings.ui,
          ...incomingSettings.ui
        },
        import: {
          ...currentSettings.import,
          ...incomingSettings.import
        }
      }
      mergedSettingsRef = nextSettings
      await writeJsonAtomic(path.join(baseDir, 'settings.json'), nextSettings)
    }

    // 2. 合并 characters.json (MetadataStore)
    let nextMetaStore = await readJsonSafe<MetadataStore>(
      path.join(baseDir, METADATA_FILE),
      emptyMetadata()
    )
    const incomingMeta = parseEntryJson<MetadataStore>(entries, METADATA_FILE)
    if (incomingMeta && incomingMeta.games) {
      const mergedGames: MetadataStore['games'] = { ...nextMetaStore.games }
      for (const [gId, incChars] of Object.entries(incomingMeta.games)) {
        if (!incChars || typeof incChars !== 'object') continue
        mergedGames[gId] = {
          ...(nextMetaStore.games[gId] || {}),
          ...incChars
        }
        characterMetaRestored += Object.keys(incChars).length
      }
      nextMetaStore = {
        schemaVersion: 1,
        games: mergedGames,
        rosterInitialized: {
          ...(nextMetaStore.rosterInitialized || {}),
          ...(incomingMeta.rosterInitialized || {})
        }
      }
      await writeJsonAtomic(path.join(baseDir, METADATA_FILE), nextMetaStore)
    }

    // 3. 合并 roster-presets.json ({ schemaVersion: 1, presets: Record<GameId, RosterPreset[]> })
    const incomingRoster = parseEntryJson<{
      schemaVersion?: number
      presets?: Record<string, RosterPreset[]>
    }>(entries, 'roster-presets.json')
    if (incomingRoster && incomingRoster.presets && typeof incomingRoster.presets === 'object') {
      const currentRoster = await readJsonSafe<{
        schemaVersion: 1
        presets: Record<string, RosterPreset[]>
      }>(path.join(baseDir, 'roster-presets.json'), { schemaVersion: 1, presets: {} })
      const mergedPresets: Record<string, RosterPreset[]> = { ...(currentRoster.presets || {}) }
      for (const [gId, incArr] of Object.entries(incomingRoster.presets)) {
        if (!Array.isArray(incArr)) continue
        const map = new Map((mergedPresets[gId] || []).map((p) => [p.id, p] as const))
        for (const p of incArr) {
          map.set(p.id, p)
          rosterPresetsRestored += 1
        }
        mergedPresets[gId] = Array.from(map.values())
      }
      await writeJsonAtomic(path.join(baseDir, 'roster-presets.json'), {
        schemaVersion: 1,
        presets: mergedPresets
      })
    }

    // 4. 安全写出 covers / presets / languages 目录条目与 category-covers 分类封面
    let metaDirty = false
    for (const entry of entries) {
      const cleanPosix = entry.name.replace(/\\/g, '/').replace(/^\/+/, '')
      const parts = cleanPosix.split('/')
      const prefix = parts[0]

      if (prefix === 'category-covers' && parts.length === 4) {
        const [, gId, charFolder, fileName] = parts
        if (
          !isSafeSegment(gId) ||
          !isSafeSegment(charFolder) ||
          !/^(?:\.preview|_cover)\.(?:png|jpe?g|webp|gif|avif)$/i.test(fileName)
        ) {
          continue
        }
        const gameModsPath = mergedSettingsRef.games?.[gId]?.modsPath?.trim()
        let wroteDirectly = false
        if (gameModsPath && (await pathExists(gameModsPath))) {
          const charBase = await resolveCharacterBase(gameModsPath)
          const targetCharDir = path.join(charBase, charFolder)
          if (isInside(charBase, targetCharDir) && (await pathExists(targetCharDir))) {
            const dest = path.join(targetCharDir, fileName)
            if (isInside(targetCharDir, dest)) {
              await fs.writeFile(dest, entry.data)
              wroteDirectly = true
            }
          }
        }
        if (!wroteDirectly) {
          // 目标分类目录尚未在本机建立时，兜底保存至 userData/covers 并绑定元数据，避免新机丢失封面
          const ext = path.extname(fileName).toLowerCase() || '.png'
          const hashName = `${createHash('sha1').update(`${gId}/${charFolder}`).digest('hex').slice(0, 16)}${ext}`
          const relCover = path.join(gId, hashName)
          const absCover = path.join(baseDir, 'covers', relCover)
          await ensureDir(path.dirname(absCover))
          await fs.writeFile(absCover, entry.data)
          const gameMeta = { ...(nextMetaStore.games[gId] || {}) }
          gameMeta[charFolder] = {
            ...(gameMeta[charFolder] || {}),
            coverFile: relCover
          }
          nextMetaStore.games[gId] = gameMeta
          metaDirty = true
        }
        coverFilesRestored += 1
        continue
      }

      if (prefix !== 'covers' && prefix !== 'presets' && prefix !== 'languages') continue
      const dest = path.resolve(baseDir, ...parts)
      const allowedRoot = path.join(baseDir, prefix)
      if (!isInside(allowedRoot, dest)) continue
      await ensureDir(path.dirname(dest))
      await fs.writeFile(dest, entry.data)
      if (prefix === 'covers') coverFilesRestored += 1
      else if (prefix === 'presets') modPresetFilesRestored += 1
      else if (prefix === 'languages') languageFilesRestored += 1
    }
    if (metaDirty) {
      await writeJsonAtomic(path.join(baseDir, METADATA_FILE), nextMetaStore)
    }

    return {
      ok: true,
      snapshotDir,
      restored: {
        customGames: customGamesRestored,
        characterMeta: characterMetaRestored,
        coverFiles: coverFilesRestored,
        modPresetFiles: modPresetFilesRestored,
        rosterPresets: rosterPresetsRestored,
        languageFiles: languageFilesRestored
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
