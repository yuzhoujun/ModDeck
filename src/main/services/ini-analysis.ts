import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CharacterHashConflict,
  ConflictAuditModLocation,
  ConflictSeverity,
  EnvironmentCheck,
  GameConflictAuditItem,
  GameConflictAuditReport,
  GameId,
  IniCommandDependency,
  IniHashDeclaration,
  IniVariableInfo,
  ModStaticAnalysis
} from '../../shared/types'
import { pathExists } from '../core/fsx'
import { isModFolderEffectivelyEnabled, resolveCharacterDir } from './library'

export const MOD_IGNORE_FILE = '.moddeck-ignore'

/**
 * 内置临时/UI/交互/帧动画类瞬态变量过滤规则。
 */
export const BUILTIN_TRANSIENT_VAR_PATTERNS = [
  /(?:\\|_)(?:menu|elem|drag|seen|info|page|sub|lang|ref_w|ref_h|off_x|off_y|offset_x|offset_y|offset_x_px|offset_y_px|slider|cursor|screen|click|hover|active_elem|buttons)(?:_|\b)/i,
  /\\ssmtdrag_efmi_/i,
  /\\tg_gui_anim_/i,
  /\\(?:tg_)?shapekey_\d+\b/i,
  /\\(?:show_time|inited|finished|begin_time|delta|ui4_finished|ww|wh|mod_in_use)\b/i
]

function normalizeVarShortName(keyOrName: string): string {
  const clean = keyOrName.trim().toLowerCase()
  const idx = clean.lastIndexOf('\\')
  const tail = idx >= 0 ? clean.slice(idx + 1) : clean
  return tail.replace(/^\$+/, '')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchesIgnoreRule(varKeyOrName: string, rule: string): boolean {
  const rawRule = rule.trim()
  if (!rawRule || rawRule.startsWith('#') || rawRule.startsWith(';')) return false

  const fullKey = varKeyOrName.trim().toLowerCase()
  const shortName = normalizeVarShortName(fullKey)

  if (rawRule.startsWith('/') && rawRule.lastIndexOf('/') > 0) {
    const lastSlash = rawRule.lastIndexOf('/')
    const body = rawRule.slice(1, lastSlash)
    const flags = rawRule.slice(lastSlash + 1) || 'i'
    try {
      const rx = new RegExp(body, flags.includes('i') ? flags : `${flags}i`)
      return rx.test(fullKey) || rx.test(shortName) || rx.test(`$${shortName}`)
    } catch {
      return false
    }
  }

  const normalizedRule = rawRule.toLowerCase().replace(/^\$+/, '')
  if (!normalizedRule) return false

  if (normalizedRule.includes('*')) {
    const rxText = `^${normalizedRule.split('*').map(escapeRegExp).join('.*')}$`
    try {
      const rx = new RegExp(rxText, 'i')
      return rx.test(shortName) || rx.test(fullKey.replace(/^\$\\?/, ''))
    } catch {
      return false
    }
  }

  if (normalizedRule.includes('\\')) {
    const rulePath = normalizedRule.replace(/^\\+/, '')
    const keyPath = fullKey.replace(/^\$\\?/, '')
    return keyPath === rulePath || keyPath.endsWith(`\\${rulePath}`)
  }

  return shortName === normalizedRule
}

export function classifyVariableFilter(
  varKeyOrName: string,
  globalRules: string[] = [],
  localRules: string[] = []
): { ignored: boolean; source?: 'builtin' | 'global' | 'local' } {
  if (BUILTIN_TRANSIENT_VAR_PATTERNS.some((rx) => rx.test(varKeyOrName))) {
    return { ignored: true, source: 'builtin' }
  }
  for (const rule of localRules) {
    if (matchesIgnoreRule(varKeyOrName, rule)) {
      return { ignored: true, source: 'local' }
    }
  }
  for (const rule of globalRules) {
    if (matchesIgnoreRule(varKeyOrName, rule)) {
      return { ignored: true, source: 'global' }
    }
  }
  return { ignored: false }
}

export async function readLocalIgnoreRules(
  modPath: string
): Promise<{ exists: boolean; rules: string[] }> {
  if (!modPath) return { exists: false, rules: [] }
  const ignorePath = path.join(modPath, MOD_IGNORE_FILE)
  if (!(await pathExists(ignorePath))) return { exists: false, rules: [] }
  try {
    const raw = await fs.readFile(ignorePath, 'utf8')
    const rules = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => Boolean(line) && !line.startsWith('#') && !line.startsWith(';'))
    return { exists: true, rules: Array.from(new Set(rules)) }
  } catch {
    return { exists: true, rules: [] }
  }
}

