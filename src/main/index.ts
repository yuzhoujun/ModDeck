import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  shell,
  Tray
} from 'electron'
import type {
  AppInfo,
  CharacterMeta,
  CreateCharacterInput,
  EnvironmentCheck,
  GameId,
  ImportCommitRequest,
  ImportParseRequest,
  ImportRequest,
  OverlayDetailRequest,
  Settings,
  SettingsPatch,
  ToggleResult
} from '../shared/types'
import { IPC, type StateChangedEvent } from '../shared/ipc'
import { GAMES, requireGame } from './core/games'
import { ensureDir, pathExists } from './core/fsx'
import { isInside, isSafeSegment } from './core/safe-path'
import {
  loadSettings,
  mergeSettings,
  normalizeModsPath,
  saveSettings
} from './services/settings'
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
  applyModPreset,
  deleteModPreset,
  getModPresets,
  saveModPreset
} from './services/presets'
import {
  buildSnapshot,
  getModDetails,
  invalidatePreviewCache,
  listCharacterFolderNames,
  listMods,
  resolveCharacterBase,
  resolveCharacterDir
} from './services/library'
import {
  commitImportSession,
  discardImportSession,
  parseImportSources,
  runImport
} from './services/imports'
import {
  getRosterMap,
  getRosterStatus,
  loadRosterCache,
  syncRemoteRoster
} from './core/roster'
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

function userDataFallbacks(): string[] {
  const list = [
    path.join(path.dirname(process.execPath), 'ModDeck-data'),
    path.join(process.cwd(), 'ModDeck-data')
  ]
  if (process.env.PUBLIC) list.splice(1, 0, path.join(process.env.PUBLIC, 'ModDeck-data'))
  return list
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

  for (const candidate of userDataFallbacks()) {
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

  for (const candidate of userDataFallbacks()) {
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
let overlayWindow: BrowserWindow | null = null
let overlayDetailWindow: BrowserWindow | null = null
let autoReloadTimer: NodeJS.Timeout | null = null
let modsWatcher: fsSync.FSWatcher | null = null
let watchedModsPath = ''
let watchDebounceTimer: NodeJS.Timeout | null = null
let suppressWatcherUntil = 0
let tray: Tray | null = null
let isQuitting = false

function broadcastStateChanged(payload: StateChangedEvent = {}): void {
  for (const win of [mainWindow, overlayWindow, overlayDetailWindow]) {
    if (!win || win.isDestroyed()) continue
    try {
      win.webContents.send(IPC.stateChanged, payload)
    } catch {
      // ignore
    }
  }
}

function markInternalFsMutation(): void {
  suppressWatcherUntil = Date.now() + 500
}

function refreshModsWatcher(): void {
  if (SMOKE_TEST || SCAN_REPORT) return
  const activeGameId = settings?.activeGameId
  const modsPath = activeGameId ? settings?.games?.[activeGameId]?.modsPath ?? '' : ''
  if (modsPath === watchedModsPath && modsWatcher) return

  if (modsWatcher) {
    try {
      modsWatcher.close()
    } catch {
      // ignore
    }
    modsWatcher = null
  }
  watchedModsPath = ''

  if (!modsPath || !fsSync.existsSync(modsPath)) return
  try {
    modsWatcher = fsSync.watch(modsPath, { recursive: false }, () => {
      if (Date.now() < suppressWatcherUntil) return
      if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
      watchDebounceTimer = setTimeout(() => {
        watchDebounceTimer = null
        broadcastStateChanged({ gameId: settings?.activeGameId })
      }, 280)
    })
    modsWatcher.on('error', () => {
      try {
        modsWatcher?.close()
      } catch {
        // ignore
      }
      modsWatcher = null
      watchedModsPath = ''
    })
    watchedModsPath = modsPath
  } catch {
    modsWatcher = null
    watchedModsPath = ''
  }
}

function baseDir(): string {
  return app.getPath('userData')
}

function assetUrl(absolutePath: string): string {
  const encoded = Buffer.from(absolutePath, 'utf8').toString('base64url')
  let stamp = 0
  try {
    stamp = Math.floor(fsSync.statSync(absolutePath).mtimeMs)
  } catch {
    // ignore
  }
  return `${SCHEME}://asset/?p=${encoded}${stamp ? `&t=${stamp}` : ''}`
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
    assetUrl,
    showHidden: settings.ui.showHidden,
    sortCharacters: settings.ui.sortCharacters,
    characterOrder: settings.characterOrders[gameId] ?? []
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
      assetUrl,
      showHidden: settings.ui.showHidden,
      sortCharacters: settings.ui.sortCharacters,
      characterOrder: settings.characterOrders[game.id] ?? []
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

function splitArgs(value: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return args
}

async function launchConfigured(
  gameId: GameId,
  kind: 'game' | 'loader'
): Promise<{ ok: boolean; error?: string; path?: string }> {
  requireGame(gameId)
  const gameSettings = settings.games[gameId]
  if (!gameSettings) return { ok: false, error: '未知游戏' }
  const target = kind === 'game' ? gameSettings.gamePath : gameSettings.loaderPath
  const label = kind === 'game' ? '游戏程序' : '启动器'
  if (!target) return { ok: false, error: `未配置${label}` }
  if (!(await pathExists(target))) return { ok: false, error: `${label}不存在: ${target}` }

  const args = kind === 'game' ? splitArgs(gameSettings.launchArgs || '') : []
  try {
    const extension = path.extname(target).toLowerCase()
    const child =
      extension === '.cmd' || extension === '.bat'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', target, ...args], {
            cwd: path.dirname(target),
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          })
        : spawn(target, args, {
            cwd: path.dirname(target),
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          })
    child.on('error', (error) => logError('launch', error))
    child.unref()
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const OVERLAY_TOP_LEVEL = 'screen-saver' as const

function raiseOverlayWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || !settings.ui.overlayPinned) return
  // 重新声明 topmost，避免游戏切回独占/无边框全屏后 z-order 失效。
  win.setAlwaysOnTop(false)
  win.setAlwaysOnTop(true, OVERLAY_TOP_LEVEL)
  win.moveTop()
}

function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  overlayWindow = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 380,
    minHeight: 420,
    show: false,
    frame: false,
    resizable: true,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: settings.ui.overlayPinned,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    title: 'ModDeck Quick',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  overlayWindow.setAlwaysOnTop(settings.ui.overlayPinned, OVERLAY_TOP_LEVEL)
  overlayWindow.on('focus', () => raiseOverlayWindow(overlayWindow))
  overlayWindow.on('show', () => raiseOverlayWindow(overlayWindow))
  overlayWindow.on('closed', () => {
    overlayDetailWindow?.destroy()
    overlayDetailWindow = null
    overlayWindow = null
  })
  overlayWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      overlayWindow?.hide()
      overlayDetailWindow?.hide()
      _event.preventDefault()
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    overlayWindow.loadURL(`${devUrl}?mode=overlay`).catch((error) => logError('overlay', error))
  } else {
    overlayWindow
      .loadFile(path.join(__dirname, '../renderer/index.html'), { query: { mode: 'overlay' } })
      .catch((error) => logError('overlay', error))
  }
  return overlayWindow
}

