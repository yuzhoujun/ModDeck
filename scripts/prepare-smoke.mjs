import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const temp = path.join(root, 'temp')
const fixture = path.join(temp, 'fixture')
const modsPath = path.join(fixture, 'Mods')
const importSource = path.join(fixture, 'import-source', 'TestImport')
const userData = path.join(temp, 'smoke-data')

fs.rmSync(fixture, { recursive: true, force: true })
fs.rmSync(userData, { recursive: true, force: true })

const ini = '[KeySwap]\nkey = F6\ncondition = $active\n\n[TextureOverrideTest]\nhash = 12345678\n'

function writeMod(character, mod, text) {
  const dir = path.join(modsPath, character, mod)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mod.ini'), text, 'utf8')
}

writeMod('测试角色A', '泳装Mod', ini)
writeMod('测试角色A', 'DISABLED_旧Mod', ini)
writeMod('新角色B', '新衣服', ini)

// 验证角色目录默认封面：新命名 .preview.png + 旧命名 _cover.png 兜底。
const coverSource = path.join(root, 'docs', 'screenshot-character.png')
if (fs.existsSync(coverSource)) {
  fs.copyFileSync(coverSource, path.join(modsPath, '测试角色A', '.preview.png'))
  fs.copyFileSync(coverSource, path.join(modsPath, '新角色B', '_cover.png'))
}

fs.mkdirSync(importSource, { recursive: true })
fs.writeFileSync(path.join(importSource, 'mod.ini'), '[TextureOverrideImport]\nhash = 87654321\n', 'utf8')

fs.mkdirSync(userData, { recursive: true })

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

fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')

console.log(`smoke fixture ready: ${modsPath}`)