export async function appendLocalIgnoreRule(modPath: string, rule: string): Promise<void> {
  const cleaned = rule.trim()
  if (!cleaned) return
  const ignorePath = path.join(modPath, MOD_IGNORE_FILE)
  const existing = await readLocalIgnoreRules(modPath)
  if (existing.rules.some((item) => item.toLowerCase() === cleaned.toLowerCase())) return

  let prefix = ''
  if (existing.exists) {
    const current = await fs.readFile(ignorePath, 'utf8').catch(() => '')
    prefix = current && !current.endsWith('\n') ? `${current}\r\n` : current
  } else {
    prefix = '# ModDeck variable ignore rules (one variable name, wildcard *, or /regex/ per line)\r\n'
  }
  await fs.writeFile(ignorePath, `${prefix}${cleaned}\r\n`, 'utf8')
}

async function collectModIniFiles(
  modPath: string,
  skipDisabledDirs = false
): Promise<{ active: string[]; disabled: string[] }> {
  const active: string[] = []
  const disabled: string[] = []

  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (skipDisabledDirs && entry.isDirectory() && /^disabled/i.test(entry.name)) continue
      const full = path.join(current, entry.name)
      const nextRel = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        await walk(full, nextRel)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.ini') && lower !== 'desktop.ini') {
        if (/^disabled/i.test(entry.name)) disabled.push(nextRel)
        else active.push(nextRel)
      }
    }
  }

  await walk(modPath, '')
  return { active, disabled }
}

function stripIniComment(line: string): string {
  const idx = line.indexOf(';')
  return (idx >= 0 ? line.slice(0, idx) : line).trim()
}

function classifyHashKind(sectionName: string): 'texture' | 'shader' | 'other' {
  const lower = sectionName.toLowerCase()
  if (lower.startsWith('shaderoverride') || lower.startsWith('shaderregex') || lower.startsWith('customshader')) {
    return 'shader'
  }
  if (lower.startsWith('textureoverride')) {
    return 'texture'
  }
  return 'other'
}

interface ParsedSection {
  name: string
  lowerName: string
  file: string
  runs: string[]
  condVars: Set<string>
  writeVars: Set<string>
}

function extractVarTokens(expr: string): string[] {
  const found = new Set<string>()
  const namespaced = expr.matchAll(/\$\\[^\s=!<>&|()+\-*/%,;]+/g)
  for (const m of namespaced) {
    found.add(normalizeVarShortName(m[0]))
  }
  const simple = expr.matchAll(/\$([a-zA-Z0-9_]+)/g)
  for (const m of simple) {
    if (m[1]) found.add(m[1].toLowerCase())
  }
  return [...found]
}

async function readIniSafe(fullPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(fullPath)
    if (stat.size > 2 * 1024 * 1024) return null
    return await fs.readFile(fullPath, 'utf8')
  } catch {
    return null
  }
}

