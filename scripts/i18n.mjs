import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const LOCALES_DIR = path.resolve(ROOT, 'src/shared/i18n/locales')
const BASE_LOCALE = 'zh-CN'

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

// Deep sort object keys
function sortObject(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj
  const sorted = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObject(obj[key])
  }
  return sorted
}

// Flatten nested object to dot notation
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

// Scan files for hardcoded Chinese outside t(...) and comments
function scanHardcodedChinese() {
  const srcDir = path.resolve(ROOT, 'src/renderer/src')
  const results = []
  const chineseRegex = /[\u4e00-\u9fa5]/

  function scan(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        scan(full)
      } else if (ent.isFile() && /\.(tsx|ts)$/.test(ent.name)) {
        const lines = fs.readFileSync(full, 'utf8').split('\n')
        lines.forEach((line, i) => {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('{/*')) return
          if (chineseRegex.test(line)) {
            // Filter out lines where all Chinese is wrapped in t('...') or t("...") or fallback comments
            // Quick check: does it have raw Chinese not inside t(...)
            const withoutT = line.replace(/t\([^)]+\)/g, '')
            if (chineseRegex.test(withoutT)) {
              results.push({ file: path.relative(ROOT, full), line: i + 1, text: trimmed })
            }
          }
        })
      }
    }
  }

  scan(srcDir)
  return results
}

const command = process.argv[2] || 'check'

if (command === 'extract') {
  console.log('🔍 Scanning src/renderer/src for hardcoded Chinese text...\n')
  const items = scanHardcodedChinese()
  const grouped = {}
  for (const item of items) {
    grouped[item.file] = grouped[item.file] || []
    grouped[item.file].push(item)
  }

  console.log('📊 Summary of untranslated Chinese text by file:')
  console.log('------------------------------------------------------------')
  let total = 0
  const sortedFiles = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length)
  for (const f of sortedFiles) {
    console.log(`  📄 ${f.padEnd(45)} : ${grouped[f].length} occurrences`)
    total += grouped[f].length
  }
  console.log('------------------------------------------------------------')
  console.log(`Total untranslated lines found: ${total} across ${sortedFiles.length} files.\n`)

  const reportPath = path.resolve(__dirname, 'untranslated-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(grouped, null, 2), 'utf8')
  console.log(`💾 Detailed report saved to: ${reportPath}`)
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

  console.log('\n🔍 Scanning for untranslated Chinese text in src/renderer/src...')
  const hardcoded = scanHardcodedChinese()
  const nonT = hardcoded.filter((item) => !item.text.includes("t('") && !item.text.includes('t("'))
  console.log(`Found ${nonT.length} lines potentially containing raw Chinese:`)
  nonT.slice(0, 15).forEach((item) => console.log(`  ${item.file}:${item.line} -> ${item.text.slice(0, 60)}`))
  if (nonT.length > 15) console.log(`  ... and ${nonT.length - 15} more lines`)

  if (hasError) {
    console.log('\n💡 Tip: Run `npm run i18n:sync` to automatically sync key structures!')
  }
} else if (command === 'sync') {
  console.log('🔄 Synchronizing all locales with base (zh-CN)...')
  const baseFile = path.join(LOCALES_DIR, `${BASE_LOCALE}.json`)
  const baseData = loadJson(baseFile)

  // Write sorted base
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
  console.log('Unknown command. Available: check, sync, extract, new <locale>')
}
