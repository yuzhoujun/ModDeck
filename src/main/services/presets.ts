import path from 'node:path'
import fs from 'node:fs/promises'
import type {
  GameId,
  ModVariantPreset,
  RosterPreset,
  SaveRosterPresetInput,
  ToggleResult
} from '../../shared/types'
import { ensureDir, pathExists, readJsonSafe, writeJsonAtomic } from '../core/fsx'
import { isInside, isSafeSegment } from '../core/safe-path'

const ROSTER_PRESETS_FILE = 'roster-presets.json'

// 内存 LRU/Map 缓存：`${gameId}:${characterFolder}:${modName}` -> ModVariantPreset[]
const presetsMemoryCache = new Map<string, ModVariantPreset[]>()

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
 * 深入 Mod 目录下的所有 .ini 文件，解析出该 Mod 声明的所有带 persist 或 global 的变量定义与作者出厂默认值
 * 同时识别 namespace（如 namespace = endmin 或 namespace = gujun\test\gui），以此映射变量键
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

        // 匹配 global persist $var = value 或 global $var = value
        const varMatch = line.match(/^global\s+(?:persist\s+)?\$([a-zA-Z0-9_]+)\s*=\s*([^;]+)/i)
        if (varMatch) {
          const varName = varMatch[1].trim()
          let defaultVal = varMatch[2].trim()
          // 去除行末注释
          if (defaultVal.includes(';')) {
            defaultVal = defaultVal.split(';')[0].trim()
          }

          let key = ''
          if (ns) {
            key = `$\\${ns}\\${varName}`
          } else {
            // 没有 namespace 时，3DMigoto 常用格式为：$\mods\角色\Mod名\ini文件名\varName
            const iniBase = path.basename(rel).replace(/^disabled_/i, '')
            key = `$\\${iniBase}\\${varName}`
          }
          defaultVars[key.toLowerCase()] = defaultVal
        }
      }
    } catch {
      // ignore unreadable
    }
  }

  return defaultVars
}

/**
 * 寻找游戏目录下的 d3dx_user.ini
 */
async function findD3dxUserIniPath(modsPath: string): Promise<string | null> {
  // 通常 modsPath 为 .../Mods，d3dx_user.ini 位于父目录（即 EFMI/3DMigoto 根目录）
  const parent = path.dirname(modsPath)
  const candidate1 = path.join(parent, 'd3dx_user.ini')
  if (await pathExists(candidate1)) return candidate1
  const candidate2 = path.join(modsPath, 'd3dx_user.ini')
  if (await pathExists(candidate2)) return candidate2
  return null
}

/**
 * 从 d3dx_user.ini 中提取当前游戏正在生效的变量键值对
 */
