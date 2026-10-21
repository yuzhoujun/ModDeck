import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell
} from 'electron'
import type {
  AppInfo,
  CharacterMeta,
  GameId,
  ImportRequest,
  Settings,
  SettingsPatch,
  ToggleResult
} from '../shared/types'
import { IPC } from '../shared/ipc'
import { GAMES, requireGame } from './core/games'
import { ensureDir, pathExists } from './core/fsx'
import { isInside, isSafeSegment } from './core/safe-path'
import { loadSettings, mergeSettings, saveSettings } from './services/settings'
import {
  coverPath,
  getCharacterMeta,
  loadMetadata,
  markRosterInitialized,
  removeCharacterMeta,
  saveCover,
  saveMetadata,
  setCharacterMeta
} from './services/metadata'
import {
  buildSnapshot,
  listCharacterFolderNames,
  listMods,
  resolveCharacterDir
} from './services/library'
import { runImport } from './services/imports'
import type { MetadataStore } from '../shared/types'

// 部分地区安全软件会阻止 Chromium 沙箱初始化，导致主进程直接退出。
// ModDeck 只加载本地打包内容，开启 contextIsolation，关闭 OS 沙箱以兼容这类环境。
app.commandLine.appendSwitch('no-sandbox')

const SMOKE_TEST = process.argv.includes('--smoke-test')
const SCAN_REPORT = process.argv.includes('--scan-report')
const SMOKE_DIR = path.join(process.cwd(), 'temp', 'smoke')
const APP_ID = 'dev.moddeck.app'
const SCHEME = 'moddeck'

const STARTUP_LOG_CANDIDATES = [
  path.join(process.env.APPDATA || '', 'ModDeck', 'logs', 'startup.log'),
  path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'ModDeck', 'logs', 'startup.log'),
  path.join(process.env.TEMP || '', 'ModDeck-logs', 'startup.log'),
  path.join(process.cwd(), 'ModDeck-logs', 'startup.log')
].filter((candidate) => path.isAbsolute(candidate))

let startupLogFile: string | null = null

function ensureStartupLogFile(): string | null {
  if (startupLogFile) return startupLogFile
  const failures: string[] = []
  for (const candidate of STARTUP_LOG_CANDIDATES) {
    try {
      fsSync.mkdirSync(path.dirname(candidate), { recursive: true })
      fsSync.appendFileSync(candidate, '')
      startupLogFile = candidate
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || 'unknown'
      failures.push(`${candidate} => ${code} ${(error as Error).message}`)
    }
  }
  if (startupLogFile) {
    try {
      fsSync.appendFileSync(
        startupLogFile,
        [
          `[log] file=${startupLogFile}`,
          `[log] APPDATA=${process.env.APPDATA || ''}`,
          `[log] USERPROFILE=${process.env.USERPROFILE || ''}`,
          `[log] TEMP=${process.env.TEMP || ''}`,
          ...failures.map((failure) => `[log] failed: ${failure}`)
        ].join('\n') + '\n'
      )
    } catch {
      // ignore
    }
  }
  return startupLogFile
}

function startupLog(scope: string, message: string): void {
  const target = ensureStartupLogFile()
  if (!target) return
  try {
    fsSync.appendFileSync(
      target,
      `[${new Date().toISOString()}] [${scope}] ${message}\n`,
      'utf8'
    )
  } catch {
    // 启动日志不能影响主流程
  }
}

startupLog(
  'boot',
  `exe=${process.execPath} cwd=${process.cwd()} resources=${process.resourcesPath} packaged=${app.isPackaged} argv=${JSON.stringify(process.argv)}`
)
startupLog(
  'boot',
  `app.asar=${fsSync.existsSync(path.join(process.resourcesPath || '', 'app.asar'))} app-dir=${fsSync.existsSync(path.join(process.resourcesPath || '', 'app'))}`
)
process.on('uncaughtException', (error) => {
  startupLog('uncaught', error.stack || String(error))
})
process.on('unhandledRejection', (reason) => {
  startupLog('rejection', reason instanceof Error ? reason.stack || reason.message : String(reason))
})
app.on('child-process-gone', (_event, details) => {
  startupLog('child-process-gone', JSON.stringify(details))
})