function toggleOverlay(): void {
  const win = createOverlayWindow()
  if (win.isVisible()) {
    const detailFocused = Boolean(overlayDetailWindow?.isFocused())
    if (!win.isFocused() && !detailFocused) {
      // 窗口被游戏或其他程序盖住时，先重新抬起，而不是“隐藏”到看不见。
      win.show()
      win.focus()
      raiseOverlayWindow(win)
      return
    }
    win.hide()
    overlayDetailWindow?.hide()
    return
  }
  win.setAlwaysOnTop(settings.ui.overlayPinned, OVERLAY_TOP_LEVEL)
  win.center()
  win.show()
  win.focus()
  raiseOverlayWindow(win)
}

function placeOverlayDetail(): void {
  if (!overlayWindow || !overlayDetailWindow || overlayDetailWindow.isDestroyed()) return
  const bounds = overlayWindow.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const width = 320
  const height = Math.min(460, area.height - 24)
  const rightSpace = area.x + area.width - (bounds.x + bounds.width)
  const leftSpace = bounds.x - area.x

  let x: number
  if (rightSpace >= width + 12) x = bounds.x + bounds.width + 10
  else if (leftSpace >= width + 12) x = bounds.x - width - 10
  else x = rightSpace >= leftSpace ? bounds.x + bounds.width + 10 : bounds.x - width - 10

  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8))
  const y = Math.max(area.y + 8, Math.min(bounds.y, area.y + area.height - height - 8))
  overlayDetailWindow.setBounds({ x, y, width, height })
}

function loadOverlayDetail(win: BrowserWindow, request: OverlayDetailRequest): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const query = new URLSearchParams({
      mode: 'overlay-detail',
      gameId: request.gameId,
      character: request.characterFolder,
      mod: request.modFolder
    })
    win.loadURL(`${devUrl}?${query.toString()}`).catch((error) => logError('overlay-detail', error))
  } else {
    win
      .loadFile(path.join(__dirname, '../renderer/index.html'), {
        query: {
          mode: 'overlay-detail',
          gameId: request.gameId,
          character: request.characterFolder,
          mod: request.modFolder
        }
      })
      .catch((error) => logError('overlay-detail', error))
  }
}

function showOverlayDetail(request: OverlayDetailRequest): void {
  if (!overlayWindow) return
  if (!overlayDetailWindow || overlayDetailWindow.isDestroyed()) {
    overlayDetailWindow = new BrowserWindow({
      width: 320,
      height: 460,
      minWidth: 280,
      minHeight: 300,
      show: false,
      frame: false,
      resizable: true,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: settings.ui.overlayPinned,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      title: 'ModDeck Hotkeys',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    overlayDetailWindow.setAlwaysOnTop(settings.ui.overlayPinned, OVERLAY_TOP_LEVEL)
    overlayDetailWindow.on('focus', () => raiseOverlayWindow(overlayDetailWindow))
    overlayDetailWindow.on('show', () => raiseOverlayWindow(overlayDetailWindow))
    overlayDetailWindow.on('closed', () => {
      overlayDetailWindow = null
    })
    overlayDetailWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        overlayDetailWindow?.hide()
        _event.preventDefault()
      }
    })
  }

  loadOverlayDetail(overlayDetailWindow, request)
  placeOverlayDetail()
  // 不用 show()+focus()：侧栏抢焦点会让全屏游戏/主面板失焦。
  overlayDetailWindow.showInactive()
  raiseOverlayWindow(overlayDetailWindow)
}

function hideOverlayDetail(): void {
  overlayDetailWindow?.hide()
}

type KeyPlan = { modifiers: number[]; keys: number[]; released: number[] }

const MOUSE_KEYS = new Set([
  'LBUTTON',
  'RBUTTON',
  'MBUTTON',
  'XBUTTON1',
  'XBUTTON2',
  'XB1',
  'XB2'
])

const VK_KEYS: Record<string, number> = {
  BACK: 0x08,
  BACKSPACE: 0x08,
  TAB: 0x09,
  RETURN: 0x0d,
  ENTER: 0x0d,
  SHIFT: 0x10,
  CONTROL: 0x11,
  CTRL: 0x11,
  MENU: 0x12,
  ALT: 0x12,
  PAUSE: 0x13,
  CAPITAL: 0x14,
  CAPSLOCK: 0x14,
  ESCAPE: 0x1b,
  ESC: 0x1b,
  SPACE: 0x20,
  SPACEBAR: 0x20,
  PRIOR: 0x21,
  PAGEUP: 0x21,
  PGUP: 0x21,
  NEXT: 0x22,
  PAGEDOWN: 0x22,
  PGDN: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  SNAPSHOT: 0x2c,
  PRINTSCREEN: 0x2c,
  INSERT: 0x2d,
  INS: 0x2d,
  DELETE: 0x2e,
  DEL: 0x2e,
  LWIN: 0x5b,
  RWIN: 0x5c,
  APPS: 0x5d,
  NUMPAD0: 0x60,
  NUMPAD1: 0x61,
  NUMPAD2: 0x62,
  NUMPAD3: 0x63,
  NUMPAD4: 0x64,
  NUMPAD5: 0x65,
  NUMPAD6: 0x66,
  NUMPAD7: 0x67,
  NUMPAD8: 0x68,
  NUMPAD9: 0x69,
  MULTIPLY: 0x6a,
  ADD: 0x6b,
  SEPARATOR: 0x6c,
  SUBTRACT: 0x6d,
  DECIMAL: 0x6e,
  DIVIDE: 0x6f,
  NUMLOCK: 0x90,
  SCROLL: 0x91,
  LSHIFT: 0xa0,
  RSHIFT: 0xa1,
  LCONTROL: 0xa2,
  RCONTROL: 0xa3,
  LCTRL: 0xa2,
  RCTRL: 0xa3,
  LMENU: 0xa4,
  RMENU: 0xa5,
  LALT: 0xa4,
  RALT: 0xa5,
  OEM_1: 0xba,
  OEM_PLUS: 0xbb,
  OEM_COMMA: 0xbc,
  OEM_MINUS: 0xbd,
  OEM_PERIOD: 0xbe,
  OEM_2: 0xbf,
  OEM_3: 0xc0,
  OEM_4: 0xdb,
  OEM_5: 0xdc,
  OEM_6: 0xdd,
  OEM_7: 0xde,
  OEM_8: 0xdf,
  OEM_102: 0xe2,
  PLUS: 0xbb,
  COMMA: 0xbc,
  MINUS: 0xbd,
  PERIOD: 0xbe
}

const PUNCTUATION_VK: Record<string, number> = {
  '/': 0xbf,
  '.': 0xbe,
  ',': 0xbc,
  ';': 0xba,
  "'": 0xde,
  '[': 0xdb,
  ']': 0xdd,
  '-': 0xbd,
  '=': 0xbb,
  '\\': 0xdc,
  '`': 0xc0
}

const SHIFTED_PUNCTUATION_VK: Record<string, number> = {
  '<': 0xbc,
  '>': 0xbe,
  '?': 0xbf,
  ':': 0xba,
  '"': 0xde,
  '{': 0xdb,
  '}': 0xdd,
  '|': 0xdc,
  '~': 0xc0,
  '_': 0xbd,
  '+': 0xbb,
  '!': 0x31,
  '@': 0x32,
  '#': 0x33,
  '$': 0x34,
  '%': 0x35,
  '^': 0x36,
  '&': 0x37,
  '*': 0x38,
  '(': 0x39,
  ')': 0x30
}

