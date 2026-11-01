import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LOCALES_DIR = path.resolve(ROOT, 'src/shared/i18n/locales')
const BASE_LOCALE = 'zh-CN'
const CHINESE_REGEX = /[\u4e00-\u9fa5]/

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

// Deep sort object keys alphabetically
function sortObject(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj
  const sorted = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObject(obj[key])
  }
  return sorted
}

// Flatten nested object to dot notation: { a: { b: 'c' } } => ['a.b']
function flattenKeys(obj, prefix = '') {
  let keys = []
  for (const k of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      keys = keys.concat(flattenKeys(obj[k], full))
    } else {
      keys.push(full)
    }
  }
  return keys
}

// Invert base locale object: value -> dotKey
function buildValueToKeyMap(baseObj) {
  const map = new Map()
  function walk(obj, prefix = '') {
    for (const k of Object.keys(obj)) {
      const full = prefix ? `${prefix}.${k}` : k
      const val = obj[k]
      if (typeof val === 'string') {
        const trimmed = val.trim()
        if (trimmed && !map.has(trimmed)) {
          map.set(trimmed, full)
        }
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        walk(val, full)
      }
    }
  }
  walk(baseObj)
  return map
}

// Deep sync target object to base object structure
function syncStructure(base, target, fillMissing = (key, baseVal) => baseVal) {
  const result = {}
  for (const key of Object.keys(base)) {
    const baseVal = base[key]
    const targetVal = target ? target[key] : undefined
    if (typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal)) {
      result[key] = syncStructure(baseVal, typeof targetVal === 'object' ? targetVal : {}, fillMissing)
    } else {
      if (targetVal !== undefined && typeof targetVal === typeof baseVal) {
        result[key] = targetVal
      } else {
        result[key] = fillMissing(key, baseVal)
      }
    }
  }
  return sortObject(result)
}

// Deep merge source into target without overwriting existing leaf values
function deepMerge(target, source) {
  const output = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      if (key in target && typeof target[key] === 'object') {
        output[key] = deepMerge(target[key], source[key])
      } else {
        output[key] = source[key]
      }
    } else {
      if (!(key in output)) {
        output[key] = source[key]
      }
    }
  }
  return output
}

// Scan files for t('...') and tMain('...') calls that are missing in baseKeys
function scanMissingUsedKeys(baseKeysSet) {
  const srcDir = path.resolve(ROOT, 'src')
  const missing = []

  function scan(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        scan(full)
      } else if (ent.isFile() && /\.(tsx|ts)$/.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8')
        const regex = /\b(?:t|tMain)\(\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)['"]/g
        let match
        while ((match = regex.exec(text)) !== null) {
          const key = match[1]
          if (!baseKeysSet.has(key)) {
            missing.push({ key, file: path.relative(ROOT, full) })
          }
        }
      }
    }
  }

  scan(srcDir)
  return missing
}