app.setName('ModDeck')
if (SCAN_REPORT) {
  app.setPath('userData', path.join(process.cwd(), 'temp', 'scan-data'))
}
function canWriteDirectory(dir: string): boolean {
  try {
    fsSync.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${process.pid}`)
    fsSync.writeFileSync(probe, 'ok')
    fsSync.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

if (SMOKE_TEST) {
  app.setPath('userData', path.join(process.cwd(), 'temp', 'smoke-data'))
  try {
    fsSync.mkdirSync(SMOKE_DIR, { recursive: true })
    fsSync.writeFileSync(
      path.join(SMOKE_DIR, 'smoke-boot.json'),
      JSON.stringify(
        {
          argv: process.argv,
          cwd: process.cwd(),
          electron: process.versions.electron,
          chrome: process.versions.chrome
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error('smoke boot write failed', error)
  }
}

function configureUserData(): void {
  if (SMOKE_TEST || SCAN_REPORT) return
  try {
    const defaultUserData = app.getPath('userData')
    if (canWriteDirectory(defaultUserData)) {
      startupLog('userData', `default ${defaultUserData}`)
      return
    }
  } catch (error) {
    startupLog('userData', `default-path-failed ${String(error)}`)
  }

  const fallbacks = [
    path.join(path.dirname(process.execPath), 'ModDeck-data'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'ModDeck-data'),
    path.join(process.cwd(), 'ModDeck-data')
  ]
  for (const candidate of fallbacks) {
    if (!canWriteDirectory(candidate)) continue
    app.setPath('userData', candidate)
    startupLog('userData', `fallback ${candidate}`)
    return
  }
  startupLog('userData', 'no-writable-location')
}

function prepareUserData(): void {
  if (SMOKE_TEST || SCAN_REPORT) return
  const appData = process.env.APPDATA || ''
  const defaultDir = appData ? path.join(appData, 'ModDeck') : ''
  if (defaultDir && canWriteDirectory(defaultDir)) return

  const fallbacks = [
    path.join(path.dirname(process.execPath), 'ModDeck-data'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'ModDeck-data'),
    path.join(process.cwd(), 'ModDeck-data')
  ]
  for (const candidate of fallbacks) {
    if (!canWriteDirectory(candidate)) continue
    app.setPath('userData', candidate)
    startupLog('userData', `early-fallback ${candidate}`)
    return
  }
}

prepareUserData()

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let settings: Settings
let metadata: MetadataStore
let mainWindow: BrowserWindow | null = null

function baseDir(): string {
  return app.getPath('userData')
}

function assetUrl(absolutePath: string): string {
  const encoded = Buffer.from(absolutePath, 'utf8').toString('base64url')
  return `${SCHEME}://asset/?p=${encoded}`
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.avif') return 'image/avif'
  return 'image/jpeg'
}

function isAllowedAsset(filePath: string): boolean {
  if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(filePath)) return false
  const roots = [path.join(baseDir(), 'covers')]
  for (const game of Object.values(settings.games)) {
    if (game?.modsPath) roots.push(game.modsPath)
  }
  return roots.some((root) => isInside(root, filePath))
}

async function ensureRosterInitialized(gameId: GameId, modsPath: string): Promise<void> {
  if (metadata.rosterInitialized?.[gameId]) return
  if (!modsPath) return
  if (!(await pathExists(modsPath))) return
  try {
    const folders = await listCharacterFolderNames(modsPath)
    metadata = markRosterInitialized(metadata, gameId, folders)
    await saveMetadata(baseDir(), metadata)
  } catch (error) {
    logError('roster-init', error)
  }
}