export async function analyzeModIni(
  modPath: string,
  globalRules: string[] = []
): Promise<ModStaticAnalysis> {
  const localIgnore = await readLocalIgnoreRules(modPath)
  const { active, disabled } = await collectModIniFiles(modPath)
  const allInis = [...active, ...disabled]

  const varMap = new Map<
    string,
    {
      key: string
      name: string
      defaultValue: string
      persist: boolean
      sourceFile: string
    }
  >()
  const hashes: IniHashDeclaration[] = []
  const sections = new Map<string, ParsedSection>()
  const activeSet = new Set(active)

  for (const rel of allInis) {
    const content = await readIniSafe(path.join(modPath, rel))
    if (!content) continue

    const isActiveFile = activeSet.has(rel)
    let ns = ''
    let currentSection = ''
    const cleanRel = rel
      .split(path.sep)
      .map((p) => p.replace(/^disabled_/i, ''))
      .join('\\')

    for (const rawLine of content.split(/\r?\n/)) {
      const trimmed = rawLine.trim()
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue

      const sectionMatch = trimmed.match(/^\[([^\]]+)\]/)
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim()
        if (isActiveFile) {
          const lowerSec = currentSection.toLowerCase()
          if (!sections.has(lowerSec)) {
            sections.set(lowerSec, {
              name: currentSection,
              lowerName: lowerSec,
              file: rel,
              runs: [],
              condVars: new Set(),
              writeVars: new Set()
            })
          }
        }
        continue
      }

      const line = stripIniComment(trimmed)
      if (!line) continue

      const nsMatch = line.match(/^namespace\s*=\s*(.+)$/i)
      if (nsMatch) {
        ns = nsMatch[1].trim().replace(/\//g, '\\')
        continue
      }

      const declMatch = line.match(
        /^(global\s+persist|persist\s+global|persist|global)\s+\$([a-zA-Z0-9_]+)\s*=\s*(.+)$/i
      )
      if (declMatch) {
        const kw = declMatch[1].toLowerCase()
        const isPersist = kw.includes('persist')
        const varName = declMatch[2].trim()
        const defaultVal = declMatch[3].trim()
        const key = (ns ? `$\\${ns}\\${varName}` : `$\\${cleanRel}\\${varName}`).toLowerCase()
        const prev = varMap.get(key)
        if (!prev || (!prev.persist && isPersist)) {
          varMap.set(key, {
            key,
            name: varName,
            defaultValue: defaultVal,
            persist: isPersist,
            sourceFile: rel
          })
        }
        continue
      }

      if (!isActiveFile || !currentSection) continue
      const sec = sections.get(currentSection.toLowerCase())
      if (!sec) continue

      const hashMatch = line.match(/^hash\s*=\s*([0-9a-f]{4,16})\b/i)
      if (hashMatch) {
        const kind = classifyHashKind(currentSection)
        if (kind !== 'other') {
          hashes.push({
            hash: hashMatch[1].toLowerCase(),
            kind,
            section: currentSection,
            file: rel
          })
        }
        continue
      }

      const runMatch = line.match(/^run\s*=\s*([a-zA-Z0-9_.\-\\]+)/i)
      if (runMatch) {
        sec.runs.push(runMatch[1].trim().toLowerCase())
        continue
      }

      const condMatch = line.match(/^(?:else\s+)?if\s+(.+)$/i)
      if (condMatch) {
        for (const v of extractVarTokens(condMatch[1])) {
          sec.condVars.add(v)
        }
        continue
      }

      const writeMatch = line.match(/^\$(?:\\[^\s=]+|([a-zA-Z0-9_]+))\s*=/i)
      if (writeMatch) {
        const target = writeMatch[1]
          ? writeMatch[1].toLowerCase()
          : normalizeVarShortName(line.split('=')[0])
        if (target) sec.writeVars.add(target)
      }
    }
  }

  // BFS 浅层推导 Key / Present / CommandList 调用链路
  const keyDrivenMap = new Map<string, Set<string>>()
  const varUsedSectionsMap = new Map<string, Set<string>>()
  const varWrittenVarsCluster = new Map<string, Set<string>>()
  const dependencies: IniCommandDependency[] = []
  const depKeys = new Set<string>()
  const writtenVars = new Set<string>()
  const condOverrideVars = new Set<string>()

  for (const sec of sections.values()) {
    for (const v of sec.writeVars) writtenVars.add(v)
    for (const v of sec.condVars) {
      if (!varUsedSectionsMap.has(v)) varUsedSectionsMap.set(v, new Set())
      varUsedSectionsMap.get(v)!.add(sec.name)
      if (
        sec.lowerName.startsWith('textureoverride') ||
        sec.lowerName.startsWith('shaderoverride') ||
        sec.lowerName.startsWith('commandlist')
      ) {
        condOverrideVars.add(v)
      }
    }
  }

  for (const sec of sections.values()) {
    const isEntryTrigger =
      sec.lowerName.startsWith('key') ||
      sec.lowerName.startsWith('present') ||
      sec.lowerName.startsWith('commandlist')
    if (!isEntryTrigger) continue

    const visited = new Set<string>([sec.lowerName])
    const queue: Array<{ lowerName: string; depth: number }> = [{ lowerName: sec.lowerName, depth: 0 }]
    const chainVars = new Set<string>([...sec.writeVars, ...sec.condVars])

    while (queue.length > 0) {
      const current = queue.shift()!
      const curSec = sections.get(current.lowerName)
      if (!curSec) continue
      for (const v of curSec.writeVars) chainVars.add(v)
      for (const v of curSec.condVars) chainVars.add(v)

      if (current.depth >= 6) continue
      for (const targetLower of curSec.runs) {
        const targetSec = sections.get(targetLower)
        if (targetSec) {
          const depId = `${sec.name}->${targetSec.name}:run`
          if (!depKeys.has(depId) && dependencies.length < 60) {
            depKeys.add(depId)
            const relVars = Array.from(new Set([...targetSec.writeVars, ...targetSec.condVars]))
            if (relVars.length > 0) {
              dependencies.push({
                triggerSection: sec.name,
                targetSection: targetSec.name,
                relation: 'run',
                variables: relVars
              })
            }
          }
        }
        if (!visited.has(targetLower)) {
          visited.add(targetLower)
          queue.push({ lowerName: targetLower, depth: current.depth + 1 })
        }
      }
    }

    if (sec.lowerName.startsWith('key')) {
      for (const v of chainVars) {
        if (!keyDrivenMap.has(v)) keyDrivenMap.set(v, new Set())
        keyDrivenMap.get(v)!.add(sec.name)
      }
    }
    if (chainVars.size > 1) {
      for (const v of chainVars) {
        if (!varWrittenVarsCluster.has(v)) varWrittenVarsCluster.set(v, new Set())
        for (const other of chainVars) {
          if (other !== v) varWrittenVarsCluster.get(v)!.add(other)
        }
      }
    }
  }

  // 建立条件依赖摘要：变量 -> 使用它的 TextureOverride/ShaderOverride/CommandList
  for (const sec of sections.values()) {
    if (
      sec.condVars.size > 0 &&
      (sec.lowerName.startsWith('textureoverride') || sec.lowerName.startsWith('shaderoverride'))
    ) {
      const varsArr = [...sec.condVars]
      const depId = `cond->${sec.name}`
      if (!depKeys.has(depId) && dependencies.length < 60) {
        depKeys.add(depId)
        dependencies.push({
          triggerSection: varsArr.map((v) => `$${v}`).join(', '),
          targetSection: sec.name,
          relation: 'condition',
          variables: varsArr
        })
      }
    }
  }

  const variables: IniVariableInfo[] = []
  const nonPersistControlVars: string[] = []

  for (const entry of varMap.values()) {
    const shortLower = entry.name.toLowerCase()
    const filter = classifyVariableFilter(entry.key, globalRules, localIgnore.rules)
    const drivenByKeys = Array.from(keyDrivenMap.get(shortLower) ?? [])
    const usedInSections = Array.from(varUsedSectionsMap.get(shortLower) ?? [])
    const linkedVars = Array.from(varWrittenVarsCluster.get(shortLower) ?? [])

    if (!entry.persist && !filter.ignored && writtenVars.has(shortLower) && condOverrideVars.has(shortLower)) {
      nonPersistControlVars.push(entry.name)
    }

    variables.push({
      key: entry.key,
      name: entry.name,
      defaultValue: entry.defaultValue,
      persist: entry.persist,
      ignored: filter.ignored,
      ignoreSource: filter.source,
      sourceFile: entry.sourceFile,
      drivenByKeys,
      usedInSections,
      linkedVars
    })
  }

  variables.sort((a, b) => {
    if (a.persist !== b.persist) return a.persist ? -1 : 1
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  return {
    variables,
    dependencies,
    hashes,
    nonPersistControlVars: Array.from(new Set(nonPersistControlVars)),
    localIgnoreRules: localIgnore.rules,
    hasLocalIgnoreFile: localIgnore.exists
  }
}

export async function scanCharacterHashConflicts(
  modsPath: string,
  characterFolder: string
): Promise<CharacterHashConflict[]> {
  const characterDir = await resolveCharacterDir(modsPath, characterFolder)
  const entries = await fs.readdir(characterDir, { withFileTypes: true }).catch(() => [])

  const hashBucket = new Map<
    string,
    {
      kind: 'texture' | 'shader' | 'other'
      mods: Map<
        string,
        {
          folderName: string
          name: string
          sections: Set<string>
          files: Set<string>
          lines: Set<number>
        }
      >
    }
  >()

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || /^DISABLED/i.test(entry.name)) {
      continue
    }
    const modPath = path.join(characterDir, entry.name)
    if (!(await isModFolderEffectivelyEnabled(entry.name, modPath))) continue

    const { active } = await collectModIniFiles(modPath, true)
    for (const rel of active) {
      const content = await readIniSafe(path.join(modPath, rel))
      if (!content) continue

      let currentSection = ''
      const rawLines = content.split(/\r?\n/)
      for (let i = 0; i < rawLines.length; i += 1) {
        const lineNum = i + 1
        const trimmed = rawLines[i].trim()
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue

        const sectionMatch = trimmed.match(/^\[([^\]]+)\]/)
        if (sectionMatch) {
          currentSection = sectionMatch[1].trim()
          continue
        }

        const line = stripIniComment(trimmed)
        if (!line || !currentSection) continue
        const hashMatch = line.match(/^hash\s*=\s*([0-9a-f]{4,16})\b/i)
        if (!hashMatch) continue

        const kind = classifyHashKind(currentSection)
        if (kind === 'other') continue
        const hash = hashMatch[1].toLowerCase()

        let bucket = hashBucket.get(hash)
        if (!bucket) {
          bucket = { kind, mods: new Map() }
          hashBucket.set(hash, bucket)
        }
        let modRec = bucket.mods.get(entry.name)
        if (!modRec) {
          modRec = {
            folderName: entry.name,
            name: entry.name.replace(/^DISABLED_/i, ''),
            sections: new Set(),
            files: new Set(),
            lines: new Set()
          }
          bucket.mods.set(entry.name, modRec)
        }
        modRec.sections.add(currentSection)
        modRec.files.add(rel)
        modRec.lines.add(lineNum)
      }
    }
  }

  const conflicts: CharacterHashConflict[] = []
  for (const [hash, bucket] of hashBucket.entries()) {
    if (bucket.mods.size < 2) continue
    conflicts.push({
      hash,
      kind: bucket.kind,
      severity: bucket.kind === 'shader' ? 'high' : 'warning',
      mods: Array.from(bucket.mods.values()).map((m) => ({
        folderName: m.folderName,
        name: m.name,
        sections: Array.from(m.sections),
        files: Array.from(m.files),
        lines: Array.from(m.lines).sort((a, b) => a - b)
      }))
    })
  }

  conflicts.sort((a, b) => a.hash.localeCompare(b.hash))
  return conflicts
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string

