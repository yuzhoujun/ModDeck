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

const PRESETS_FILE = 'mod-presets.json'
const ROSTER_PRESETS_FILE = 'roster-presets.json'

interface ModPresetsStore {
  schemaVersion: 1
  presets: Record<string, ModVariantPreset[]> // key: `${gameId}:${characterFolder}:${modName}`
}

interface RosterPresetsStore {
  schemaVersion: 1
  presets: Record<string, RosterPreset[]> // key: gameId
}

async function getPresetsFilePath(baseDir: string): Promise<string> {
  await ensureDir(baseDir)
  return path.join(baseDir, PRESETS_FILE)
}

async function getRosterPresetsFilePath(baseDir: string): Promise<string> {
  await ensureDir(baseDir)
  return path.join(baseDir, ROSTER_PRESETS_FILE)
}

export async function loadModPresetsStore(baseDir: string): Promise<ModPresetsStore> {
  const filePath = await getPresetsFilePath(baseDir)
  const data = await readJsonSafe<ModPresetsStore | null>(filePath, null)
  if (data && data.schemaVersion === 1 && typeof data.presets === 'object') {
    return data
  }
  return { schemaVersion: 1, presets: {} }
}

export async function saveModPresetsStore(baseDir: string, store: ModPresetsStore): Promise<void> {
  const filePath = await getPresetsFilePath(baseDir)
  await writeJsonAtomic(filePath, store)
}

export async function loadRosterPresetsStore(baseDir: string): Promise<RosterPresetsStore> {
  const filePath = await getRosterPresetsFilePath(baseDir)
  const data = await readJsonSafe<RosterPresetsStore | null>(filePath, null)
  if (data && data.schemaVersion === 1 && typeof data.presets === 'object') {
    return data
  }
  return { schemaVersion: 1, presets: {} }
}

export async function saveRosterPresetsStore(
  baseDir: string,
  store: RosterPresetsStore
): Promise<void> {
  const filePath = await getRosterPresetsFilePath(baseDir)
  await writeJsonAtomic(filePath, store)
}

function makeModKey(gameId: GameId, characterFolder: string, modName: string): string {
  const cleanMod = modName.replace(/^DISABLED_/i, '')
  return `${gameId}:${characterFolder}:${cleanMod}`
}

export async function getModPresets(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  modPath?: string
): Promise<ModVariantPreset[]> {
  const store = await loadModPresetsStore(baseDir)
  const key = makeModKey(gameId, characterFolder, modFolder)
  const list = store.presets[key] ?? []
  const cleanModName = modFolder.replace(/^DISABLED_/i, '')

  let hasDefault = list.some((p) => p.id === '__default__')
  if (!hasDefault) {
    let defaultInis: string[] = []
    if (modPath && (await pathExists(modPath))) {
      const iniStatus = await inspectModIniFiles(modPath)
      if (iniStatus.active.length > 0) {
        defaultInis = iniStatus.active.map((rel) => {
          const parts = rel.split(path.sep)
          parts[parts.length - 1] = parts[parts.length - 1].replace(/^disabled_/i, '')
          return parts.join('/')
        })
      } else {
        defaultInis = iniStatus.disabled.map((rel) => {
          const parts = rel.split(path.sep)
          parts[parts.length - 1] = parts[parts.length - 1].replace(/^disabled_/i, '')
          return parts.join('/')
        })
      }
    }
    const defaultPreset: ModVariantPreset = {
      id: '__default__',
      name: '默认 (初始)',
      modName: cleanModName,
      characterFolder,
      activeIniFiles: defaultInis,
      updatedAt: 0
    }
    list.unshift(defaultPreset)
    store.presets[key] = list
    await saveModPresetsStore(baseDir, store)
  }

  return list
}

async function inspectModIniFiles(modPath: string): Promise<{ active: string[]; disabled: string[] }> {
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

export async function saveModPreset(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  modPath: string,
  presetName: string
): Promise<ToggleResult> {
  const name = presetName.trim()
  if (!name) return { ok: false, error: '预设名称不能为空' }
  if (!(await pathExists(modPath))) return { ok: false, error: 'Mod 目录不存在' }

  const iniStatus = await inspectModIniFiles(modPath)
  const cleanActiveInis = iniStatus.active.map((rel) => {
    const parts = rel.split(path.sep)
    const fileName = parts[parts.length - 1].replace(/^disabled_/i, '')
    parts[parts.length - 1] = fileName
    return parts.join('/')
  })

  const store = await loadModPresetsStore(baseDir)
  const key = makeModKey(gameId, characterFolder, modFolder)
  const cleanModName = modFolder.replace(/^DISABLED_/i, '')
  const list = store.presets[key] ?? []

  const existingIndex = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())
  const newPreset: ModVariantPreset = {
    id: existingIndex >= 0 ? list[existingIndex].id : `preset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    modName: cleanModName,
    characterFolder,
    activeIniFiles: cleanActiveInis,
    updatedAt: Date.now()
  }

  if (existingIndex >= 0) {
    list[existingIndex] = newPreset
  } else {
    list.push(newPreset)
  }

  store.presets[key] = list
  await saveModPresetsStore(baseDir, store)
  return { ok: true }
}

export async function applyModPreset(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string,
  modPath: string,
  presetId: string
): Promise<ToggleResult> {
  const store = await loadModPresetsStore(baseDir)
  const key = makeModKey(gameId, characterFolder, modFolder)
  const list = store.presets[key] ?? []
  const targetPreset = list.find((p) => p.id === presetId)
  if (!targetPreset) return { ok: false, error: '未找到指定预设' }

  if (!(await pathExists(modPath))) return { ok: false, error: 'Mod 目录不存在' }

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
  return { ok: true }
}

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
  const store = await loadModPresetsStore(baseDir)
  const key = makeModKey(gameId, characterFolder, modFolder)
  const list = store.presets[key] ?? []
  const filtered = list.filter((p) => p.id !== presetId)
  if (filtered.length === list.length) return { ok: false, error: '未找到该预设' }

  store.presets[key] = filtered
  await saveModPresetsStore(baseDir, store)
  return { ok: true }
}

// =========================================================================
// 2.2.2 全局角色池预设（Roster Preset）服务
// =========================================================================

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

/**
 * 应用全局角色池预设：
 * 遍历指定角色目录，将选中的 Mod 设为启用（去 DISABLED_），其余同角色下的 Mod 设为禁用（加 DISABLED_）；
 * 若配置了单 Mod 内部预设 variantPresetId，同时就地切换该 Mod 内部的 .ini 文件。
 */
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
          assignment.presetId
        ).catch(() => undefined)
      }
    }
  }

  return { ok: true }
}
