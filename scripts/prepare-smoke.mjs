import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const modsPath = path.join(root, 'scripts', 'fixture', 'Mods')
const userData = path.join(root, '.smoke-data')

fs.mkdirSync(userData, { recursive: true })
fs.rmSync(path.join(userData, 'characters.json'), { force: true })

for (const name of [
  'TestImport',
  'DISABLED_TestImport',
  'RarMod',
  'DISABLED_RarMod'
]) {
  fs.rmSync(path.join(modsPath, '测试角色A', name), { recursive: true, force: true })
}

const settings = {
  schemaVersion: 1,
  activeGameId: 'wuthering-waves',
  games: {
    'wuthering-waves': { modsPath },
    'honkai-star-rail': { modsPath: '' },
    zzz: { modsPath: '' },
    endfield: { modsPath: '' },
    'neverness-to-everness': { modsPath: '' }
  },
  ui: {
    language: 'zh-CN',
    sortCharacters: 'custom',
    sortMods: 'name',
    showHidden: false
  },
  import: {
    deleteArchiveAfter: false,
    overwriteExisting: false
  }
}

fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify(settings, null, 2),
  'utf8'
)

console.log(`smoke fixture ready: ${modsPath}`)