interface ParsedConflictSection {
  section: string
  lowerSection: string
  startLine: number
  file: string
  hashes: Array<{ hash: string; line: number; kind: 'texture' | 'shader' | 'other' }>
  filterIndex?: string
  hasHandlingSkip: boolean
}

function isKnownSafeShaderOverride(
  gameId: GameId,
  sectionName: string,
  filterIndex: string | undefined,
  relPath: string
): boolean {
  const lowerRel = relPath.toLowerCase()
  const lowerSec = sectionName.toLowerCase()
  const fi = (filterIndex || '').trim()

  // RabbitFX 与 CrossIBClassifier 插件本体声明的共享着色器通道属于正常工作流
  if (lowerRel.includes('rabbitfx') || lowerRel.includes('crossibclassifier') || lowerRel.includes('katfxmatcap')) {
    return true
  }
  if (gameId === 'endfield' || fi === '1718.1' || fi === '1718.2' || /^20[0-5](?:\.|$)/.test(fi)) {
    if (fi === '1718.1' || fi === '1718.2' || /^20[0-5](?:\.|$)/.test(fi)) {
      return true
    }
  }
  if (lowerSec.includes('rabbitfx') || lowerSec.includes('crossib')) {
    return true
  }
  return false
}

function isLikelyFxPluginMod(folderName: string, activeFiles: string[], contentList: string[]): boolean {
  const hay = `${folderName} ${activeFiles.join(' ')}`.toLowerCase()
  if (/(rabbitfx|crossibclassifier|katfxmatcap|shadertweaks|globalshader|fxplugin)/i.test(hay)) {
    return true
  }
  return contentList.some((c) => /CrossIBClassifier|RabbitFX/i.test(c))
}

