import path from 'node:path'
import fs from 'node:fs/promises'
import type {
  GameId,
  ModVariantPreset,
  RosterPreset,
  SaveRosterPresetInput,
  ModAssignmentItem,
  ToggleResult,
} from '../../shared/types'
import { getAssignmentModItems } from '../../shared/types'
import { ensureDir, pathExists, readJsonSafe, writeJsonAtomic } from '../core/fsx'
import { isSafeSegment } from '../core/safe-path'

const ROSTER_PRESETS_FILE = 'roster-presets.json'
const BRIDGE_FOLDER_NAME = '_ModDeck_Preset_Bridge'
const BRIDGE_FILE_NAME = 'bridge.ini'

/**
 * 临时/UI/交互/帧动画类瞬态变量过滤规则
 * 这类变量在游戏中是频繁临时变动或由帧动画重算的（例如打开的菜单/页码/拖拽坐标/动画振荡器/形态键），
 * 不应参与外观预设的活性比对与切换覆盖。
 */
export const TRANSIENT_VAR_PATTERNS = [
  /(?:\\|_)(?:menu|elem|drag|seen|info|page|sub|lang|ref_w|ref_h|off_x|off_y|offset_x|offset_y|offset_x_px|offset_y_px|slider|cursor|screen|click|hover|active_elem|buttons)(?:_|\b)/i,
  /\\ssmtdrag_efmi_/i,
  /\\tg_gui_anim_/i,
  /\\(?:tg_)?shapekey_\d+\b/i,
  /\\(?:show_time|inited|finished|begin_time|delta|ui4_finished|ww|wh|mod_in_use)\b/i
]

export function isTransientVariable(key: string): boolean {
  return TRANSIENT_VAR_PATTERNS.some((rx) => rx.test(key))
}

/**
 * 待生效预设条目（Pending Preset Queue Entry）：
 * 用于集中管理所有角色和 Mod 的待刷新预设。
 * 当用户关闭自动重载时，支持连续选择多个角色的不同预设，或同一 Mod 切换多次。
 * 队列中永远以 (gameId, characterFolder, modFolder) 为唯一键，自动保留最终意图。
 */
export interface PendingPresetEntry {
  gameId: GameId
  presetId: string
  characterFolder: string
  cleanModName: string
  modsPath: string
  variables: Record<string, string>
  updatedAt: number
  status?: 'pending' | 'reloading'
}

// 内存中的待生效聚合队列：Key 为 `${gameId}:${characterFolder.toLowerCase()}:${cleanModName.toLowerCase()}`
const pendingPresetQueue = new Map<string, PendingPresetEntry>()

function makeQueueKey(gameId: GameId, characterFolder: string, modFolder: string): string {
  const cleanMod = modFolder.replace(/^DISABLED_/i, '').toLowerCase()
  return `${gameId}:${characterFolder.toLowerCase()}:${cleanMod}`
}

/**
 * 获取当前游戏待生效（等待手动 F10）的预设数量
 */
/**
 * 将待生效队列标记为正在重载生效中（触发乐观内存缓存）
 */
export function markPendingQueueReloading(gameId?: GameId): void {
  const prefix = gameId ? `${gameId}:` : ''
  for (const [key, entry] of pendingPresetQueue.entries()) {
    if (!prefix || key.startsWith(prefix)) {
      entry.status = 'reloading'
    }
  }
}

export function getPendingPresetCount(gameId?: GameId): number {
  if (!gameId) return pendingPresetQueue.size
  let count = 0
  const prefix = `${gameId}:`
  for (const key of pendingPresetQueue.keys()) {
    if (key.startsWith(prefix)) count++
  }
  return count
}

/**
 * 获取当前队列中某游戏的所有待生效条目
 */
export function getPendingQueueEntries(gameId?: GameId): PendingPresetEntry[] {
  if (!gameId) return [...pendingPresetQueue.values()]
  const list: PendingPresetEntry[] = []
  const prefix = `${gameId}:`
  for (const [key, val] of pendingPresetQueue.entries()) {
    if (key.startsWith(prefix)) list.push(val)
  }
  return list
}

/**
 * 清空待生效队列
 */
export function clearPendingPresetQueue(gameId?: GameId): void {
  if (!gameId) {
    pendingPresetQueue.clear()
    return
  }
  const prefix = `${gameId}:`
  for (const key of pendingPresetQueue.keys()) {
    if (key.startsWith(prefix)) pendingPresetQueue.delete(key)
  }
}

/**
 * 检查某个 Mod 的某个预设是否处于待生效（Pending）状态
 */
export function isPresetPending(
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  presetId: string
): boolean {
  const key = makeQueueKey(gameId, characterFolder, modFolder)
  const entry = pendingPresetQueue.get(key)
  return Boolean(entry && entry.presetId === presetId)
}

