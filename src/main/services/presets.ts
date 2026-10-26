import path from 'node:path'
import fs from 'node:fs/promises'
import type { GameId, ModVariantPreset, ToggleResult } from '../../shared/types'
import { ensureDir, pathExists, readJsonSafe, writeJsonAtomic } from '../core/fsx'
import { isInside, isSafeSegment } from '../core/safe-path'

const PRESETS_FILE = 'mod-presets.json'

interface ModPresetsStore {
  schemaVersion: 1
  presets: Record<string, ModVariantPreset[]> // key: `${gameId}:${characterFolder}:${modName}`
}

async function getPresetsFilePath(baseDir: string): Promise<string> {
  await ensureDir(baseDir)
  return path.join(baseDir, PRESETS_FILE)
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

function makeModKey(gameId: GameId, characterFolder: string, modName: string): string {
  const cleanMod = modName.replace(/^DISABLED_/i, '')
  return `${gameId}:${characterFolder}:${cleanMod}`
}

export async function getModPresets(
  baseDir: string,
  gameId: GameId,
  characterFolder: string,
  modFolder: string
): Promise<ModVariantPreset[]> {
  const store = await loadModPresetsStore(baseDir)
  const key = makeModKey(gameId, characterFolder, modFolder)
  return store.presets[key] ?? []
}

/**
 * 递归收集 Mod 目录下的全部 ini 相对路径及其当前启用状态
 */
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
  // 保存当前所有处于激活状态的 .ini 文件相对于 Mod 根目录的路径（规范为标准正名）
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

  // 递归调整该 Mod 下的全部 .ini 文件：如果在 desiredActiveNorm 中，去掉 DISABLED_；否则加上 DISABLED_
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
  const store = await loadModPresetsStore(baseDir)
  const key = makeModKey(gameId, characterFolder, modFolder)
  const list = store.presets[key] ?? []
  const filtered = list.filter((p) => p.id !== presetId)
  if (filtered.length === list.length) return { ok: false, error: '未找到该预设' }

  store.presets[key] = filtered
  await saveModPresetsStore(baseDir, store)
  return { ok: true }
}