async function makeSnapshot(gameId: GameId) {
  const game = requireGame(gameId)
  const gameSettings = settings.games[gameId] ?? { modsPath: '' }
  await ensureRosterInitialized(gameId, gameSettings.modsPath)
  return buildSnapshot(game, gameSettings, metadata, {
    coverUrlFor: (meta) => {
      const absolute = coverPath(baseDir(), meta)
      return absolute ? assetUrl(absolute) : null
    },
    showHidden: settings.ui.showHidden,
    sortCharacters: settings.ui.sortCharacters
  })
}

async function writeScanReport(): Promise<void> {
  const games: Array<Record<string, unknown>> = []
  for (const game of GAMES) {
    const gameSettings = settings.games[game.id] ?? { modsPath: '' }
    await ensureRosterInitialized(game.id, gameSettings.modsPath)
    const startedAt = Date.now()
    const snapshot = await buildSnapshot(game, gameSettings, metadata, {
      coverUrlFor: (meta) => {
        const absolute = coverPath(baseDir(), meta)
        return absolute ? assetUrl(absolute) : null
      },
      showHidden: settings.ui.showHidden,
      sortCharacters: settings.ui.sortCharacters
    })
    games.push({
      id: game.id,
      name: game.name,
      modsPath: gameSettings.modsPath,
      exists: snapshot.modsPathExists,
      elapsedMs: Date.now() - startedAt,
      totalMods: snapshot.totalMods,
      enabledMods: snapshot.enabledMods,
      characters: snapshot.characters.map((character) => ({
        folder: character.folder,
        displayName: character.displayName,
        modCount: character.modCount,
        enabledCount: character.enabledCount,
        known: character.known,
        hasCover: character.hasCover
      }))
    })
  }

  await fs.writeFile(
    path.join(process.cwd(), 'scan-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), games }, null, 2)
  )
}

function logError(scope: string, error: unknown): void {
  const message = error instanceof Error ? `${error.stack || error.message}` : String(error)
  console.error(`[${scope}]`, error)
  fs.appendFile(
    path.join(baseDir(), 'logs', 'moddeck.log'),
    `[${new Date().toISOString()}] [${scope}] ${message}\n`
  ).catch(() => undefined)
}

function register(channel: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      logError(channel, error)
      throw error
    }
  })
}

async function openDialog(
  options: Electron.OpenDialogOptions
): Promise<string | null> {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

async function openInShell(target: string): Promise<ToggleResult> {
  if (!target) return { ok: false, error: '路径为空' }
  if (!(await pathExists(target))) return { ok: false, error: `路径不存在: ${target}` }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true }
}