async function hasDirectActiveIni(dirPath: string): Promise<boolean> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [])
  return entries.some(
    (e) => e.isFile() && e.name.toLowerCase().endsWith('.ini') && e.name.toLowerCase() !== 'desktop.ini' && !/^disabled/i.test(e.name)
  )
}

function severityWeight(s: ConflictSeverity): number {
  if (s === 'high') return 3
  if (s === 'warning') return 2
  return 1
}

export async function auditGameModsConflicts(
  gameId: GameId,
  modsPath: string,
  environment: EnvironmentCheck | undefined,
  t: TranslateFn
): Promise<GameConflictAuditReport> {
  const items: GameConflictAuditItem[] = []
  let scannedMods = 0
  let scannedIniFiles = 0

  // 1. 环境级前置检查：ShaderFixes 残留与 ShaderCache 提示
  if (environment?.shaderFixes?.dirExists && environment.shaderFixes.fileCount > 0) {
    items.push({
      id: 'env:shader-fixes',
      severity: 'warning',
      category: 'shader-fixes',
      message: t('audit.shaderFixesTitle', { count: environment.shaderFixes.fileCount }),
      detail: t('audit.shaderFixesDesc', {
        samples: environment.shaderFixes.sampleFiles.join(', ')
      }),
      locations: []
    })
  }
  if (environment?.shaderCache?.dirExists && environment.shaderCache.fileCount > 0) {
    items.push({
      id: 'env:shader-cache',
      severity: 'info',
      category: 'shader-cache',
      message: t('audit.shaderCacheTitle', {
        count: environment.shaderCache.fileCount
      }),
      detail: environment.shaderCache.enabledInIni
        ? t('audit.shaderCacheEnabledDesc')
        : t('audit.shaderCacheFilesDesc'),
      locations: []
    })
  }

  if (!modsPath || !(await pathExists(modsPath))) {
    return {
      gameId,
      modsPath: modsPath || '',
      scannedAt: Date.now(),
      scannedMods,
      scannedIniFiles,
      environment,
      items,
      summary: {
        high: items.filter((i) => i.severity === 'high').length,
        warning: items.filter((i) => i.severity === 'warning').length,
        info: items.filter((i) => i.severity === 'info').length
      }
    }
  }

  // 2. 收集全部已启用 Mod 单元（兼容根目录独立插件与 Mods/<角色>/<Mod> 两级目录）
  interface ModScanUnit {
    characterFolder: string
    folderName: string
    name: string
    modPath: string
  }
  const modUnits: ModScanUnit[] = []
  const topEntries = await fs.readdir(modsPath, { withFileTypes: true }).catch(() => [])
  for (const top of topEntries) {
    if (!top.isDirectory() || top.name.startsWith('.') || /^disabled/i.test(top.name)) continue
    const topPath = path.join(modsPath, top.name)
    if (await hasDirectActiveIni(topPath)) {
      modUnits.push({
        characterFolder: '',
        folderName: top.name,
        name: top.name.replace(/^DISABLED_/i, ''),
        modPath: topPath
      })
      continue
    }
    const subEntries = await fs.readdir(topPath, { withFileTypes: true }).catch(() => [])
    let pushedSub = false
    for (const sub of subEntries) {
      if (!sub.isDirectory() || sub.name.startsWith('.') || /^disabled/i.test(sub.name)) continue
      const subPath = path.join(topPath, sub.name)
      if (!(await isModFolderEffectivelyEnabled(sub.name, subPath))) continue
      modUnits.push({
        characterFolder: top.name,
        folderName: sub.name,
        name: sub.name.replace(/^DISABLED_/i, ''),
        modPath: subPath
      })
      pushedSub = true
    }
    if (!pushedSub) {
      // 检查是否多层嵌套直接含 ini 的插件包
      const { active } = await collectModIniFiles(topPath, true)
      if (active.length > 0) {
        modUnits.push({
          characterFolder: '',
          folderName: top.name,
          name: top.name.replace(/^DISABLED_/i, ''),
          modPath: topPath
        })
      }
    }
  }

  const rabbitFxLocations: ConflictAuditModLocation[] = []
  const crossIbLocations: ConflictAuditModLocation[] = []
  const katFxLocations: ConflictAuditModLocation[] = []

  // 按角色分桶的 Hash 声明：characterFolder -> hash -> entries
  const charHashMap = new Map<
    string,
    Map<
      string,
      {
        kind: 'texture' | 'shader' | 'other'
        locs: ConflictAuditModLocation[]
      }
    >
  >()
  // 全局 ShaderOverride hash 碰撞桶
  const globalShaderOverrideHashMap = new Map<string, ConflictAuditModLocation[]>()

  for (const unit of modUnits) {
    scannedMods += 1
    const { active } = await collectModIniFiles(unit.modPath, true)
    const activeTexts: string[] = []
    const sectionsParsed: ParsedConflictSection[] = []

    for (const rel of active) {
      scannedIniFiles += 1
      const content = await readIniSafe(path.join(unit.modPath, rel))
      if (!content) continue
      activeTexts.push(content)

      const lowerRel = rel.toLowerCase()
      const baseIniName = path.basename(rel).toLowerCase()
      if (baseIniName === 'rabbitfx.ini' || /rabbitfx/i.test(unit.folderName) && lowerRel === baseIniName) {
        rabbitFxLocations.push({
          characterFolder: unit.characterFolder,
          folderName: unit.folderName,
          name: unit.name,
          file: rel,
          line: 1
        })
      }
      if (baseIniName === 'crossibclassifier.ini') {
        crossIbLocations.push({
          characterFolder: unit.characterFolder,
          folderName: unit.folderName,
          name: unit.name,
          file: rel,
          line: 1
        })
      }
      if (/katfxmatcap/i.test(baseIniName) || /katfxmatcap/i.test(unit.folderName)) {
        katFxLocations.push({
          characterFolder: unit.characterFolder,
          folderName: unit.folderName,
          name: unit.name,
          file: rel,
          line: 1
        })
      }

      const lines = content.split(/\r?\n/)
      let current: ParsedConflictSection | null = null
      for (let i = 0; i < lines.length; i += 1) {
        const lineNum = i + 1
        const trimmed = lines[i].trim()
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue

        const secMatch = trimmed.match(/^\[([^\]]+)\]/)
        if (secMatch) {
          const secName = secMatch[1].trim()
          current = {
            section: secName,
            lowerSection: secName.toLowerCase(),
            startLine: lineNum,
            file: rel,
            hashes: [],
            hasHandlingSkip: false
          }
          sectionsParsed.push(current)
          continue
        }

        if (!current) continue
        const clean = stripIniComment(trimmed)
        if (!clean) continue

        const fiMatch = clean.match(/^filter_index\s*=\s*(.+)$/i)
        if (fiMatch) {
          current.filterIndex = fiMatch[1].trim()
        }
        if (/^handling\s*=\s*skip\b/i.test(clean)) {
          current.hasHandlingSkip = true
        }
        const hMatch = clean.match(/^hash\s*=\s*([0-9a-f]{4,16})\b/i)
        if (hMatch) {
          const hash = hMatch[1].toLowerCase()
          const kind = classifyHashKind(current.section)
          current.hashes.push({ hash, line: lineNum, kind })

          if (unit.characterFolder && kind !== 'other') {
            let bucketByHash = charHashMap.get(unit.characterFolder)
            if (!bucketByHash) {
              bucketByHash = new Map()
              charHashMap.set(unit.characterFolder, bucketByHash)
            }
            let entry = bucketByHash.get(hash)
            if (!entry) {
              entry = { kind, locs: [] }
              bucketByHash.set(hash, entry)
            }
            entry.locs.push({
              characterFolder: unit.characterFolder,
              folderName: unit.folderName,
              name: unit.name,
              file: rel,
              line: lineNum,
              section: current.section
            })
          }
        }
      }
    }

    const isPlugin = isLikelyFxPluginMod(unit.folderName, active, activeTexts)

    for (const sec of sectionsParsed) {
      if (sec.lowerSection.startsWith('shaderregex') && !isPlugin) {
        items.push({
          id: `regex:${unit.characterFolder}/${unit.folderName}:${sec.file}:${sec.startLine}`,
          severity: 'warning',
          category: 'embedded-shader-regex',
          message: t('audit.embeddedShaderRegexTitle', { mod: unit.name, section: sec.section }),
          detail: t('audit.embeddedShaderRegexDesc'),
          locations: [
            {
              characterFolder: unit.characterFolder,
              folderName: unit.folderName,
              name: unit.name,
              file: sec.file,
              line: sec.startLine,
              section: sec.section
            }
          ]
        })
      }

      if (sec.lowerSection.startsWith('shaderoverride')) {
        const safe = isKnownSafeShaderOverride(gameId, sec.section, sec.filterIndex, sec.file)
        for (const h of sec.hashes) {
          const loc: ConflictAuditModLocation = {
            characterFolder: unit.characterFolder,
            folderName: unit.folderName,
            name: unit.name,
            file: sec.file,
            line: h.line,
            section: sec.section
          }
          const arr = globalShaderOverrideHashMap.get(h.hash) || []
          arr.push(loc)
          globalShaderOverrideHashMap.set(h.hash, arr)

          if (!safe && sec.hasHandlingSkip) {
            items.push({
              id: `so-skip:${unit.folderName}:${sec.file}:${h.line}`,
              severity: 'warning',
              category: 'shader-override',
              message: t('audit.shaderOverrideRiskTitle', { mod: unit.name, hash: h.hash }),
              detail: t('audit.shaderOverrideRiskDesc', { section: sec.section }),
              hash: h.hash,
              filterIndex: sec.filterIndex,
              locations: [loc]
            })
          }
        }
      }
    }
  }

  // 去重插件位置按 Mod 目录归并
  const dedupeByMod = (locs: ConflictAuditModLocation[]): ConflictAuditModLocation[] => {
    const seen = new Set<string>()
    const out: ConflictAuditModLocation[] = []
    for (const l of locs) {
      const k = `${l.characterFolder}/${l.folderName}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(l)
    }
    return out
  }

  const rabbitMods = dedupeByMod(rabbitFxLocations)
  if (rabbitMods.length > 1) {
    items.push({
      id: 'dup:rabbitfx',
      severity: 'high',
      category: 'duplicate-fx-plugin',
      message: t('audit.dupPluginTitle', { plugin: 'RabbitFX', count: rabbitMods.length }),
      detail: t('audit.dupPluginDesc'),
      locations: rabbitMods
    })
  }

  const crossIbMods = dedupeByMod(crossIbLocations)
  if (crossIbMods.length > 1) {
    items.push({
      id: 'dup:crossib',
      severity: 'high',
      category: 'duplicate-fx-plugin',
      message: t('audit.dupPluginTitle', {
        plugin: 'CrossIBClassifier.ini',
        count: crossIbMods.length
      }),
      detail: t('audit.dupPluginDesc'),
      locations: crossIbMods
    })
  }

  const katMods = dedupeByMod(katFxLocations)
  if (rabbitMods.length > 0 && katMods.length > 0) {
    items.push({
      id: 'mutex:rabbitfx-katfx',
      severity: 'high',
      category: 'mutually-exclusive-fx',
      message: t('audit.mutexFxTitle'),
      detail: t('audit.mutexFxDesc'),
      locations: [...rabbitMods, ...katMods]
    })
  }

  // 全局同 ShaderOverride Hash 被多个不同 Mod 声明
  for (const [hash, locs] of globalShaderOverrideHashMap.entries()) {
    const distinctMods = dedupeByMod(locs)
    if (distinctMods.length < 2) continue
    items.push({
      id: `global-so:${hash}`,
      severity: 'high',
      category: 'shader-override',
      message: t('audit.globalShaderOverrideConflictTitle', {
        hash,
        count: distinctMods.length
      }),
      detail: t('audit.globalShaderOverrideConflictDesc'),
      hash,
      locations: locs
    })
  }

  // 角色内同 Hash 多 Mod 重叠
  for (const [charFolder, hashMap] of charHashMap.entries()) {
    for (const [hash, bucket] of hashMap.entries()) {
      const distinctMods = dedupeByMod(bucket.locs)
      if (distinctMods.length < 2) continue
      items.push({
        id: `char-hash:${charFolder}:${hash}`,
        severity: bucket.kind === 'shader' ? 'high' : 'warning',
        category: 'hash-collision',
        message: t('audit.charHashConflictTitle', {
          character: charFolder,
          hash,
          count: distinctMods.length
        }),
        detail: t('audit.charHashConflictDesc', { kind: bucket.kind }),
        hash,
        locations: bucket.locs
      })
    }
  }

  items.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))

  return {
    gameId,
    modsPath,
    scannedAt: Date.now(),
    scannedMods,
    scannedIniFiles,
    environment,
    items,
    summary: {
      high: items.filter((i) => i.severity === 'high').length,
      warning: items.filter((i) => i.severity === 'warning').length,
      info: items.filter((i) => i.severity === 'info').length
    }
  }
}

export function formatConflictAuditReportText(
  gameName: string,
  report: GameConflictAuditReport,
  t: TranslateFn
): string {
  const lines: string[] = []
  lines.push('============================================================')
  lines.push(`ModDeck Conflict Audit Report - ${gameName} (${report.gameId})`)
  lines.push(`Generated At : ${new Date(report.scannedAt).toLocaleString()}`)
  lines.push(`Mods Path    : ${report.modsPath || '-'}`)
  lines.push(
    `Scanned      : ${report.scannedMods} enabled mod(s), ${report.scannedIniFiles} .ini file(s)`
  )
  lines.push(
    `Summary      : HIGH=${report.summary.high}, WARNING=${report.summary.warning}, INFO=${report.summary.info}`
  )
  if (report.environment) {
    const env = report.environment
    lines.push(`d3dx.ini     : ${env.status} (${env.d3dxPath || '-'})`)
    if (env.shaderCache) {
      lines.push(
        `ShaderCache  : cache_shaders=${env.shaderCache.enabledInIni === null ? 'unset' : env.shaderCache.enabledInIni ? '1' : '0'}, files=${env.shaderCache.fileCount}`
      )
    }
    if (env.shaderFixes) {
      lines.push(`ShaderFixes  : files=${env.shaderFixes.fileCount}`)
    }
  }
  lines.push('============================================================')
  lines.push('')

  if (report.items.length === 0) {
    lines.push(t('audit.noIssuesFound'))
    return lines.join('\r\n')
  }

  for (const item of report.items) {
    lines.push(`[${item.severity.toUpperCase()}] [${item.category}] ${item.message}`)
    if (item.detail) lines.push(`  Detail: ${item.detail}`)
    for (const loc of item.locations) {
      const modLabel = loc.characterFolder ? `${loc.characterFolder}/${loc.name}` : loc.name
      const lineSuffix = loc.line > 0 ? `:${loc.line}` : ''
      const secSuffix = loc.section ? ` [${loc.section}]` : ''
      lines.push(`  - ${modLabel} -> ${loc.file}${lineSuffix}${secSuffix}`)
    }
    lines.push('')
  }

  return lines.join('\r\n')
}