function vkForToken(token: string): { vk: number; shift?: boolean } | null {
  const raw = token.replace(/^VK_/i, '')
  const key = raw.toUpperCase()
  if (MOUSE_KEYS.has(key)) return null
  if (/^0X[0-9A-F]{1,2}$/.test(key)) {
    const parsed = Number.parseInt(key.slice(2), 16)
    if (parsed > 0 && parsed <= 0xff) return { vk: parsed }
  }
  if (/^[A-Z0-9]$/.test(key)) return { vk: key.charCodeAt(0) }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return { vk: 0x6f + Number(key.slice(1)) }
  }
  if (PUNCTUATION_VK[raw]) return { vk: PUNCTUATION_VK[raw] }
  if (SHIFTED_PUNCTUATION_VK[raw]) return { vk: SHIFTED_PUNCTUATION_VK[raw], shift: true }
  if (VK_KEYS[key] !== undefined) return { vk: VK_KEYS[key] }
  return null
}

function toKeyPlan(value: string): KeyPlan | null {
  const cleaned = String(value || '')
    .split(';')[0]
    .trim()
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const modifiers = new Set<number>()
  const released = new Set<number>()
  const keys: number[] = []
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'lctrl' || lower === 'rctrl' || lower === 'vk_ctrl' || lower === 'vk_control') {
      modifiers.add(0x11)
    } else if (lower === 'alt' || lower === 'lalt' || lower === 'ralt' || lower === 'menu' || lower === 'vk_alt' || lower === 'vk_menu') {
      modifiers.add(0x12)
    } else if (lower === 'shift' || lower === 'lshift' || lower === 'rshift' || lower === 'vk_shift') {
      modifiers.add(0x10)
    } else if (lower === 'win' || lower === 'lwin' || lower === 'rwin') {
      modifiers.add(0x5b)
    } else if (lower === 'no_modifiers') {
      released.add(0x10)
      released.add(0x11)
      released.add(0x12)
    } else if (lower === 'no_ctrl' || lower === 'no_control' || lower === 'no_vk_ctrl' || lower === 'no_vk_control') {
      released.add(0x11)
    } else if (lower === 'no_alt' || lower === 'no_menu' || lower === 'no_vk_alt' || lower === 'no_vk_menu') {
      released.add(0x12)
    } else if (lower === 'no_shift' || lower === 'no_vk_shift') {
      released.add(0x10)
    } else if (lower.startsWith('no_')) {
      continue
    } else {
      const resolved = vkForToken(token)
      if (!resolved) return null
      if (resolved.shift) modifiers.add(0x10)
      keys.push(resolved.vk)
    }
  }
  for (const mod of modifiers) {
    released.delete(mod)
  }
  if (keys.length === 0) return null
  return { modifiers: [...modifiers], keys, released: [...released] }
}

function gameProcessNamesForActiveGame(): string[] {
  const names = new Set<string>()
  const activeId = settings?.activeGameId
  const gamePath = activeId ? settings?.games?.[activeId]?.gamePath : undefined
  if (gamePath) {
    const base = path.basename(gamePath, path.extname(gamePath)).trim()
    if (base) names.add(base)
  }
  names.add('Endfield')
  names.add('Client-Win64-Shipping')
  names.add('Wuthering Waves')
  names.add('StarRail')
  names.add('ZenlessZoneZero')
  names.add('NTE')
  return [...names]
}

const KEY_HELPER_CS_SOURCE = `using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class ModDeckKeyHelper {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")]
  public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  public static bool IsExtended(byte vk) {
    return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0xA3 || vk == 0xA5;
  }

  public static void Down(byte vk) {
    byte scan = (byte)MapVirtualKey(vk, 0);
    uint flags = IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0u;
    keybd_event(vk, scan, flags, UIntPtr.Zero);
  }

  public static void Up(byte vk) {
    byte scan = (byte)MapVirtualKey(vk, 0);
    uint flags = KEYEVENTF_KEYUP | (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0u);
    keybd_event(vk, scan, flags, UIntPtr.Zero);
  }

  public static byte[] ParseList(string s) {
    if (string.IsNullOrEmpty(s)) return new byte[0];
    string[] parts = s.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
    byte[] res = new byte[parts.Length];
    for (int i = 0; i < parts.Length; i++) {
      res[i] = byte.Parse(parts[i]);
    }
    return res;
  }

  public static int Main(string[] args) {
    try {
      string procArg = args.Length > 0 ? args[0] : "";
      byte[] released = ParseList(args.Length > 1 ? args[1] : "");
      byte[] modifiers = ParseList(args.Length > 2 ? args[2] : "");
      byte[] keys = ParseList(args.Length > 3 ? args[3] : "");

      if (!string.IsNullOrEmpty(procArg)) {
        string[] names = procArg.Split(new char[] { '|' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string name in names) {
          Process[] procs = Process.GetProcessesByName(name);
          bool focused = false;
          foreach (Process p in procs) {
            if (p.MainWindowHandle != IntPtr.Zero) {
              IntPtr h = p.MainWindowHandle;
              if (IsIconic(h)) ShowWindowAsync(h, 9);
              SetForegroundWindow(h);
              Thread.Sleep(25);
              focused = true;
              break;
            }
          }
          if (focused) break;
        }
      }

      foreach (byte vk in released) Up(vk);
      if (released.Length > 0) Thread.Sleep(10);

      foreach (byte vk in modifiers) {
        Down(vk);
        Thread.Sleep(15);
      }
      foreach (byte vk in keys) {
        Down(vk);
        Thread.Sleep(15);
      }

      Thread.Sleep(60);

      for (int i = keys.Length - 1; i >= 0; i--) {
        Up(keys[i]);
        Thread.Sleep(15);
      }
      for (int i = modifiers.Length - 1; i >= 0; i--) {
        Up(modifiers[i]);
        Thread.Sleep(15);
      }
      return 0;
    } catch (Exception ex) {
      Console.Error.WriteLine(ex.Message);
      return 1;
    }
  }
}
`

let compiledKeyHelperPath: string | null = null
let compilingKeyHelperPromise: Promise<string | null> | null = null

async function ensureKeyHelperBinary(): Promise<string | null> {
  if (compiledKeyHelperPath && (await pathExists(compiledKeyHelperPath))) {
    return compiledKeyHelperPath
  }
  if (compilingKeyHelperPromise) return compilingKeyHelperPromise

  compilingKeyHelperPromise = (async () => {
    try {
      const binDir = path.join(baseDir(), 'bin')
      await ensureDir(binDir)
      const exePath = path.join(binDir, 'ModDeckKeyHelper-v2.exe')
      if (await pathExists(exePath)) {
        compiledKeyHelperPath = exePath
        return exePath
      }
      const csPath = path.join(binDir, 'ModDeckKeyHelper-v2.cs')
      await fs.writeFile(csPath, KEY_HELPER_CS_SOURCE, 'utf8')
      const windir = process.env.WINDIR || 'C:\\Windows'
      const cscCandidates = [
        path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
      ]
      let cscPath = ''
      for (const candidate of cscCandidates) {
        if (await pathExists(candidate)) {
          cscPath = candidate
          break
        }
      }
      if (!cscPath) return null

      await new Promise<void>((resolve, reject) => {
        execFile(
          cscPath,
          ['/nologo', '/target:exe', `/out:${exePath}`, '/optimize+', csPath],
          { windowsHide: true },
          (error, _stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message))
            else resolve()
          }
        )
      })
      if (await pathExists(exePath)) {
        compiledKeyHelperPath = exePath
        return exePath
      }
      return null
    } catch (error) {
      logError('compile-key-helper', error)
      return null
    } finally {
      compilingKeyHelperPromise = null
    }
  })()

  return compilingKeyHelperPromise
}