export async function readActiveD3dxUserVariables(
  modsPath: string,
  knownKeys?: string[]
): Promise<Record<string, string>> {
  const userIni = await findD3dxUserIniPath(modsPath)
  if (!userIni) return {}

  try {
    const raw = await fs.readFile(userIni, 'utf8')
    const result: Record<string, string> = {}
    const lines = raw.split(/\r?\n/)
    const filterSet = knownKeys ? new Set(knownKeys.map((k) => k.toLowerCase())) : null

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith('$\\') || !line.includes('=')) continue
      const idx = line.indexOf('=')
      const k = line.substring(0, idx).trim().toLowerCase()
      const v = line.substring(idx + 1).trim()
      if (!filterSet || filterSet.has(k)) {
        result[k] = v
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 将指定预设的变量值安全写回 d3dx_user.ini
 */
export async function applyVariablesToD3dxUserIni(
  modsPath: string,
  variables: Record<string, string>
): Promise<boolean> {
  const userIni = await findD3dxUserIniPath(modsPath)
  if (!userIni) return false

  try {
    const raw = await fs.readFile(userIni, 'utf8')
    const lines = raw.split(/\r?\n/)
    const varMap = new Map<string, string>()
    for (const [k, v] of Object.entries(variables)) {
      varMap.set(k.toLowerCase(), v)
    }

    const updatedLines: string[] = []
    const handledKeys = new Set<string>()

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line.startsWith('$\\') && line.includes('=')) {
        const idx = line.indexOf('=')
        const k = line.substring(0, idx).trim().toLowerCase()
        if (varMap.has(k)) {
          const newVal = varMap.get(k)!
          updatedLines.push(`${line.substring(0, idx).trim()} = ${newVal}`)
          handledKeys.add(k)
          continue
        }
      }
      updatedLines.push(rawLine)
    }

    // 若 d3dx_user.ini 之前尚未持久化某些变量，在 [Constants] 后追加
    for (const [k, v] of varMap.entries()) {
      if (!handledKeys.has(k)) {
        updatedLines.push(`${k} = ${v}`)
      }
    }

    await fs.writeFile(userIni, updatedLines.join('\r\n'), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读取某个 Mod 的所有预设方案（优先读缓存，无缓存读分级 JSON）
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
  const cacheKey = `${gameId}:${characterFolder}:${cleanModName}`

  const filePath = await getModPresetFilePath(baseDir, gameId, characterFolder, modFolder)
  let list = await readJsonSafe<ModVariantPreset[] | null>(filePath, null)

  if (!list || !Array.isArray(list)) {
    list = []
  }

  // 确保存在「默认 (初始)」出厂预设
  let defaultPreset = list.find((p) => p.id === '__default__')
  if (!defaultPreset) {
    let defaultInis: string[] = []
    let defaultVars: Record<string, string> = {}

    if (modPath && (await pathExists(modPath))) {
      const iniStatus = await inspectModIniFiles(modPath)
      const allInis = iniStatus.active.length > 0 ? iniStatus.active : iniStatus.disabled
      defaultInis = allInis.map((rel) => {
        const parts = rel.split(path.sep)
        parts[parts.length - 1] = parts[parts.length - 1].replace(/^disabled_/i, '')
        return parts.join('/')
      })

      defaultVars = await inspectModDefaultVariables(modPath)
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
    await writeJsonAtomic(filePath, list)
  }

  presetsMemoryCache.set(cacheKey, list)
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
  const cacheKey = `${gameId}:${characterFolder}:${cleanModName}`

  // 1. 获取当前 ini 启停状态
  const iniStatus = await inspectModIniFiles(modPath)
  const cleanActiveInis = iniStatus.active.map((rel) => {
    const parts = rel.split(path.sep)
    const fileName = parts[parts.length - 1].replace(/^disabled_/i, '')
    parts[parts.length - 1] = fileName
    return parts.join('/')
  })

  // 2. 识别出该 Mod 关联的已知变量键列表，并从 d3dx_user.ini 中提取当前实机运行值
  const defaultVars = await inspectModDefaultVariables(modPath)
  const knownKeys = Object.keys(defaultVars)
  const activeVars = await readActiveD3dxUserVariables(modsPath, knownKeys)

  // 合并：如果 d3dx_user.ini 里有变动取运行时值，若无则取作者默认出厂值
  const currentSnapshotVars: Record<string, string> = { ...defaultVars }
  for (const [k, v] of Object.entries(activeVars)) {
    currentSnapshotVars[k] = v
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
  presetsMemoryCache.set(cacheKey, list)
  return { ok: true }
}

/**
 * 应用该 Mod 的某个指定预设
 */
export async function applyModPreset(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  modPath: string,
  modsPath: string,
  presetId: string
): Promise<ToggleResult> {
  const cleanModName = modFolder.replace(/^DISABLED_/i, '')
  const filePath = await getModPresetFilePath(baseDir, gameId, characterFolder, modFolder)
  const list = (await readJsonSafe<ModVariantPreset[] | null>(filePath, null)) ?? []
  const targetPreset = list.find((p) => p.id === presetId)
  if (!targetPreset) return { ok: false, error: '未找到指定预设' }

  if (!(await pathExists(modPath))) return { ok: false, error: 'Mod 目录不存在' }

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

  // 2. 将预设保存的 variables 写回 d3dx_user.ini
  if (targetPreset.variables && Object.keys(targetPreset.variables).length > 0) {
    await applyVariablesToD3dxUserIni(modsPath, targetPreset.variables)
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
  const cleanModName = modFolder.replace(/^DISABLED_/i, '')
  const cacheKey = `${gameId}:${characterFolder}:${cleanModName}`
  const filePath = await getModPresetFilePath(baseDir, gameId, characterFolder, modFolder)
  const list = (await readJsonSafe<ModVariantPreset[] | null>(filePath, null)) ?? []
  const filtered = list.filter((p) => p.id !== presetId)
  if (filtered.length === list.length) return { ok: false, error: '未找到该预设' }

  await writeJsonAtomic(filePath, filtered)
  presetsMemoryCache.set(cacheKey, filtered)
  return { ok: true }
}

// =========================================================================
// 全局角色池预设（Roster Preset）服务
// =========================================================================

async function getRosterPresetsFilePath(baseDir: string): Promise<string> {
  await ensureDir(baseDir)
  return path.join(baseDir, ROSTER_PRESETS_FILE)
}

export async function loadRosterPresetsStore(baseDir: string): Promise<{ schemaVersion: 1; presets: Record<string, RosterPreset[]> }> {
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
  if (!preset) return { ok: false, error: '未找到指定阵容方案' }

  for (const [charFolder, assignment] of Object.entries(preset.assignments)) {
    if (!isSafeSegment(charFolder)) continue
    let charDir = ''
    try {
      charDir = await resolveCharDir(modsPath, charFolder)
    } catch {
      continue
    }
    if (!(await pathExists(charDir))) continue

    const entries = await fs.readdir(charDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const currentDirName = entry.name
      const cleanModName = currentDirName.replace(/^DISABLED_/i, '')
      const shouldEnable = cleanModName.toLowerCase() === assignment.modName.toLowerCase()

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

      // 如果选中的 Mod 绑定了单 Mod 变体预设，同时应用变体
      if (shouldEnable && assignment.presetId) {
        await applyModPreset(
          baseDir,
          gameId,
          charFolder,
          cleanModName,
          activePath,
          modsPath,
          assignment.presetId
        ).catch(() => undefined)
      }
    }
  }

  return { ok: true }
}