function registerIpc(): void {
  register(IPC.bootstrap, async () => ({
    settings,
    games: GAMES,
    snapshot: await makeSnapshot(settings.activeGameId),
    appVersion: app.getVersion()
  }))

  register(IPC.appInfo, async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    userData: baseDir()
  }))

  register(IPC.saveSettings, async (patch: SettingsPatch) => {
    settings = mergeSettings(settings, patch ?? {})
    await saveSettings(baseDir(), settings)
    return settings
  })

  register(IPC.switchGame, async (gameId: GameId) => {
    requireGame(gameId)
    settings = mergeSettings(settings, { activeGameId: gameId })
    await saveSettings(baseDir(), settings)
    return makeSnapshot(gameId)
  })

  register(IPC.scanGame, async (gameId: GameId) => {
    requireGame(gameId)
    return makeSnapshot(gameId)
  })

  register(IPC.getMods, async (gameId: GameId, characterFolder: string) => {
    requireGame(gameId)
    const gameSettings = settings.games[gameId]
    if (!gameSettings?.modsPath) return []
    if (!isSafeSegment(characterFolder)) throw new Error('角色目录名不合法')
    return listMods(
      gameSettings.modsPath,
      gameId,
      characterFolder,
      assetUrl,
      settings.ui.sortMods
    )
  })

  register(
    IPC.toggleMod,
    async (
      gameId: GameId,
      characterFolder: string,
      modFolder: string,
      enable: boolean
    ): Promise<ToggleResult> => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      const baseName = String(modFolder || '').replace(/^DISABLED_/i, '')
      if (!isSafeSegment(baseName)) return { ok: false, error: 'Mod 名称不合法' }

      const currentName = enable ? `DISABLED_${baseName}` : baseName
      const nextName = enable ? baseName : `DISABLED_${baseName}`
      const currentPath = path.join(characterDir, currentName)
      const nextPath = path.join(characterDir, nextName)
      if (!(await pathExists(currentPath))) return { ok: false, error: 'Mod 目录不存在' }
      if (await pathExists(nextPath)) return { ok: false, error: '目标目录已存在' }

      let lastError: unknown = null
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.rename(currentPath, nextPath)
          return { ok: true }
        } catch (error) {
          lastError = error
          await new Promise((resolve) => setTimeout(resolve, 80))
        }
      }
      const code = (lastError as NodeJS.ErrnoException)?.code
      return {
        ok: false,
        error:
          code === 'EPERM' || code === 'EBUSY'
            ? '目录被占用，请关闭游戏或占用的程序后重试'
            : lastError instanceof Error
              ? lastError.message
              : String(lastError)
      }
    }
  )

  register(
    IPC.deleteMod,
    async (gameId: GameId, characterFolder: string, modFolder: string): Promise<ToggleResult> => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      if (!isSafeSegment(modFolder)) return { ok: false, error: 'Mod 名称不合法' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      const target = path.join(characterDir, modFolder)
      if (!isInside(characterDir, target)) return { ok: false, error: '路径越界' }
      if (!(await pathExists(target))) return { ok: false, error: '目录不存在' }
      await shell.trashItem(target)
      return { ok: true }
    }
  )

  register(
    IPC.openModFolder,
    async (gameId: GameId, characterFolder: string, modFolder: string) => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      if (!isSafeSegment(modFolder)) return { ok: false, error: 'Mod 名称不合法' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      return openInShell(path.join(characterDir, modFolder))
    }
  )

  register(
    IPC.openCharacterFolder,
    async (gameId: GameId, characterFolder: string) => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      return openInShell(characterDir)
    }
  )

  register(IPC.openPath, async (kind: string, gameId?: GameId) => {
    if (kind === 'data') return openInShell(baseDir())
    if (kind === 'logs') return openInShell(path.join(baseDir(), 'logs'))
    if (!gameId) return { ok: false, error: '缺少游戏参数' }
    const gameSettings = settings.games[gameId]
    if (!gameSettings) return { ok: false, error: '未知游戏' }
    if (kind === 'mods') return openInShell(gameSettings.modsPath)
    if (kind === 'game') return openInShell(gameSettings.gamePath ?? '')
    if (kind === 'loader') return openInShell(gameSettings.loaderPath ?? '')
    return { ok: false, error: '未知路径类型' }
  })

  register(IPC.pickModsFolder, async () =>
    openDialog({ title: '选择 Mods 目录', properties: ['openDirectory', 'createDirectory'] })
  )

  register(IPC.pickGameExe, async () =>
    openDialog({
      title: '选择游戏可执行文件',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }]
    })
  )

  register(IPC.pickLoader, async () =>
    openDialog({
      title: '选择启动器',
      properties: ['openFile'],
      filters: [{ name: '启动器', extensions: ['exe', 'cmd', 'bat'] }]
    })
  )

  register(IPC.pickImportFiles, async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: '选择要导入的 Mod 压缩包',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '压缩包', extensions: ['zip', '7z', 'rar'] }]
        })
      : await dialog.showOpenDialog({
          title: '选择要导入的 Mod 压缩包',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '压缩包', extensions: ['zip', '7z', 'rar'] }]
        })
    return result.canceled ? [] : result.filePaths
  })

  register(IPC.pickImportFolder, async () =>
    openDialog({ title: '选择 Mod 文件夹', properties: ['openDirectory'] })
  )

  register(IPC.pickCover, async () =>
    openDialog({
      title: '选择角色封面',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    })
  )

  register(IPC.importRun, async (request: ImportRequest) => {
    const result = await runImport(
      { baseDir: baseDir(), settings, metadata },
      request
    )
    return result
  })

  register(
    IPC.updateCharacterMeta,
    async (gameId: GameId, characterFolder: string, patch: Record<string, unknown>) => {
      requireGame(gameId)
      if (!isSafeSegment(characterFolder)) throw new Error('角色目录名不合法')
      const current = getCharacterMeta(metadata, gameId, characterFolder)
      metadata = setCharacterMeta(metadata, gameId, characterFolder, {
        ...current,
        ...(patch as Partial<CharacterMeta>)
      })
      await saveMetadata(baseDir(), metadata)
      return makeSnapshot(gameId)
    }
  )

  register(IPC.setCharacterCover, async (gameId: GameId, characterFolder: string) => {
    requireGame(gameId)
    if (!isSafeSegment(characterFolder)) return { ok: false, error: '角色目录名不合法' }
    const source = await openDialog({
      title: '选择角色封面',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    })
    if (!source) return { ok: false, error: '已取消' }
    const coverFile = await saveCover(baseDir(), gameId, characterFolder, source)
    const current = getCharacterMeta(metadata, gameId, characterFolder)
    metadata = setCharacterMeta(metadata, gameId, characterFolder, { ...current, coverFile })
    await saveMetadata(baseDir(), metadata)
    return { ok: true }
  })

  register(IPC.resetCharacterMeta, async (gameId: GameId, characterFolder: string) => {
    requireGame(gameId)
    if (!isSafeSegment(characterFolder)) throw new Error('角色目录名不合法')
    metadata = removeCharacterMeta(metadata, gameId, characterFolder)
    await saveMetadata(baseDir(), metadata)
    return makeSnapshot(gameId)
  })

}