/**
 * 获取某个 Mod 专属的预设分级文件路径：
 * %APPDATA%/ModDeck/presets/{gameId}/{characterFolder}/{cleanModName}.json
 */
async function getModPresetFilePath(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string
): Promise<string> {
  const cleanModName = modFolder.replace(/^DISABLED_/i, '')
  const dir = path.join(baseDir, 'presets', gameId, characterFolder)
  await ensureDir(dir)
  return path.join(dir, `${cleanModName}.json`)
}

/**
 * 递归收集 Mod 目录下的全部 ini 相对路径及其当前启用状态
 */
export async function inspectModIniFiles(
  modPath: string
): Promise<{ active: string[]; disabled: string[] }> {
  const active: string[] = []
  const disabled: string[] = []

  const walk = async (current: string, relative: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      const nextRel = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(full, nextRel)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.ini') && lower !== 'desktop.ini') {
        if (/^disabled_/i.test(entry.name)) {
          disabled.push(nextRel)
        } else {
          active.push(nextRel)
        }
      }
    }
  }

  await walk(modPath, '')
  return { active, disabled }
}

/**
 * 深入 Mod 目录下的所有 .ini 文件，仅解析声明了 persist 的持久化变量定义与作者出厂默认值
 * （排除无 persist 的内部骨骼/动画计算寄存器）
 * key 统一存储为相对 ini 路径与变量名，如: "$\\mod.ini\\ssmtdrag_efmi_mode_a" 或带有 namespace 的 "$\\ns\\var"
 */
export async function inspectModDefaultVariables(
  modPath: string
): Promise<Record<string, string>> {
  const defaultVars: Record<string, string> = {}
  const entries = await inspectModIniFiles(modPath)
  const allInis = [...entries.active, ...entries.disabled]

  for (const rel of allInis) {
    const full = path.join(modPath, rel)
    try {
      const content = await fs.readFile(full, 'utf8')
      let ns = ''
      const lines = content.split(/\r?\n/)
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (line.startsWith(';') || line.startsWith('#')) continue

        const nsMatch = line.match(/^namespace\s*=\s*(.+)$/i)
        if (nsMatch) {
          ns = nsMatch[1].trim().replace(/\//g, '\\')
          continue
        }

        // 仅匹配带 persist 关键字的持久化变量（global persist $var = value / persist global $var = value / persist $var = value）
        const varMatch = line.match(
          /^(?:global\s+persist|persist\s+global|persist)\s+\$([a-zA-Z0-9_]+)\s*=\s*([^;]+)/i
        )
        if (varMatch) {
          const varName = varMatch[1].trim()
          let defaultVal = varMatch[2].trim()
          if (defaultVal.includes(';')) {
            defaultVal = defaultVal.split(';')[0].trim()
          }

          let key = ''
          if (ns) {
            key = `$\\${ns}\\${varName}`
          } else {
            const cleanRel = rel
              .split(path.sep)
              .map((p) => p.replace(/^disabled_/i, ''))
              .join('\\')
            key = `$\\${cleanRel}\\${varName}`
          }
          defaultVars[key.toLowerCase()] = defaultVal
        }
      }
    } catch {
      // ignore
    }
  }

  return defaultVars
}

/**
 * 寻找游戏目录下的 d3dx_user.ini
 */
/**
 * 寻找游戏目录下的 d3dx.ini
 */
export async function findD3dxIniPath(modsPath: string): Promise<string | null> {
  const parent = path.dirname(modsPath)
  const candidate1 = path.join(parent, 'd3dx.ini')
  if (await pathExists(candidate1)) return candidate1
  const candidate2 = path.join(modsPath, 'd3dx.ini')
  if (await pathExists(candidate2)) return candidate2
  return null
}

/**
 * 读取 d3dx.ini 中的 settings_auto_save_interval（默认 60 秒）
 */
export async function getD3dxAutoSaveInterval(modsPath: string): Promise<number> {
  const iniPath = await findD3dxIniPath(modsPath)
  if (!iniPath) return 60
  try {
    const content = await fs.readFile(iniPath, 'utf8')
    const match = content.match(/^\s*settings_auto_save_interval\s*=\s*(-?\d+)/im)
    if (match) return parseInt(match[1], 10)
  } catch {
    // ignore
  }
  return 60
}

/**
 * 修改 d3dx.ini 中的 settings_auto_save_interval 配置
 */