function keyPlanScript(plan: KeyPlan): string {
  const procNames = gameProcessNamesForActiveGame()
    .map((name) => `'${name.replace(/'/g, "''")}'`)
    .join(',')
  const csharp = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class ModDeckKey {',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
    '  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;',
    '  public const uint KEYEVENTF_KEYUP = 0x0002;',
    '  public static bool IsExtended(byte vk) {',
    '    return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0xA3 || vk == 0xA5;',
    '  }',
    '  public static void Down(byte vk) {',
    '    byte scan = (byte)MapVirtualKey(vk, 0);',
    '    uint flags = IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0u;',
    '    keybd_event(vk, scan, flags, UIntPtr.Zero);',
    '  }',
    '  public static void Up(byte vk) {',
    '    byte scan = (byte)MapVirtualKey(vk, 0);',
    '    uint flags = KEYEVENTF_KEYUP | (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0u);',
    '    keybd_event(vk, scan, flags, UIntPtr.Zero);',
    '  }',
    '}'
  ].join('\n')

  const lines = [
    "$ProgressPreference = 'SilentlyContinue'",
    `Add-Type -TypeDefinition @"\n${csharp}\n"@`,
    `$procs = Get-Process -Name @(${procNames}) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    'if ($procs) { $h = $procs.MainWindowHandle; if ([ModDeckKey]::IsIconic($h)) { [ModDeckKey]::ShowWindowAsync($h, 9) | Out-Null }; [ModDeckKey]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 25 }'
  ]
  for (const vk of plan.released) {
    lines.push(`[ModDeckKey]::Up(${vk})`)
  }
  if (plan.released.length > 0) {
    lines.push('Start-Sleep -Milliseconds 10')
  }
  for (const vk of plan.modifiers) {
    lines.push(`[ModDeckKey]::Down(${vk})`)
    lines.push('Start-Sleep -Milliseconds 15')
  }
  for (const vk of plan.keys) {
    lines.push(`[ModDeckKey]::Down(${vk})`)
    lines.push('Start-Sleep -Milliseconds 15')
  }
  lines.push('Start-Sleep -Milliseconds 60')
  for (const vk of [...plan.keys].reverse()) {
    lines.push(`[ModDeckKey]::Up(${vk})`)
    lines.push('Start-Sleep -Milliseconds 15')
  }
  for (const vk of [...plan.modifiers].reverse()) {
    lines.push(`[ModDeckKey]::Up(${vk})`)
    lines.push('Start-Sleep -Milliseconds 15')
  }
  return lines.join('\n')
}

async function executeKeyPlan(plan: KeyPlan): Promise<ToggleResult> {
  try {
    const helperExe = await ensureKeyHelperBinary()
    if (helperExe) {
      const procArg = gameProcessNamesForActiveGame().join('|')
      const relArg = plan.released.join(',')
      const modArg = plan.modifiers.join(',')
      const keyArg = plan.keys.join(',')
      await new Promise<void>((resolve, reject) => {
        execFile(
          helperExe,
          [procArg, relArg, modArg, keyArg],
          { windowsHide: true },
          (error, _stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message))
            else resolve()
          }
        )
      })
      return { ok: true }
    }

    const encoded = Buffer.from(keyPlanScript(plan), 'utf16le').toString('base64')
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { windowsHide: true },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr || error.message))
          else resolve()
        }
      )
    })
    return { ok: true }
  } catch (error) {
    logError('execute-key-plan', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function applyOverlayHotkey(value: string): { ok: boolean; error?: string } {
  globalShortcut.unregisterAll()
  const hotkey = String(value || '').trim()
  if (!hotkey) return { ok: true }
  try {
    const registered = globalShortcut.register(hotkey, () => toggleOverlay())
    if (!registered) {
      return { ok: false, error: '快捷键注册失败，可能被其他程序占用或格式无效' }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

const CHARACTER_COVER_FILE = '.preview.png'
const LEGACY_CHARACTER_COVERS = [
  '.preview.jpg',
  '.preview.jpeg',
  '.preview.webp',
  '_cover.png',
  '_cover.jpg',
  '_cover.jpeg',
  '_cover.webp'
]

async function characterDirFor(gameId: GameId, characterFolder: string): Promise<string> {
  requireGame(gameId)
  const gameSettings = settings.games[gameId]
  if (!gameSettings?.modsPath) throw new Error('未配置 Mods 目录')
  if (!isSafeSegment(characterFolder)) throw new Error('角色目录名不合法')
  return resolveCharacterDir(gameSettings.modsPath, characterFolder)
}

async function saveCharacterCoverData(
  gameId: GameId,
  characterFolder: string,
  dataUrl: string
): Promise<void> {
  const characterDir = await characterDirFor(gameId, characterFolder)
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''))
  if (!match) throw new Error('封面数据格式不正确')
  const buffer = Buffer.from(match[1], 'base64')
  if (buffer.length === 0) throw new Error('封面数据为空')
  if (buffer.length > 8 * 1024 * 1024) throw new Error('封面图片过大（>8MB）')

  const target = path.join(characterDir, CHARACTER_COVER_FILE)
  const temp = path.join(characterDir, `${CHARACTER_COVER_FILE}.tmp-${process.pid}`)
  await fs.writeFile(temp, buffer)
  await fs.rename(temp, target)

  const current = getCharacterMeta(metadata, gameId, characterFolder)
  const next = { ...current }
  delete next.coverFile
  metadata = setCharacterMeta(metadata, gameId, characterFolder, next)
  await saveMetadata(baseDir(), metadata)
}

async function clearCharacterCoverFiles(
  gameId: GameId,
  characterFolder: string
): Promise<void> {
  const characterDir = await characterDirFor(gameId, characterFolder)
  for (const name of [CHARACTER_COVER_FILE, ...LEGACY_CHARACTER_COVERS]) {
    await fs.rm(path.join(characterDir, name), { force: true }).catch(() => undefined)
  }
  const current = getCharacterMeta(metadata, gameId, characterFolder)
  const next = { ...current }
  delete next.coverFile
  metadata = setCharacterMeta(metadata, gameId, characterFolder, next)
  await saveMetadata(baseDir(), metadata)
}

async function recordRecentMod(
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  name: string
): Promise<void> {
  const limit = settings.ui.recentModCount
  if (limit <= 0) return
  const entry = {
    gameId,
    characterFolder,
    modFolder,
    name,
    at: Date.now()
  }
  settings = {
    ...settings,
    recentMods: [
      entry,
      ...settings.recentMods.filter(
        (item) =>
          !(
            item.gameId === gameId &&
            item.characterFolder === characterFolder &&
            item.name === name
          )
      )
    ].slice(0, limit)
  }
  await saveSettings(baseDir(), settings)
}

async function checkEnvironment(gameId?: GameId): Promise<EnvironmentCheck[]> {
  const targets = gameId ? [gameId] : GAMES.map((game) => game.id)
  const result: EnvironmentCheck[] = []
  for (const target of targets) {
    const gameSettings = settings.games[target]
    const modsPath = gameSettings?.modsPath ?? ''
    if (!modsPath) {
      result.push({
        gameId: target,
        modsPath,
        root: '',
        d3dxPath: '',
        status: 'no-root',
        detail: '未配置 Mods 目录'
      })
      continue
    }
    const root = path.dirname(modsPath)
    const d3dxPath = path.join(root, 'd3dx.ini')
    if (!(await pathExists(d3dxPath))) {
      result.push({
        gameId: target,
        modsPath,
        root,
        d3dxPath,
        status: 'missing-file',
        detail: '没有找到 EFMI 根目录下的 d3dx.ini'
      })
      continue
    }

    try {
      const text = await fs.readFile(d3dxPath, 'utf8')
      let ok = false
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.split(';')[0].trim()
        const match = line.match(/^exclude_recursive\s*=\s*(.+)$/i)
        if (!match) continue
        if (match[1].split(/\s+/).some((item) => /^DISABLED\*?$/i.test(item))) {
          ok = true
          break
        }
      }
      result.push({
        gameId: target,
        modsPath,
        root,
        d3dxPath,
        status: ok ? 'ok' : 'missing-line',
        detail: ok ? undefined : 'd3dx.ini 缺少 exclude_recursive = DISABLED*'
      })
    } catch (error) {
      result.push({
        gameId: target,
        modsPath,
        root,
        d3dxPath,
        status: 'missing-file',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

async function reloadF10(): Promise<ToggleResult> {
  const plan = toKeyPlan('F10')
  if (!plan) return { ok: false, error: '按键生成失败' }
  return executeKeyPlan(plan)
}

function scheduleAutoReload(): void {
  if (!settings.ui.autoReloadF10) return
  if (autoReloadTimer) clearTimeout(autoReloadTimer)
  autoReloadTimer = setTimeout(() => {
    autoReloadTimer = null
    void reloadF10().catch((error) => logError('auto-reload', error))
  }, 800)
}

async function toggleChildIniFiles(modPath: string, enable: boolean): Promise<number> {
  let count = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) await walk(full, depth - 1)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (enable) {
        if (/^disabled_/i.test(entry.name) && lower.endsWith('.ini')) {
          const restored = entry.name.replace(/^disabled_/i, '')
          await fs.rename(full, path.join(dir, restored))
          count += 1
        }
      } else {
        if (lower.endsWith('.ini') && !/^disabled_/i.test(entry.name) && lower !== 'desktop.ini') {
          await fs.rename(full, path.join(dir, `DISABLED_${entry.name}`))
          count += 1
        }
      }
    }
  }
  await walk(modPath, 3)
  return count
}

async function renameModAt(
  characterDir: string,
  modFolder: string,
  enable: boolean
): Promise<ToggleResult> {
  const baseName = String(modFolder || '').replace(/^DISABLED_/i, '')
  if (!isSafeSegment(baseName)) return { ok: false, error: 'Mod 名称不合法' }

  const currentName = enable ? `DISABLED_${baseName}` : baseName
  const nextName = enable ? baseName : `DISABLED_${baseName}`
  const currentPath = path.join(characterDir, currentName)
  const nextPath = path.join(characterDir, nextName)

  markInternalFsMutation()

  // 如果当前目录名由于之前文件级回退禁用还保持原名（例如启用时 currentPath 不存在而 nextPath 存在）
  if (await pathExists(nextPath)) {
    if (!(await pathExists(currentPath))) {
      try {
        await toggleChildIniFiles(nextPath, enable)
      } catch {
        // ignore
      }
      return { ok: true }
    }
    return { ok: false, error: '目标目录已存在' }
  }
  if (!(await pathExists(currentPath))) return { ok: false, error: 'Mod 目录不存在' }

  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(currentPath, nextPath)
      // 重命名目录成功后，若内部曾有被回退禁用的 .ini，恢复正常名称
      if (enable) {
        await toggleChildIniFiles(nextPath, true).catch(() => undefined)
      }
      return { ok: true }
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }

  // 当游戏/3DMigoto 持续占用该 Mod 下的子资源（如 GUI 贴图 res/*.png）导致外层目录无法重命名时，
  // 自动回退为重命名内部的 .ini 配置文件为 DISABLED_*.ini（配合 F10 即可立即生效，无需关游戏）
  try {
    const toggledCount = await toggleChildIniFiles(currentPath, enable)
    if (toggledCount > 0) {
      return { ok: true }
    }
  } catch (fallbackErr) {
    logError('toggle-ini-fallback', fallbackErr)
  }

  const code = (lastError as NodeJS.ErrnoException)?.code
  return {
    ok: false,
    error:
      code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        ? '目录被占用，请关闭游戏或占用的程序后重试'
        : lastError instanceof Error
          ? lastError.message
          : String(lastError)
  }
}

function registerIpc(): void {
  register(IPC.bootstrap, async () => ({
    settings,
    games: GAMES,
    snapshot: await makeSnapshot(settings.activeGameId),
    appVersion: app.getVersion(),
    rosterMap: getRosterMap()
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
    refreshModsWatcher()
    broadcastStateChanged({ gameId: settings.activeGameId })
    return settings
  })

  register(IPC.switchGame, async (gameId: GameId) => {
    requireGame(gameId)
    settings = mergeSettings(settings, { activeGameId: gameId })
    await saveSettings(baseDir(), settings)
    refreshModsWatcher()
    const snapshot = await makeSnapshot(gameId)
    broadcastStateChanged({ gameId })
    return snapshot
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
      settings.ui.sortMods,
      settings.modOrders[`${gameId}:${characterFolder}`] ?? []
    )
  })

  register(
    IPC.toggleMod,
    async (
      gameId: GameId,
      characterFolder: string,
      modFolder: string,
      enable: boolean,
      exclusive = false
    ): Promise<ToggleResult> => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      const baseName = String(modFolder || '').replace(/^DISABLED_/i, '')
      if (!isSafeSegment(baseName)) return { ok: false, error: 'Mod 名称不合法' }

      if (exclusive && enable) {
        const mods = await listMods(
          gameSettings.modsPath,
          gameId,
          characterFolder,
          assetUrl,
          'name'
        )
        for (const mod of mods) {
          if (!mod.enabled || mod.name === baseName) continue
          const result = await renameModAt(characterDir, mod.folderName, false)
          if (!result.ok) {
            return {
              ok: false,
              error: `关闭 ${mod.name} 失败：${result.error || '未知错误'}`
            }
          }
        }
      }

      const result = await renameModAt(characterDir, modFolder, enable)
      if (result.ok) {
        const recentFolder = enable ? baseName : `DISABLED_${baseName}`
        await recordRecentMod(gameId, characterFolder, recentFolder, baseName).catch((error) =>
          logError('recent', error)
        )
        broadcastStateChanged({ gameId, characterFolder })
        scheduleAutoReload()
      }
      return result
    }
  )

  register(
    IPC.setModsEnabled,
    async (
      gameId: GameId,
      characterFolder: string,
      folders: string[],
      enable: boolean
    ): Promise<ToggleResult> => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      for (const folder of Array.isArray(folders) ? folders : []) {
        const result = await renameModAt(characterDir, folder, enable)
        if (!result.ok) {
          broadcastStateChanged({ gameId, characterFolder })
          return result
        }
      }
      broadcastStateChanged({ gameId, characterFolder })
      scheduleAutoReload()
      return { ok: true }
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
      const baseName = modFolder.replace(/^DISABLED_/i, '')
      let target = path.join(characterDir, modFolder)
      if (!(await pathExists(target))) {
        const altFolder = /^DISABLED_/i.test(modFolder) ? baseName : `DISABLED_${baseName}`
        target = path.join(characterDir, altFolder)
      }
      if (!isInside(characterDir, target)) return { ok: false, error: '路径越界' }
      if (!(await pathExists(target))) return { ok: false, error: '目录不存在' }
      markInternalFsMutation()
      await shell.trashItem(target)
      const filteredRecent = settings.recentMods.filter(
        (item) =>
          !(
            item.gameId === gameId &&
            item.characterFolder === characterFolder &&
            item.name === baseName
          )
      )
      if (filteredRecent.length !== settings.recentMods.length) {
        settings = { ...settings, recentMods: filteredRecent }
        await saveSettings(baseDir(), settings).catch((error) => logError('recent-clean', error))
      }
      broadcastStateChanged({ gameId, characterFolder })
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
      let target = path.join(characterDir, modFolder)
      if (!(await pathExists(target))) {
        const baseName = modFolder.replace(/^DISABLED_/i, '')
        const altFolder = /^DISABLED_/i.test(modFolder) ? baseName : `DISABLED_${baseName}`
        const altPath = path.join(characterDir, altFolder)
        if (await pathExists(altPath)) target = altPath
      }
      return openInShell(target)
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

  register(IPC.pickModsFolder, async () => {
    const picked = await openDialog({
      title: '选择 EFMI 根目录或 Mods 目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return picked ? normalizeModsPath(picked) : null
  })

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

  register(IPC.pickImportFolders, async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: '选择要导入的 Mod 文件夹（可多选，也可选择包含多个 Mod 的总文件夹）',
          properties: ['openDirectory', 'multiSelections']
        })
      : await dialog.showOpenDialog({
          title: '选择要导入的 Mod 文件夹（可多选，也可选择包含多个 Mod 的总文件夹）',
          properties: ['openDirectory', 'multiSelections']
        })
    return result.canceled ? [] : result.filePaths
  })

  register(IPC.pickCover, async () =>
    openDialog({
      title: '选择角色封面',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    })
  )

  register(IPC.importRun, async (request: ImportRequest) => {
    markInternalFsMutation()
    const snap = await makeSnapshot(request.gameId)
    const result = await runImport(
      { baseDir: baseDir(), settings, metadata, existingCharacters: snap.characters },
      request
    )
    broadcastStateChanged({ gameId: request.gameId, characterFolder: request.targetCharacter ?? undefined })
    return result
  })

  register(IPC.importParse, async (request: ImportParseRequest) => {
    const snap = await makeSnapshot(request.gameId)
    return parseImportSources(
      { baseDir: baseDir(), settings, metadata, existingCharacters: snap.characters },
      request
    )
  })

  register(IPC.importCommit, async (request: ImportCommitRequest) => {
    markInternalFsMutation()
    const snap = await makeSnapshot(request.gameId)
    const result = await commitImportSession(
      { baseDir: baseDir(), settings, metadata, existingCharacters: snap.characters },
      request
    )
    broadcastStateChanged({ gameId: request.gameId })
    return result
  })

  register(IPC.importDiscard, async (sessionId: string) => {
    if (sessionId) await discardImportSession(sessionId)
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
      const snapshot = await makeSnapshot(gameId)
      broadcastStateChanged({ gameId, characterFolder })
      return snapshot
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
    broadcastStateChanged({ gameId, characterFolder })
    return { ok: true }
  })

  register(IPC.resetCharacterMeta, async (gameId: GameId, characterFolder: string) => {
    requireGame(gameId)
    if (!isSafeSegment(characterFolder)) throw new Error('角色目录名不合法')
    metadata = removeCharacterMeta(metadata, gameId, characterFolder)
    await saveMetadata(baseDir(), metadata)
    const snapshot = await makeSnapshot(gameId)
    broadcastStateChanged({ gameId, characterFolder })
    return snapshot
  })

  register(
    IPC.createCharacter,
    async (gameId: GameId, input: CreateCharacterInput) => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) throw new Error('未配置 Mods 目录')
      if (!(await pathExists(gameSettings.modsPath))) throw new Error('Mods 目录不存在')

      const folder = String(input?.folder || '').trim()
      if (!folder) throw new Error('目录名不能为空')
      if (folder.startsWith('.') || folder.startsWith('_')) {
        throw new Error('目录名不能以 . 或 _ 开头（会被隐藏）')
      }
      if (!isSafeSegment(folder)) throw new Error('目录名包含非法字符')
      if (['character', 'characters'].includes(folder.toLowerCase())) {
        throw new Error('这个目录名是兼容容器保留名')
      }

      const base = await resolveCharacterBase(gameSettings.modsPath)
      const target = path.join(base, folder)
      if (!isInside(base, target)) throw new Error('目录越界')
      if (await pathExists(target)) throw new Error('同名目录已存在')
      markInternalFsMutation()
      await fs.mkdir(target)

      const current = getCharacterMeta(metadata, gameId, folder)
      metadata = setCharacterMeta(metadata, gameId, folder, {
        ...current,
        displayName: String(input.displayName || '').trim() || folder,
        aliases: Array.isArray(input.aliases) ? input.aliases : current.aliases,
        kind: input.kind === 'utility' ? 'utility' : 'character'
      })
      await saveMetadata(baseDir(), metadata)
      const snapshot = await makeSnapshot(gameId)
      broadcastStateChanged({ gameId, characterFolder: folder })
      return snapshot
    }
  )

  register(
    IPC.saveCharacterCoverData,
    async (gameId: GameId, characterFolder: string, dataUrl: string) => {
      markInternalFsMutation()
      await saveCharacterCoverData(gameId, characterFolder, dataUrl)
      const snapshot = await makeSnapshot(gameId)
      broadcastStateChanged({ gameId, characterFolder })
      return snapshot
    }
  )

  register(IPC.clearCharacterCover, async (gameId: GameId, characterFolder: string) => {
    markInternalFsMutation()
    await clearCharacterCoverFiles(gameId, characterFolder)
    const snapshot = await makeSnapshot(gameId)
    broadcastStateChanged({ gameId, characterFolder })
    return snapshot
  })

  register(
    IPC.getModPresets,
    async (gameId: GameId, characterFolder: string, modFolder: string) => {
      requireGame(gameId)
      if (!isSafeSegment(characterFolder) || !isSafeSegment(modFolder)) return []
      let modPath: string | undefined
      const gameSettings = settings.games[gameId]
      if (gameSettings?.modsPath) {
        const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
        const baseName = modFolder.replace(/^DISABLED_/i, '')
        let targetModDir = path.join(characterDir, modFolder)
        if (!(await pathExists(targetModDir))) {
          targetModDir = path.join(characterDir, `DISABLED_${baseName}`)
        }
        modPath = targetModDir
      }
      return getModPresets(baseDir(), gameId, characterFolder, modFolder, modPath)
    }
  )

  register(
    IPC.saveModPreset,
    async (gameId: GameId, characterFolder: string, modFolder: string, presetName: string) => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      if (!isSafeSegment(characterFolder) || !isSafeSegment(modFolder)) return { ok: false, error: '目录参数不合法' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      const baseName = modFolder.replace(/^DISABLED_/i, '')
      let targetModDir = path.join(characterDir, modFolder)
      if (!(await pathExists(targetModDir))) {
        const altFolder = /^DISABLED_/i.test(modFolder) ? baseName : `DISABLED_${baseName}`
        targetModDir = path.join(characterDir, altFolder)
      }
      return saveModPreset(baseDir(), gameId, characterFolder, modFolder, targetModDir, presetName)
    }
  )

  register(
    IPC.applyModPreset,
    async (gameId: GameId, characterFolder: string, modFolder: string, presetId: string) => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      if (!isSafeSegment(characterFolder) || !isSafeSegment(modFolder)) return { ok: false, error: '目录参数不合法' }
      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      const baseName = modFolder.replace(/^DISABLED_/i, '')
      let targetModDir = path.join(characterDir, modFolder)
      if (!(await pathExists(targetModDir))) {
        const altFolder = /^DISABLED_/i.test(modFolder) ? baseName : `DISABLED_${baseName}`
        targetModDir = path.join(characterDir, altFolder)
      }
      markInternalFsMutation()
      const res = await applyModPreset(baseDir(), gameId, characterFolder, modFolder, targetModDir, presetId)
      if (res.ok) {
        broadcastStateChanged({ gameId, characterFolder })
        scheduleAutoReload()
      }
      return res
    }
  )

  register(
    IPC.deleteModPreset,
    async (gameId: GameId, characterFolder: string, modFolder: string, presetId: string) => {
      requireGame(gameId)
      return deleteModPreset(baseDir(), gameId, characterFolder, modFolder, presetId)
    }
  )

  register(
    IPC.getModDetails,
    async (gameId: GameId, characterFolder: string, modFolder: string) => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) throw new Error('未配置 Mods 目录')
      const details = await getModDetails(
        gameSettings.modsPath,
        characterFolder,
        modFolder,
        assetUrl
      )
      await recordRecentMod(gameId, characterFolder, details.folderName, details.name).catch(
        (error) => logError('recent', error)
      )
      return details
    }
  )

  register(
    IPC.setModPreview,
    async (
      gameId: GameId,
      characterFolder: string,
      modFolder: string,
      sourcePath?: string
    ): Promise<ToggleResult> => {
      requireGame(gameId)
      const gameSettings = settings.games[gameId]
      if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
      if (!isSafeSegment(modFolder)) return { ok: false, error: 'Mod 名称不合法' }

      const characterDir = await resolveCharacterDir(gameSettings.modsPath, characterFolder)
      const baseName = modFolder.replace(/^DISABLED_/i, '')
      let targetModDir = path.join(characterDir, modFolder)
      if (!(await pathExists(targetModDir))) {
        const altFolder = /^DISABLED_/i.test(modFolder) ? baseName : `DISABLED_${baseName}`
        const altPath = path.join(characterDir, altFolder)
        if (await pathExists(altPath)) targetModDir = altPath
      }
      if (!isInside(characterDir, targetModDir)) return { ok: false, error: 'Mod 路径越界' }
      if (!(await pathExists(targetModDir))) return { ok: false, error: 'Mod 目录不存在' }

      let picked = sourcePath ? String(sourcePath).trim() : ''
      if (!picked) {
        const selectedFile = await openDialog({
          title: '选择 Mod 预览图',
          properties: ['openFile'],
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
        })
        if (!selectedFile) return { ok: false, error: '已取消' }
        picked = selectedFile
      }

      if (!(await pathExists(picked))) return { ok: false, error: '所选图片文件不存在' }
      const ext = path.extname(picked).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'].includes(ext)) {
        return { ok: false, error: '仅支持 .png / .jpg / .jpeg / .webp / .gif / .avif 格式的图片' }
      }

      markInternalFsMutation()
      // 清理该 Mod 目录下已有的 .preview.* 专属预览图，保留 Mod 原生资源不误删
      for (const oldExt of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']) {
        await fs
          .rm(path.join(targetModDir, `.preview${oldExt}`), { force: true })
          .catch(() => undefined)
      }

      const destFile = path.join(targetModDir, `.preview${ext}`)
      await fs.copyFile(picked, destFile)
      const now = new Date()
      await fs.utimes(targetModDir, now, now).catch(() => undefined)
      invalidatePreviewCache(targetModDir)
      broadcastStateChanged({ gameId, characterFolder })
      return { ok: true }
    }
  )

  register(IPC.reorderCharacters, async (gameId: GameId, folders: string[]) => {
    requireGame(gameId)
    const clean = (Array.isArray(folders) ? folders : []).filter(
      (folder) => typeof folder === 'string' && isSafeSegment(folder)
    )
    settings = {
      ...settings,
      characterOrders: { ...settings.characterOrders, [gameId]: clean }
    }
    await saveSettings(baseDir(), settings)
    broadcastStateChanged({ gameId })
    return { ok: true }
  })

  register(
    IPC.reorderMods,
    async (gameId: GameId, characterFolder: string, folders: string[]) => {
      requireGame(gameId)
      if (!isSafeSegment(characterFolder)) return { ok: false, error: '角色目录名不合法' }
      const clean = (Array.isArray(folders) ? folders : []).filter(
        (folder) => typeof folder === 'string' && isSafeSegment(folder)
      )
      const key = `${gameId}:${characterFolder}`
      settings = {
        ...settings,
        modOrders: { ...settings.modOrders, [key]: clean }
      }
      await saveSettings(baseDir(), settings)
      broadcastStateChanged({ gameId, characterFolder })
      return { ok: true }
    }
  )

  register(IPC.launchGame, async (gameId: GameId) => launchConfigured(gameId, 'game'))
  register(IPC.launchLoader, async (gameId: GameId) => launchConfigured(gameId, 'loader'))

  register(IPC.getOverlayHotkey, async () => settings.ui.overlayHotkey)

  register(IPC.setOverlayHotkey, async (hotkey: string) => {
    const value = String(hotkey || '').trim()
    const previous = settings.ui.overlayHotkey
    const result = applyOverlayHotkey(value)
    if (!result.ok) {
      applyOverlayHotkey(previous)
      return result
    }
    settings = mergeSettings(settings, { ui: { overlayHotkey: value } })
    await saveSettings(baseDir(), settings)
    broadcastStateChanged({ gameId: settings.activeGameId })
    return { ok: true, hotkey: value }
  })

  register(IPC.setOverlayPinned, async (pinned: boolean) => {
    settings = mergeSettings(settings, { ui: { overlayPinned: Boolean(pinned) } })
    await saveSettings(baseDir(), settings)
    const enabled = Boolean(pinned)
    overlayWindow?.setAlwaysOnTop(enabled, OVERLAY_TOP_LEVEL)
    overlayDetailWindow?.setAlwaysOnTop(enabled, OVERLAY_TOP_LEVEL)
    if (enabled) {
      const active = overlayDetailWindow?.isFocused()
        ? overlayDetailWindow
        : overlayWindow?.isFocused()
          ? overlayWindow
          : overlayWindow
      raiseOverlayWindow(active)
    }
    broadcastStateChanged({ gameId: settings.activeGameId })
    return { ok: true }
  })

  register(IPC.showOverlayDetail, async (request: OverlayDetailRequest) => {
    if (!request || !isSafeSegment(request.characterFolder) || !isSafeSegment(request.modFolder)) {
      return { ok: false, error: '参数不合法' }
    }
    requireGame(request.gameId)
    if (!overlayWindow) return { ok: false, error: '快捷窗口未打开' }
    showOverlayDetail(request)
    return { ok: true }
  })

  register(IPC.hideOverlayDetail, async () => {
    hideOverlayDetail()
  })

  register(IPC.sendModHotkey, async (key: string) => {
    if (!settings.ui.allowHotkeySend) {
      return { ok: false, error: '设置中已关闭“允许点击热键发送”' }
    }
    const plan = toKeyPlan(key)
    if (!plan) {
      return { ok: false, error: '暂不支持这个热键格式（目前只发送键盘热键）' }
    }
    return executeKeyPlan(plan)
  })

  register(IPC.rosterStatus, async () => getRosterStatus(settings.import.rosterRemoteUrl))

  register(IPC.rosterSync, async (customUrl?: string) => {
    const targetUrl = (customUrl ?? settings.import.rosterRemoteUrl ?? '').trim()
    if (customUrl && customUrl.trim() && customUrl.trim() !== settings.import.rosterRemoteUrl) {
      settings = mergeSettings(settings, { import: { rosterRemoteUrl: customUrl.trim() } })
      await saveSettings(baseDir(), settings)
    }
    const res = await syncRemoteRoster(baseDir(), targetUrl, (url) => net.fetch(url))
    if (res.ok) {
      broadcastStateChanged({ gameId: settings.activeGameId })
    }
    return res
  })

  register(IPC.checkEnvironment, async (gameId?: GameId) => {
    if (gameId) requireGame(gameId)
    return checkEnvironment(gameId)
  })

  register(IPC.openEnvironmentFolder, async (gameId: GameId) => {
    requireGame(gameId)
    const gameSettings = settings.games[gameId]
    if (!gameSettings?.modsPath) return { ok: false, error: '未配置 Mods 目录' }
    const root = path.dirname(gameSettings.modsPath)
    if (!(await pathExists(root))) return { ok: false, error: 'EFMI 根目录不存在' }
    const error = await shell.openPath(root)
    return error ? { ok: false, error } : { ok: true, path: root }
  })

  register(IPC.reloadF10, async () => reloadF10())

  register(IPC.overlayHide, async () => {
    overlayWindow?.hide()
    overlayDetailWindow?.hide()
  })

  register(IPC.overlayToggle, async () => {
    toggleOverlay()
  })

  register(IPC.overlayOpenManager, async () => {
    overlayWindow?.hide()
    overlayDetailWindow?.hide()
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../../build/icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  tray.setToolTip('ModDeck')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 ModDeck', click: () => showMainWindow() },
      { label: '快捷窗口', click: () => toggleOverlay() },
      { type: 'separator' },
      {
        label: '退出 ModDeck',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', () => showMainWindow())
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
  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.ui.closeBehavior === 'minimize') {
      event.preventDefault()
      mainWindow?.hide()
      createTray()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // 主窗口关闭后不要再留下隐藏的快捷窗口，否则进程会驻留但管理器无法打开。
    overlayDetailWindow?.destroy()
    overlayDetailWindow = null
    overlayWindow?.destroy()
    overlayWindow = null
    if (process.platform !== 'darwin') app.quit()
  })
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

          await click('.mod-row')
          const detailText = await bodyText()
          const detailShot = await shot('smoke-details.png')

          await mainWindow?.webContents.executeJavaScript(
            "[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '编辑')?.click()"
          )
          await delay(600)
          const editText = await bodyText()
          const editShot = await shot('smoke-edit.png')
          await mainWindow?.webContents.executeJavaScript(
            "document.querySelector('.modal-head button')?.click()"
          )
          await delay(300)

          await click('.back-link')
          await click('.side-action')
          const settingsText = await bodyText()
          const settingsShot = await shot('smoke-settings.png')

          await mainWindow?.webContents.executeJavaScript('window.moddeck.toggleOverlay()')
          await delay(1200)
          let overlayShot = false
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            const image = await overlayWindow.webContents.capturePage()
            if (image && !image.isEmpty()) {
              await fs.writeFile(path.join(SMOKE_DIR, 'smoke-overlay.png'), image.toPNG())
              overlayShot = true
            }
          }
          let overlayDetailShot = false
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            await overlayWindow.webContents.executeJavaScript(
              "document.querySelector('.overlay-mod')?.click()"
            )
            await delay(900)
            if (overlayDetailWindow && !overlayDetailWindow.isDestroyed()) {
              const detailImage = await overlayDetailWindow.webContents.capturePage()
              if (detailImage && !detailImage.isEmpty()) {
                await fs.writeFile(
                  path.join(SMOKE_DIR, 'smoke-overlay-detail.png'),
                  detailImage.toPNG()
                )
                overlayDetailShot = true
              }
            }
          }
          await mainWindow?.webContents.executeJavaScript('window.moddeck.toggleOverlay()')

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
          const createdSnapshot = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.createCharacter('wuthering-waves', { folder: '冒烟新建', displayName: '冒烟新建', kind: 'utility' })"
          )
          const createdCharacter = createdSnapshot?.characters?.find(
            (entry: { folder: string }) => entry.folder === '冒烟新建'
          )
          const coverData =
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
          const coverSnapshot = await mainWindow?.webContents.executeJavaScript(
            `window.moddeck.saveCharacterCoverData('wuthering-waves', '冒烟新建', ${JSON.stringify(
              coverData
            )})`
          )
          const savedCover = Boolean(
            coverSnapshot?.characters?.find(
              (entry: { folder: string }) => entry.folder === '冒烟新建'
            )?.coverUrl
          )
          const fixtureRoot = path.join(process.cwd(), 'temp', 'fixture')
          const normalizedSettings = await mainWindow?.webContents.executeJavaScript(
            `window.moddeck.saveSettings({ games: { 'wuthering-waves': { modsPath: ${JSON.stringify(
              fixtureRoot
            )} } } })`
          )
          const normalizedModsPath = normalizedSettings?.games?.['wuthering-waves']?.modsPath
          const environment = await mainWindow?.webContents.executeJavaScript(
            "window.moddeck.checkEnvironment('wuthering-waves')"
          )
          const bootAfter = await mainWindow?.webContents.executeJavaScript(
            'window.moddeck.bootstrap()'
          )
          const recentCount = bootAfter?.settings?.recentMods?.length ?? 0

          await fs.writeFile(
            path.join(SMOKE_DIR, 'smoke-result.json'),
            JSON.stringify(
              {
                ok: true,
                libraryText,
                characterText,
                settingsText,
                detailText,
                editText,
                images: {
                  library: true,
                  character: characterShot,
                  details: detailShot,
                  edit: editShot,
                  settings: settingsShot,
                  overlay: overlayShot,
                  overlayDetail: overlayDetailShot
                },
                importResult,
                importedMods,
                toggleOff,
                afterOff,
                toggleOn,
                metaUpdatedName,
                metaResetName,
                createdCharacter,
                savedCover,
                normalizedModsPath,
                environment,
                recentCount
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
  await loadRosterCache(baseDir()).catch((error) => logError('roster-cache', error))
  void ensureKeyHelperBinary()
  startupLog('bootstrap', `settings-loaded userData=${baseDir()}`)
  refreshModsWatcher()
  const hotkeyResult = applyOverlayHotkey(settings.ui.overlayHotkey)
  if (!hotkeyResult.ok) {
    startupLog('hotkey', hotkeyResult.error || 'registration failed')
  }

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

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  if (modsWatcher) {
    try {
      modsWatcher.close()
    } catch {
      // ignore
    }
    modsWatcher = null
  }
  tray?.destroy()
  tray = null
  if (app.isReady()) globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
})

const gotLock = SMOKE_TEST || SCAN_REPORT || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}