function createWindow(): void {
  startupLog('window', 'creating')
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'ModDeck',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  startupLog('window', 'created')
  mainWindow.once('ready-to-show', () => {
    startupLog('window', 'ready-to-show')
    mainWindow?.show()
  })
  mainWindow.webContents.once('did-finish-load', () => startupLog('window', 'did-finish-load'))
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    startupLog('window', `did-fail-load code=${code} desc=${description} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    startupLog('window', `render-process-gone ${JSON.stringify(details)}`)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl).catch((error) => logError('load-url', error))
  } else {
    mainWindow
      .loadFile(path.join(__dirname, '../renderer/index.html'))
      .catch((error) => logError('load-file', error))
  }

  if (SMOKE_TEST) {
    fsSync.mkdirSync(SMOKE_DIR, { recursive: true })
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      fsSync.writeFileSync(
        path.join(SMOKE_DIR, 'smoke-error.txt'),
        `render-process-gone: ${JSON.stringify(details)}`
      )
    })
    const timeout = setTimeout(() => {
      fsSync.writeFileSync(path.join(SMOKE_DIR, 'smoke-error.txt'), 'SMOKE_TIMEOUT')
      console.error('SMOKE_TIMEOUT')
      app.exit(1)
    }, 25_000)
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        const bodyText = async () =>
          String(
            await mainWindow?.webContents.executeJavaScript(
              'document.body.innerText.slice(0, 1200)'
            )
          )
        const click = async (selector: string) => {
          await mainWindow?.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(selector)})?.click()`
          )
          await delay(900)
        }
        const shot = async (name: string) => {
          const image = await mainWindow?.webContents.capturePage()
          if (image && !image.isEmpty()) {
            await fs.writeFile(path.join(SMOKE_DIR, name), image.toPNG())
          }
          return Boolean(image && !image.isEmpty())
        }
        try {
          const libraryText = await bodyText()
          await shot('smoke.png')

          await click('.char-card')
          const characterText = await bodyText()
          const characterShot = await shot('smoke-character.png')

          await click('.back-link')
          await click('.side-action')
          const settingsText = await bodyText()
          const settingsShot = await shot('smoke-settings.png')

          const importSource = path.join(
            process.cwd(),
            'temp',
            'fixture',
            'import-source',
            'TestImport'
          )
          const importResult = await mainWindow?.webContents.executeJavaScript(
            `window.moddeck.importRun({ gameId: 'wuthering-waves', folderPaths: [${JSON.stringify(
              importSource
            )}], targetCharacter: '测试角色A' })`
          )
          const importedMods = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.getMods('wuthering-waves', '测试角色A')"
          )
          const toggleOff = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.toggleMod('wuthering-waves', '测试角色A', 'TestImport', false)"
          )
          const afterOff = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.getMods('wuthering-waves', '测试角色A')"
          )
          const toggleOn = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.toggleMod('wuthering-waves', '测试角色A', 'TestImport', true)"
          )

          const metaUpdated = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.updateCharacterMeta('wuthering-waves', '测试角色A', { displayName: '测试角色A改', aliases: ['TestA'], order: 7 })"
          )
          const metaUpdatedName = metaUpdated?.characters?.find(
            (entry: { folder: string }) => entry.folder === '测试角色A'
          )?.displayName
          const metaReset = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.resetCharacterMeta('wuthering-waves', '测试角色A')"
          )
          const metaResetName = metaReset?.characters?.find(
            (entry: { folder: string }) => entry.folder === '测试角色A'
          )?.displayName

          await fs.writeFile(
            path.join(SMOKE_DIR, 'smoke-result.json'),
            JSON.stringify(
              {
                ok: true,
                libraryText,
                characterText,
                settingsText,
                images: { library: true, character: characterShot, settings: settingsShot },
                importResult,
                importedMods,
                toggleOff,
                afterOff,
                toggleOn,
                metaUpdatedName,
                metaResetName
              },
              null,
              2
            )
          )
          console.log('SMOKE_OK')
          clearTimeout(timeout)
        } catch (error) {
          fsSync.writeFileSync(
            path.join(SMOKE_DIR, 'smoke-error.txt'),
            `capture failed: ${error instanceof Error ? error.stack : String(error)}`
          )
          console.error('SMOKE_CAPTURE_FAILED', error)
        }
        setTimeout(() => app.quit(), 300)
      }, 1200)
    })
    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[renderer] ${message}`)
    })
  }
}

async function bootstrap(): Promise<void> {
  startupLog('bootstrap', 'start')
  configureUserData()
  await ensureDir(baseDir())
  await ensureDir(path.join(baseDir(), 'logs'))
  await ensureDir(path.join(baseDir(), 'covers'))
  settings = await loadSettings(baseDir())
  metadata = await loadMetadata(baseDir())
  startupLog('bootstrap', `settings-loaded userData=${baseDir()}`)

  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'asset') return new Response('Not found', { status: 404 })
      const encoded = url.searchParams.get('p')
      if (!encoded) return new Response('Bad request', { status: 400 })
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8')
      if (!isAllowedAsset(filePath)) return new Response('Forbidden', { status: 403 })
      let response: Response | null = null
      try {
        response = await net.fetch(pathToFileURL(filePath).toString())
      } catch {
        response = null
      }
      if (response?.ok) return response
      const data = await fs.readFile(filePath)
      return new Response(new Uint8Array(data), {
        headers: { 'content-type': mimeFor(filePath) }
      })
    } catch (error) {
      logError('protocol', error)
      return new Response('Internal error', { status: 500 })
    }
  })

  registerIpc()
  startupLog('bootstrap', 'ipc-ready')

  if (SCAN_REPORT) {
    try {
      await writeScanReport()
      console.log('SCAN_REPORT_OK')
      app.quit()
    } catch (error) {
      logError('scan-report', error)
      app.exit(1)
    }
    return
  }

  createWindow()
  startupLog('bootstrap', 'window-created')
}

app.whenReady().then(() => {
  startupLog('app', 'ready')
  app.setAppUserModelId(APP_ID)
  bootstrap().catch((error) => {
    startupLog('bootstrap', `failed ${error instanceof Error ? error.stack || error.message : String(error)}`)
    logError('bootstrap', error)
    if (SMOKE_TEST) app.exit(1)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

const gotLock = SMOKE_TEST || SCAN_REPORT || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