export async function setD3dxAutoSaveInterval(
  modsPath: string,
  interval: number
): Promise<ToggleResult> {
  const iniPath = await findD3dxIniPath(modsPath)
  if (!iniPath) return { ok: false, error: '未找到 d3dx.ini 配置文件' }
  try {
    let content = await fs.readFile(iniPath, 'utf8')
    const regex = /^(\s*settings_auto_save_interval\s*=\s*)-?\d+/im
    if (regex.test(content)) {
      content = content.replace(regex, `$1${interval}`)
    } else {
      content += `\r\nsettings_auto_save_interval = ${interval}\r\n`
    }
    await fs.writeFile(iniPath, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function findD3dxUserIniPath(modsPath: string): Promise<string | null> {
  const parent = path.dirname(modsPath)
  const candidate1 = path.join(parent, 'd3dx_user.ini')
  if (await pathExists(candidate1)) return candidate1
  const candidate2 = path.join(modsPath, 'd3dx_user.ini')
  if (await pathExists(candidate2)) return candidate2
  return null
}

/**
 * 从 d3dx_user.ini 中提取当前游戏正在生效的变量键值对
 * 兼容 3DMigoto 两种格式：
 * 1. 带命名空间: $\namespace\var = val
 * 2. 完整路径: $\mods\角色目录\Mod目录\ini名\var = val
 */
export async function readActiveD3dxUserVariables(
  modsPath: string,
  knownKeys?: string[],
  _characterFolder?: string,
  modFolder?: string
): Promise<Record<string, string>> {
  const userIni = await findD3dxUserIniPath(modsPath)
  if (!userIni) return {}

  try {
    const raw = await fs.readFile(userIni, 'utf8')
    const result: Record<string, string> = {}
    const lines = raw.split(/\r?\n/)
    const cleanModName = modFolder ? modFolder.replace(/^disabled_/i, '').toLowerCase() : ''

    const normalizedKnown = knownKeys ? knownKeys.map((k) => k.toLowerCase()) : null

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith('$\\') || !line.includes('=')) continue
      const idx = line.indexOf('=')
      const fullKey = line.substring(0, idx).trim()
      const val = line.substring(idx + 1).trim()
      const lowerFullKey = fullKey.toLowerCase()

      if (normalizedKnown && normalizedKnown.length > 0) {
        for (const targetKey of normalizedKnown) {
          const targetSuffix = targetKey.substring(1)
          const varNameOnly = targetKey.substring(targetKey.lastIndexOf('\\'))
          if (
            lowerFullKey === targetKey ||
            lowerFullKey.endsWith(targetSuffix) ||
            (cleanModName &&
              lowerFullKey.includes('\\mods\\') &&
              lowerFullKey.includes(`\\${cleanModName}\\`) &&
              lowerFullKey.endsWith(varNameOnly))
          ) {
            if (cleanModName && lowerFullKey.includes('\\mods\\')) {
              if (!lowerFullKey.includes(`\\${cleanModName}\\`)) continue
            }
            result[targetKey] = val
          }
        }
      } else {
        if (cleanModName && lowerFullKey.includes('\\mods\\')) {
          result[lowerFullKey] = val
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 构建 3DMigoto 规范变量全路径名（用于写入 d3dx_user.ini 或 bridge.ini）
 */
function buildFull3DMigotoVarKey(
  rawKey: string,
  characterFolder?: string,
  cleanModName?: string
): string {
  const lower = rawKey.toLowerCase()
  if (lower.includes('\\mods\\')) return rawKey
  if (rawKey.startsWith('$\\') && characterFolder && cleanModName) {
    const relPart = rawKey.substring(2)
    if (relPart.toLowerCase().includes('.ini\\')) {
      return `$\\mods\\${characterFolder}\\${cleanModName}\\${relPart}`
    }
    return `$\\${relPart}`
  }
  return rawKey
}

/**
 * 将指定预设的变量值安全写回 d3dx_user.ini
 */
export async function applyVariablesToD3dxUserIni(
  modsPath: string,
  variables: Record<string, string>,
  characterFolder?: string,
  modFolder?: string
): Promise<boolean> {
  const userIni = await findD3dxUserIniPath(modsPath)
  if (!userIni) return false

  try {
    const raw = await fs.readFile(userIni, 'utf8')
    const lines = raw.split(/\r?\n/)
    const cleanModName = modFolder ? modFolder.replace(/^disabled_/i, '') : ''

    const varMap = new Map<string, { originalKey: string; value: string }>()
    for (const [k, v] of Object.entries(variables)) {
      if (isTransientVariable(k)) continue
      varMap.set(k.toLowerCase(), { originalKey: k, value: v })
    }

    const updatedLines: string[] = []
    const handledKeys = new Set<string>()

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line.startsWith('$\\') && line.includes('=')) {
        const idx = line.indexOf('=')
        const currentLineKey = line.substring(0, idx).trim()
        const lowerLineKey = currentLineKey.toLowerCase()

        let matchedTargetKey: string | null = null
        for (const [targetKey] of varMap.entries()) {
          const targetSuffix = targetKey.substring(1)
          const varNameOnly = targetKey.substring(targetKey.lastIndexOf('\\'))
          if (
            lowerLineKey === targetKey ||
            lowerLineKey.endsWith(targetSuffix) ||
            (cleanModName &&
              lowerLineKey.includes('\\mods\\') &&
              lowerLineKey.includes(`\\${cleanModName.toLowerCase()}\\`) &&
              lowerLineKey.endsWith(varNameOnly))
          ) {
            if (cleanModName && lowerLineKey.includes('\\mods\\')) {
              if (!lowerLineKey.includes(`\\${cleanModName.toLowerCase()}\\`)) continue
            }
            matchedTargetKey = targetKey
            break
          }
        }

        if (matchedTargetKey) {
          const item = varMap.get(matchedTargetKey)!
          updatedLines.push(`${currentLineKey} = ${item.value}`)
          handledKeys.add(matchedTargetKey)
          continue
        }
      }
      updatedLines.push(rawLine)
    }

    // 若 d3dx_user.ini 之前尚未记录该变量，则构建规范完整路径追加
    for (const [targetKey, item] of varMap.entries()) {
      if (!handledKeys.has(targetKey)) {
        const fullWriteKey = buildFull3DMigotoVarKey(item.originalKey, characterFolder, cleanModName)
        updatedLines.push(`${fullWriteKey} = ${item.value}`)
      }
    }

    await fs.writeFile(userIni, updatedLines.join('\r\n'), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 写入 [Present] 一次性帧桥接脚本 (Mods\_ModDeck_Preset_Bridge\bridge.ini)
 * 支持将待生效队列中全部角色的最新变量批量合成写入这一个集中式桥接文件。
 * 在重载后的第 1 帧通过 [Present] 一次性注入所有角色的目标预设变量，随后立即自锁 ($md_preset_applied = 1)。
 */
export async function writePresetBridgeIni(
  modsPath: string,
  entries: Array<{
    variables: Record<string, string>
    characterFolder: string
    modFolder: string
  }>
): Promise<boolean> {
  if (!modsPath) return false
  try {
    const bridgeDir = path.join(modsPath, BRIDGE_FOLDER_NAME)
    await ensureDir(bridgeDir)
    const bridgeFile = path.join(bridgeDir, BRIDGE_FILE_NAME)

    if (!entries || entries.length === 0) {
      await clearPresetBridgeIni(modsPath)
      return true
    }

    // 先收集 d3dx_user.ini 中已有的真实键路径映射，确保桥接脚本的变量路径与 3DMigoto 内存完全一致
    const userIni = await findD3dxUserIniPath(modsPath)
    const existingKeyLines: Array<{ rawKey: string; lowerKey: string }> = []
    if (userIni) {
      try {
        const raw = await fs.readFile(userIni, 'utf8')
        for (const rawLine of raw.split(/\r?\n/)) {
          const line = rawLine.trim()
          if (line.startsWith('$\\') && line.includes('=')) {
            const k = line.substring(0, line.indexOf('=')).trim()
            existingKeyLines.push({ rawKey: k, lowerKey: k.toLowerCase() })
          }
        }
      } catch {
        // ignore
      }
    }

    const assignmentLines: string[] = []
    const assignedCanonical = new Set<string>()

    for (const entry of entries) {
      const cleanModName = entry.modFolder.replace(/^DISABLED_/i, '')
      const cleanModLower = cleanModName.toLowerCase()

      assignmentLines.push(`  ; Character: ${entry.characterFolder} | Mod: ${cleanModName}`)

      for (const [rawKey, rawVal] of Object.entries(entry.variables)) {
        if (isTransientVariable(rawKey)) continue
        const trimmedVal = String(rawVal ?? '').trim()
        if (!/^[-+]?\d+(?:\.\d+)?$/.test(trimmedVal)) continue

        const targetKey = rawKey.toLowerCase()
        const targetSuffix = targetKey.substring(1)
        const varNameOnly = targetKey.substring(targetKey.lastIndexOf('\\'))

        let resolvedKey = ''
        for (const item of existingKeyLines) {
          if (
            item.lowerKey === targetKey ||
            item.lowerKey.endsWith(targetSuffix) ||
            (cleanModLower &&
              item.lowerKey.includes('\\mods\\') &&
              item.lowerKey.includes(`\\${cleanModLower}\\`) &&
              item.lowerKey.endsWith(varNameOnly))
          ) {
            if (cleanModLower && item.lowerKey.includes('\\mods\\')) {
              if (!item.lowerKey.includes(`\\${cleanModLower}\\`)) continue
            }
            resolvedKey = item.rawKey
            break
          }
        }

        if (!resolvedKey) {
          resolvedKey = buildFull3DMigotoVarKey(rawKey, entry.characterFolder, cleanModName)
        }

        const lowerResolved = resolvedKey.toLowerCase()
        if (assignedCanonical.has(lowerResolved)) continue
        assignedCanonical.add(lowerResolved)
        assignmentLines.push(`  ${resolvedKey} = ${trimmedVal}`)
      }
    }

    if (assignmentLines.length === 0) {
      await clearPresetBridgeIni(modsPath)
      return true
    }

    const content = [
      '; Auto-generated by ModDeck Preset Engine (Multi-Character Batch Bridge)',
      '[Constants]',
      'global $md_preset_applied = 0',
      '',
      '[Present]',
      'if $md_preset_applied == 0',
      ...assignmentLines,
      '  $md_preset_applied = 1',
      'endif',
      ''
    ].join('\r\n')

    await fs.writeFile(bridgeFile, content, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 根据当前的待生效队列，重新全量合成写入 bridge.ini
 */
export async function syncBridgeFileFromQueue(modsPath: string, gameId: GameId): Promise<void> {
  const entries = getPendingQueueEntries(gameId)
  if (entries.length === 0) {
    await clearPresetBridgeIni(modsPath)
    return
  }
  await writePresetBridgeIni(
    modsPath,
    entries.map((e) => ({
      variables: e.variables,
      characterFolder: e.characterFolder,
      modFolder: e.cleanModName
    }))
  )
}

/**
 * 清空桥接脚本，使其处于静默空闲状态
 */
export async function clearPresetBridgeIni(modsPath: string): Promise<void> {
  if (!modsPath) return
  try {
    const bridgeFile = path.join(modsPath, BRIDGE_FOLDER_NAME, BRIDGE_FILE_NAME)
    if (await pathExists(bridgeFile)) {
      await fs.writeFile(bridgeFile, '; ModDeck Preset Bridge Idle\r\n', 'utf8')
    }
  } catch {
    // ignore
  }
}

/**
 * 比较预设与当前环境的激活状态（自动忽略 transient 交互临时变量）
 */
function evaluatePresetActive(
  preset: ModVariantPreset,
  currentActiveInis: string[],
  currentEffectiveVars: Record<string, string>
): boolean {
  // 1. 比对 ini 列表
  const desiredInis = new Set(preset.activeIniFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()))
  if (desiredInis.size !== currentActiveInis.length) return false
  for (const item of currentActiveInis) {
    if (!desiredInis.has(item)) return false
  }

  // 2. 比对外观相关变量（过滤 transient 临时变量）
  if (preset.variables && Object.keys(preset.variables).length > 0) {
    for (const [k, v] of Object.entries(preset.variables)) {
      if (isTransientVariable(k)) continue

      const lowerKey = k.toLowerCase()
      const effectiveVal = currentEffectiveVars[lowerKey]
      if (effectiveVal !== undefined) {
        // 数值宽容比较（例如 "0" 和 "0.000000"）
        const numA = Number(v)
        const numB = Number(effectiveVal)
        if (!isNaN(numA) && !isNaN(numB)) {
          if (numA !== numB) return false
        } else if (v.toLowerCase() !== effectiveVal.toLowerCase()) {
          return false
        }
      }
    }
  }

  return true
}

/**
 * 读取某个 Mod 的所有预设方案（读取分级 JSON，并动态计算 isActive 和 isPending）
 */
export async function getModPresets(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  modPath?: string,
  modsPath?: string
): Promise<ModVariantPreset[]> {
  const cleanModName = modFolder.replace(/^DISABLED_/i, '')
  const filePath = await getModPresetFilePath(baseDir, gameId, characterFolder, modFolder)
  let list = await readJsonSafe<ModVariantPreset[] | null>(filePath, null)

  if (!list || !Array.isArray(list)) {
    list = []
  }

  // 获取当前 Mod 实际运行环境信息
  let currentActiveInis: string[] = []
  let defaultVars: Record<string, string> = {}

  if (modPath && (await pathExists(modPath))) {
    const iniStatus = await inspectModIniFiles(modPath)
    currentActiveInis = iniStatus.active.map((rel) => {
      const parts = rel.split(path.sep)
      parts[parts.length - 1] = parts[parts.length - 1].replace(/^disabled_/i, '')
      return parts.join('/').toLowerCase()
    })
    defaultVars = await inspectModDefaultVariables(modPath)
  }

  // 获取当前生效的变量（d3dx_user.ini 运行时值覆盖出厂默认值）
  const knownKeys = Object.keys(defaultVars)
  let activeD3dVars: Record<string, string> = {}
  if (modsPath) {
    activeD3dVars = await readActiveD3dxUserVariables(modsPath, knownKeys, characterFolder, modFolder)
  }
  const currentEffectiveVars: Record<string, string> = { ...defaultVars }
  for (const [k, v] of Object.entries(activeD3dVars)) {
    currentEffectiveVars[k] = v
  }

  // 检查队列中是否有该 Mod 的待生效记录
  const queueKey = makeQueueKey(gameId, characterFolder, modFolder)
  const pendingEntry = pendingPresetQueue.get(queueKey)

  // 内存乐观缓存：若正在执行重载生效阶段（status === 'reloading'），将目标预设变量直接融入当前有效变量中
  if (pendingEntry && pendingEntry.status === 'reloading') {
    for (const [k, v] of Object.entries(pendingEntry.variables)) {
      currentEffectiveVars[k.toLowerCase()] = v
    }
  }

  // 确保存在「默认 (初始)」出厂预设，并始终同步最新解析出的 persist 默认变量
  let defaultPreset = list.find((p) => p.id === '__default__')
  let listModified = false
  if (!defaultPreset) {
    let defaultInis: string[] = []
    if (modPath && (await pathExists(modPath))) {
      const iniStatus = await inspectModIniFiles(modPath)
      const allInis = iniStatus.active.length > 0 ? iniStatus.active : iniStatus.disabled
      defaultInis = allInis.map((rel) => {
        const parts = rel.split(path.sep)
        parts[parts.length - 1] = parts[parts.length - 1].replace(/^disabled_/i, '')
        return parts.join('/')
      })
    }

    defaultPreset = {
      id: '__default__',
      name: '默认 (初始)',
      modName: cleanModName,
      characterFolder,
      activeIniFiles: defaultInis,
      variables: defaultVars,
      updatedAt: 0
    }
    list.unshift(defaultPreset)
    listModified = true
  } else if (Object.keys(defaultVars).length > 0) {
    const prevKeys = Object.keys(defaultPreset.variables ?? {})
    const nextKeys = Object.keys(defaultVars)
    if (prevKeys.length !== nextKeys.length) {
      defaultPreset.variables = defaultVars
      listModified = true
    }
  }

  if (listModified) {
    await writeJsonAtomic(filePath, list)
  }

  // 计算每一个预设的 isActive 与 isPending 状态
  for (const p of list) {
    p.isActive = evaluatePresetActive(p, currentActiveInis, currentEffectiveVars)
    p.isPending = Boolean(pendingEntry && pendingEntry.status !== 'reloading' && pendingEntry.presetId === p.id)
  }

  return list
}

/**
 * 保存当前状态为该 Mod 的新预设
 */
export async function saveModPreset(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  modPath: string,
  modsPath: string,
  presetName: string
): Promise<ToggleResult> {
  const name = presetName.trim()
  if (!name) return { ok: false, error: '预设名称不能为空' }
  if (!(await pathExists(modPath))) return { ok: false, error: 'Mod 目录不存在' }

  const cleanModName = modFolder.replace(/^DISABLED_/i, '')

  // 移除该 Mod 的待生效队列，确保保存的是真实落盘数据
  pendingPresetQueue.delete(makeQueueKey(gameId, characterFolder, modFolder))

  // 1. 获取当前 ini 启停状态
  const iniStatus = await inspectModIniFiles(modPath)
  const cleanActiveInis = iniStatus.active.map((rel) => {
    const parts = rel.split(path.sep)
    const fileName = parts[parts.length - 1].replace(/^disabled_/i, '')
    parts[parts.length - 1] = fileName
    return parts.join('/')
  })

  // 2. 识别出该 Mod 关联的已知 persist 变量键列表，并从 d3dx_user.ini 中提取当前实机运行值
  const defaultVars = await inspectModDefaultVariables(modPath)
  const knownKeys = Object.keys(defaultVars)
  const activeVars = await readActiveD3dxUserVariables(modsPath, knownKeys, characterFolder, modFolder)

  // 合并：如果 d3dx_user.ini 里有变动取运行时值，若无则取作者默认出厂值（同时剔除瞬态变量）
  const currentSnapshotVars: Record<string, string> = {}
  for (const [k, v] of Object.entries(defaultVars)) {
    if (!isTransientVariable(k)) currentSnapshotVars[k] = v
  }
  for (const [k, v] of Object.entries(activeVars)) {
    if (!isTransientVariable(k)) currentSnapshotVars[k] = v
  }

  const filePath = await getModPresetFilePath(baseDir, gameId, characterFolder, modFolder)
  const list = (await readJsonSafe<ModVariantPreset[] | null>(filePath, null)) ?? []

  const existingIndex = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())
  const newPreset: ModVariantPreset = {
    id: existingIndex >= 0 ? list[existingIndex].id : `preset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    modName: cleanModName,
    characterFolder,
    activeIniFiles: cleanActiveInis,
    variables: currentSnapshotVars,
    updatedAt: Date.now()
  }

  if (existingIndex >= 0) {
    list[existingIndex] = newPreset
  } else {
    list.push(newPreset)
  }

  await writeJsonAtomic(filePath, list)
  return { ok: true }
}

/**
 * 应用该 Mod 的某个指定预设
 * @param autoReloadEnabled 是否配置了“切换预设后自动重载”
 */
export async function applyModPreset(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  modPath: string,
  modsPath: string,
  presetId: string,
  skipBridge = false
): Promise<ToggleResult> {
  const filePath = await getModPresetFilePath(baseDir, gameId, characterFolder, modFolder)
  let list = (await readJsonSafe<ModVariantPreset[] | null>(filePath, null)) ?? []
  let targetPreset = list.find((p) => p.id === presetId || (presetId === 'default' && p.id === '__default__'))
  if (!targetPreset) {
    list = await getModPresets(baseDir, gameId, characterFolder, modFolder, modPath, modsPath)
    targetPreset = list.find((p) => p.id === presetId || (presetId === 'default' && p.id === '__default__'))
  }
  if (!targetPreset) return { ok: false, error: '未找到指定预设' }

  if (!(await pathExists(modPath))) return { ok: false, error: 'Mod 目录不存在' }

  const cleanModName = modFolder.replace(/^DISABLED_/i, '')

  // 1. 如果有 ini 文件级的互斥启用/禁用，重命名文件
  const desiredActiveNorm = new Set(targetPreset.activeIniFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()))
  const walk = async (current: string, relative: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      const nextRel = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(full, nextRel)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.ini') && lower !== 'desktop.ini') {
        const cleanName = entry.name.replace(/^disabled_/i, '')
        const relParts = nextRel.split(path.sep)
        relParts[relParts.length - 1] = cleanName
        const relNorm = relParts.join('/').toLowerCase()

        const shouldBeActive = desiredActiveNorm.size === 0 || desiredActiveNorm.has(relNorm)

        if (shouldBeActive && /^disabled_/i.test(entry.name)) {
          const newFull = path.join(current, cleanName)
          await fs.rename(full, newFull).catch(() => undefined)
        } else if (!shouldBeActive && !/^disabled_/i.test(entry.name)) {
          const newFull = path.join(current, `DISABLED_${entry.name}`)
          await fs.rename(full, newFull).catch(() => undefined)
        }
      }
    }
  }
  await walk(modPath, '')

  // 2. 合并该 Mod 的默认 persist 变量与预设变量（确保切回默认或旧预设时所有 persist 变量完整覆盖）
  const defaultVars = await inspectModDefaultVariables(modPath)
  const mergedVars: Record<string, string> = { ...defaultVars, ...(targetPreset.variables ?? {}) }

  if (Object.keys(mergedVars).length > 0) {
    // 写入 d3dx_user.ini（离线/冷态直接持久化）
    await applyVariablesToD3dxUserIni(modsPath, mergedVars, characterFolder, modFolder)

    // 加入/覆盖到待生效聚合队列（支持同一 Mod 多次切换，永远只保留最新形态）
    const qKey = makeQueueKey(gameId, characterFolder, modFolder)
    pendingPresetQueue.set(qKey, {
      gameId,
      presetId,
      characterFolder,
      cleanModName,
      modsPath,
      variables: mergedVars,
      updatedAt: Date.now(),
      status: 'pending'
    })

    // 全量合成写入全局 bridge.ini
    if (!skipBridge) {
      await syncBridgeFileFromQueue(modsPath, gameId)
    }
  }

  return { ok: true }
}

/**
 * 删除某个预设
 */
export async function deleteModPreset(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  presetId: string
): Promise<ToggleResult> {
  if (presetId === '__default__') {
    return { ok: false, error: '默认初始预设不允许删除' }
  }
  const filePath = await getModPresetFilePath(baseDir, gameId, characterFolder, modFolder)
  const list = (await readJsonSafe<ModVariantPreset[] | null>(filePath, null)) ?? []
  const filtered = list.filter((p) => p.id !== presetId)
  if (filtered.length === list.length) return { ok: false, error: '未找到该预设' }

  await writeJsonAtomic(filePath, filtered)
  return { ok: true }
}

// =========================================================================
// 全局角色池预设（Roster Preset）服务
// =========================================================================

async function getRosterPresetsFilePath(baseDir: string): Promise<string> {
  await ensureDir(baseDir)
  return path.join(baseDir, ROSTER_PRESETS_FILE)
}

export async function loadRosterPresetsStore(
  baseDir: string
): Promise<{ schemaVersion: 1; presets: Record<string, RosterPreset[]> }> {
  const filePath = await getRosterPresetsFilePath(baseDir)
  const data = await readJsonSafe<{ schemaVersion: 1; presets: Record<string, RosterPreset[]> } | null>(filePath, null)
  if (data && data.schemaVersion === 1 && typeof data.presets === 'object') {
    return data
  }
  return { schemaVersion: 1, presets: {} }
}

export async function saveRosterPresetsStore(
  baseDir: string,
  store: { schemaVersion: 1; presets: Record<string, RosterPreset[]> }
): Promise<void> {
  const filePath = await getRosterPresetsFilePath(baseDir)
  await writeJsonAtomic(filePath, store)
}

export async function getRosterPresets(baseDir: string, gameId: GameId): Promise<RosterPreset[]> {
  const store = await loadRosterPresetsStore(baseDir)
  return store.presets[gameId] ?? []
}

export async function saveRosterPreset(
  baseDir: string,
  gameId: GameId,
  input: SaveRosterPresetInput
): Promise<ToggleResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: '方案名称不能为空' }

  const store = await loadRosterPresetsStore(baseDir)
  const list = store.presets[gameId] ?? []
  const existingIdx = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())

  const newPreset: RosterPreset = {
    id: existingIdx >= 0 ? list[existingIdx].id : `roster_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    gameId,
    updatedAt: Date.now(),
    assignments: input.assignments
  }

  if (existingIdx >= 0) {
    list[existingIdx] = newPreset
  } else {
    list.push(newPreset)
  }

  store.presets[gameId] = list
  await saveRosterPresetsStore(baseDir, store)
  return { ok: true }
}

export async function deleteRosterPreset(
  baseDir: string,
  gameId: GameId,
  presetId: string
): Promise<ToggleResult> {
  const store = await loadRosterPresetsStore(baseDir)
  const list = store.presets[gameId] ?? []
  const filtered = list.filter((p) => p.id !== presetId)
  if (filtered.length === list.length) return { ok: false, error: '未找到该方案' }

  store.presets[gameId] = filtered
  await saveRosterPresetsStore(baseDir, store)
  return { ok: true }
}

export async function applyRosterPreset(
  baseDir: string,
  gameId: GameId,
  modsPath: string,
  presetId: string,
  resolveCharDir: (root: string, folder: string) => Promise<string>
): Promise<ToggleResult> {
  const store = await loadRosterPresetsStore(baseDir)
  const list = store.presets[gameId] ?? []
  const preset = list.find((p) => p.id === presetId)
  if (!preset) return { ok: false, error: '未找到指定方案' }

  for (const [charFolder, assignment] of Object.entries(preset.assignments)) {
    if (!isSafeSegment(charFolder)) continue
    let charDir = ''
    try {
      charDir = await resolveCharDir(modsPath, charFolder)
    } catch {
      continue
    }
    if (!(await pathExists(charDir))) continue

    const items = getAssignmentModItems(assignment)
    const targetMap = new Map<string, ModAssignmentItem>()
    for (const item of items) {
      targetMap.set(item.modName.toLowerCase(), item)
    }

    const entries = await fs.readdir(charDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const currentDirName = entry.name
      const cleanModName = currentDirName.replace(/^DISABLED_/i, '')
      const targetItem = targetMap.get(cleanModName.toLowerCase())
      const shouldEnable = Boolean(targetItem)

      const srcPath = path.join(charDir, currentDirName)
      let activePath = srcPath

      if (shouldEnable && /^DISABLED_/i.test(currentDirName)) {
        const destPath = path.join(charDir, cleanModName)
        await fs.rename(srcPath, destPath).catch(() => undefined)
        activePath = destPath
      } else if (!shouldEnable && !/^DISABLED_/i.test(currentDirName)) {
        const destPath = path.join(charDir, `DISABLED_${cleanModName}`)
        await fs.rename(srcPath, destPath).catch(() => undefined)
        activePath = destPath
      }

      // 若选中的 Mod 绑定了单 Mod 变体预设，同时加入聚合队列（跳过单独写 bridge，最后批量合成写入）
      if (shouldEnable && targetItem?.presetId) {
        await applyModPreset(
          baseDir,
          gameId,
          charFolder,
          cleanModName,
          activePath,
          modsPath,
          targetItem.presetId,
          true
        ).catch(() => undefined)
      }
    }
  }

  // 全量合成写入全局 bridge.ini
  await syncBridgeFileFromQueue(modsPath, gameId)

  return { ok: true }
}