// Precise scanner for hardcoded Chinese text in source code
function scanAllHardcodedChinese() {
  const scanDirs = [
    path.resolve(ROOT, 'src/renderer/src'),
    path.resolve(ROOT, 'src/main'),
    path.resolve(ROOT, 'src/preload'),
    path.resolve(ROOT, 'src/shared')
  ]

  const results = []

  function scanFile(filePath) {
    const rel = path.relative(ROOT, filePath).replace(/\\/g, '/')
    if (
      rel.includes('locales/') ||
      rel.includes('smoke') ||
      rel.includes('core/roster.ts') ||
      rel.endsWith('.d.ts')
    ) {
      return
    }

    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    let inMultiComment = false
    let inSmokeSection = false

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]

      // Skip smoke test blocks in main/index.ts
      if (line.includes('async function runSmokeTests')) {
        inSmokeSection = true
      }
      if (inSmokeSection) {
        if (line.startsWith('function ') || line.startsWith('async function ') && !line.includes('runSmokeTests')) {
          inSmokeSection = false
        } else {
          continue
        }
      }

      // Handle multi-line comment state
      if (inMultiComment) {
        const endIdx = line.indexOf('*/')
        if (endIdx !== -1) {
          inMultiComment = false
          line = line.slice(endIdx + 2)
        } else {
          continue
        }
      }

      // Strip single-line comments FIRST (avoids // res/*.png false positive)
      const singleCommentIdx = line.indexOf('//')
      if (singleCommentIdx !== -1) {
        line = line.slice(0, singleCommentIdx)
      }

      // Strip intra-line or opening multi-line comments
      let startCommentIdx = line.indexOf('/*')
      while (startCommentIdx !== -1) {
        const endIdx = line.indexOf('*/', startCommentIdx + 2)
        if (endIdx !== -1) {
          line = line.slice(0, startCommentIdx) + line.slice(endIdx + 2)
          startCommentIdx = line.indexOf('/*')
        } else {
          inMultiComment = true
          line = line.slice(0, startCommentIdx)
          break
        }
      }

      if (!CHINESE_REGEX.test(line)) continue

      // Skip logging statements
      if (/\b(console\.(log|warn|error|info)|logError|startupLog)\s*\(/.test(line)) continue

      // Match string literals: '...', "...", `...`
      const strRegex = /(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`)/g
      let match
      while ((match = strRegex.exec(line)) !== null) {
        const literal = (match[1] ?? match[2] ?? match[3] ?? '').trim()
        if (CHINESE_REGEX.test(literal)) {
          // Ignore regex patterns or locale tags
          if (literal.startsWith('/') && literal.endsWith('/')) continue
          if (/^zh-|^en-|^ja-/.test(literal)) continue
          if (literal.length < 2) continue

          results.push({
            file: rel,
            line: i + 1,
            raw: literal
          })
        }
      }
    }
  }

  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
      } else if (ent.isFile() && /\.(tsx|ts)$/.test(ent.name)) {
        scanFile(full)
      }
    }
  }

  for (const d of scanDirs) walk(d)
  return results
}

// Generate a clean suggested dotKey for untranslated Chinese text
function suggestKey(text, filePath) {
  // Common keyword mapping
  if (/选择.*目录|选择.*文件夹/.test(text)) return `dialog.pickFolder`
  if (/选择.*程序|选择.*可执行/.test(text)) return `dialog.pickGameExe`
  if (/选择.*封面/.test(text)) return `dialog.pickCover`
  if (/选择.*预览/.test(text)) return `dialog.pickPreview`
  if (/选择.*压缩包/.test(text)) return `dialog.pickArchive`
  if (/退出.*ModDeck/.test(text)) return `tray.quit`
  if (/打开.*ModDeck/.test(text)) return `tray.open`
  if (/快捷窗口/.test(text)) return `tray.overlay`
  if (/未配置.*Mods/.test(text)) return `common.modsDirNotConfigured`
  if (/不合法|无效|参数错误/.test(text)) return `common.invalidParam`
  if (/不存在/.test(text)) return `common.notFound`
  if (/同名.*已存在|已存在/.test(text)) return `common.alreadyExists`
  if (/成功/.test(text)) return `common.success`
  if (/失败/.test(text)) return `common.failed`

  // Namespace based on file
  let ns = 'common'
  if (filePath.includes('src/main')) ns = 'main'
  else if (filePath.includes('views/SettingsView')) ns = 'settings'
  else if (filePath.includes('views/LibraryView')) ns = 'library'
  else if (filePath.includes('components/Character')) ns = 'character'
  else if (filePath.includes('components/Mod')) ns = 'mod'
  else if (filePath.includes('Overlay')) ns = 'overlay'

  // Hash or simple identifier based on characters
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 8)
  return `${ns}.auto_${clean}`
}

const command = process.argv[2] || 'check'

if (command === 'extract') {
  const shouldApply = process.argv.includes('--apply')
  console.log('🔍 Scanning codebase for hardcoded Chinese text (src/main, src/renderer, src/preload, src/shared)...\n')

  const baseFile = path.join(LOCALES_DIR, `${BASE_LOCALE}.json`)
  const baseData = fs.existsSync(baseFile) ? loadJson(baseFile) : {}
  const valueToKeyMap = buildValueToKeyMap(baseData)

  const rawItems = scanAllHardcodedChinese()
  const uniqueMap = new Map()

  for (const item of rawItems) {
    if (!uniqueMap.has(item.raw)) {
      uniqueMap.set(item.raw, {
        text: item.raw,
        existingKey: valueToKeyMap.get(item.raw) || null,
        suggestedKey: suggestKey(item.raw, item.file),
        occurrences: []
      })
    }
    uniqueMap.get(item.raw).occurrences.push({ file: item.file, line: item.line })
  }

  const allEntries = Array.from(uniqueMap.values())
  const alreadyMapped = allEntries.filter((e) => e.existingKey !== null)
  const unmapped = allEntries.filter((e) => e.existingKey === null)

  console.log('============================================================')
  console.log(`📊 Total Chinese Literals Found : ${rawItems.length}`)
  console.log(`✨ Unique Chinese Strings       : ${allEntries.length}`)
  console.log(`✅ Already Present in zh-CN.json: ${alreadyMapped.length} (can directly use t(key))`)
  console.log(`⚠️ Unmapped / New Strings       : ${unmapped.length}`)
  console.log('============================================================\n')

  // Group by file for summary
  const byFile = {}
  for (const item of rawItems) {
    byFile[item.file] = (byFile[item.file] || 0) + 1
  }
  console.log('📁 Breakdown by file:')
  Object.keys(byFile)
    .sort((a, b) => byFile[b] - byFile[a])
    .forEach((f) => {
      console.log(`  📄 ${f.padEnd(50)} : ${byFile[f]} occurrences`)
    })
  console.log('')

  // Build structured JSON tree for unmapped items
  const extractedTree = {}
  for (const entry of unmapped) {
    const key = entry.suggestedKey
    const parts = key.split('.')
    let curr = extractedTree
    for (let i = 0; i < parts.length - 1; i++) {
      curr[parts[i]] = curr[parts[i]] || {}
      curr = curr[parts[i]]
    }
    curr[parts[parts.length - 1]] = entry.text
  }

  const extractedPath = path.resolve(__dirname, 'extracted-zh-CN.json')
  writeJson(extractedPath, sortObject(extractedTree))
  console.log(`💾 Structured extracted JSON saved to: ${extractedPath}`)

  const reportPath = path.resolve(__dirname, 'extracted-details.json')
  writeJson(reportPath, allEntries)
  console.log(`📋 Detailed occurrence report saved to: ${reportPath}`)

  if (shouldApply) {
    console.log('\n🚀 Applying extracted strings into locales/zh-CN.json and syncing to en-US.json...')
    const mergedZh = deepMerge(baseData, extractedTree)
    writeJson(baseFile, sortObject(mergedZh))
    console.log(`✅ Base [zh-CN.json] updated with ${unmapped.length} new entries.`)

    // Sync en-US
    const enFile = path.join(LOCALES_DIR, 'en-US.json')
    const enData = fs.existsSync(enFile) ? loadJson(enFile) : {}
    const syncedEn = syncStructure(mergedZh, enData, (k, val) => `[TODO: ${val}]`)
    writeJson(enFile, syncedEn)
    console.log(`✅ en-US.json synchronized with new [TODO: ...] entries ready for translation!`)
    console.log(`\n💡 Run \`git diff src/shared/i18n/locales\` to inspect the newly added translation items.`)
  } else {
    console.log('\n💡 Tip: Run `npm run i18n:extract -- --apply` to automatically merge newly extracted keys into zh-CN.json and sync to en-US.json!')
  }
} else if (command === 'check') {
  console.log('🔍 Checking i18n locales against base (zh-CN)...')
  const baseFile = path.join(LOCALES_DIR, `${BASE_LOCALE}.json`)
  if (!fs.existsSync(baseFile)) {
    console.error(`Base locale file not found: ${baseFile}`)
    process.exit(1)
  }
  const baseData = loadJson(baseFile)
  const baseKeys = flattenKeys(baseData)
  console.log(`Base [${BASE_LOCALE}] total keys: ${baseKeys.length}`)

  let hasError = false
  for (const file of fs.readdirSync(LOCALES_DIR)) {
    if (!file.endsWith('.json') || file === `${BASE_LOCALE}.json`) continue
    const targetFile = path.join(LOCALES_DIR, file)
    const targetData = loadJson(targetFile)
    const targetKeys = flattenKeys(targetData)
    const lang = file.replace('.json', '')

    const missing = baseKeys.filter((k) => !targetKeys.includes(k))
    const extra = targetKeys.filter((k) => !baseKeys.includes(k))

    console.log(`\nLocale [${lang}]: total ${targetKeys.length} keys`)
    if (missing.length > 0) {
      console.warn(`  ⚠️ Missing ${missing.length} keys:`)
      missing.slice(0, 10).forEach((k) => console.warn(`    - ${k}`))
      if (missing.length > 10) console.warn(`    ... and ${missing.length - 10} more`)
      hasError = true
    }
    if (extra.length > 0) {
      console.warn(`  ℹ️ Redundant/Extra ${extra.length} keys:`)
      extra.slice(0, 5).forEach((k) => console.warn(`    + ${k}`))
    }
    if (missing.length === 0 && extra.length === 0) {
      console.log(`  ✅ 100% matched with base!`)
    }
  }

  console.log('\n🔍 Checking code t(...) and tMain(...) calls against base locale...')
  const baseKeysSet = new Set(baseKeys)
  const missingUsed = scanMissingUsedKeys(baseKeysSet)
  if (missingUsed.length === 0) {
    console.log('  ✅ All t(...) and tMain(...) keys used in code exist in base locale!')
  } else {
    console.warn(`  ⚠️ Found ${missingUsed.length} i18n calls missing from base locale:`)
    missingUsed.forEach((m) => console.warn(`    - ${m.key} (in ${m.file})`))
    hasError = true
  }

  console.log('\n🔍 Scanning for untranslated Chinese text...')
  const hardcoded = scanAllHardcodedChinese()
  const valueToKeyMap = buildValueToKeyMap(baseData)
  const unmapped = hardcoded.filter((item) => !valueToKeyMap.has(item.raw))
  console.log(`Found ${hardcoded.length} total Chinese literals, ${unmapped.length} unmapped in base dictionary.`)
  if (unmapped.length > 0) {
    console.log('Sample unmapped items:')
    unmapped.slice(0, 8).forEach((item) => console.log(`  ${item.file}:${item.line} -> "${item.raw}"`))
    if (unmapped.length > 8) console.log(`  ... and ${unmapped.length - 8} more`)
    console.log('\n💡 Tip: Run `npm run i18n:extract` to see full report or `--apply` to merge them!')
  }

  if (hasError) {
    console.log('\n💡 Tip: Run `npm run i18n:sync` to automatically sync key structures!')
    process.exitCode = 1
  }
} else if (command === 'sync') {
  console.log('🔄 Synchronizing all locales with base (zh-CN)...')
  const baseFile = path.join(LOCALES_DIR, `${BASE_LOCALE}.json`)
  const baseData = loadJson(baseFile)

  writeJson(baseFile, sortObject(baseData))
  console.log(`✅ Base [${BASE_LOCALE}] formatted & sorted.`)

  for (const file of fs.readdirSync(LOCALES_DIR)) {
    if (!file.endsWith('.json') || file === `${BASE_LOCALE}.json`) continue
    const targetFile = path.join(LOCALES_DIR, file)
    const targetData = loadJson(targetFile)
    const lang = file.replace('.json', '')

    const synced = syncStructure(baseData, targetData, (key, baseVal) => {
      console.log(`  [${lang}] Added missing key: ${key}`)
      return `[TODO: ${baseVal}]`
    })

    writeJson(targetFile, synced)
    console.log(`✅ Locale [${lang}] synchronized (${flattenKeys(synced).length} keys).`)
  }
} else if (command === 'new') {
  const targetLang = process.argv[3]
  if (!targetLang) {
    console.error('Usage: node scripts/i18n.mjs new <locale-name> (e.g. ja-JP)')
    process.exit(1)
  }
  const baseFile = path.join(LOCALES_DIR, `${BASE_LOCALE}.json`)
  const targetFile = path.join(LOCALES_DIR, `${targetLang}.json`)
  if (fs.existsSync(targetFile)) {
    console.error(`Target locale file already exists: ${targetFile}`)
    process.exit(1)
  }
  const baseData = loadJson(baseFile)
  const template = syncStructure(baseData, {}, (key, val) => `[TODO: ${val}]`)
  writeJson(targetFile, template)
  console.log(`🎉 Created new locale template: ${targetFile}`)
} else {
  console.log('Unknown command. Available: check, sync, extract [--apply], new <locale>')
}
