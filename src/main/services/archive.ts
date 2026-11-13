import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { path7za } from '7zip-bin'
import { isInside } from '../core/safe-path'

const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar'])

/**
 * CP437 0x80..0xFF 对应的 128 个 Unicode 字符（与 DOS OEM 437 一一对应）。
 * 当 7za 解压早期非 UTF-8 标志的中文 ZIP 压缩包时，会将 GBK/CP936 字节流按 CP437 映射为这些字符。
 */
const CP437_HIGH_CHARS =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5' +
  '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567' +
  '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
  '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229' +
  '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0'

const CP437_CHAR_TO_BYTE = new Map<number, number>()
for (let i = 0; i < 128; i += 1) {
  CP437_CHAR_TO_BYTE.set(CP437_HIGH_CHARS.charCodeAt(i), 0x80 + i)
}

let gbDecoder: TextDecoder | null = null
try {
  gbDecoder = new TextDecoder('gb18030', { fatal: true })
} catch {
  gbDecoder = null
}

/**
 * 尝试将 CP437 乱码文件名无损还原为 GB18030/GBK 中文字符串。
 * 若原名本就是正常 UTF-8 中文或纯英文，则原样返回。
 */
export function decodeCp437Mojibake(name: string): string {
  if (!gbDecoder || !name) return name
  const bytes: number[] = []
  let highCount = 0
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i)
    if (code < 0x80) {
      bytes.push(code)
    } else {
      const mapped = CP437_CHAR_TO_BYTE.get(code)
      if (mapped === undefined) {
        // 含有非 CP437 字符（例如已经是正常的中文字符），无需还原
        return name
      }
      bytes.push(mapped)
      highCount += 1
    }
  }
  if (highCount < 2) return name
  try {
    const decoded = gbDecoder.decode(new Uint8Array(bytes))
    if (!decoded || decoded === name || decoded.includes('\ufffd')) return name
    // 还原后应当至少包含中文字符、全角标点或日韩假名，避免把合法的西欧拉丁词误转
    if (!/[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(decoded)) {
      return name
    }
    return decoded
  } catch {
    return name
  }
}

export async function fixMojibakeTree(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      }
      const fixedName = decodeCp437Mojibake(entry.name)
      if (fixedName !== entry.name) {
        const target = path.join(dir, fixedName)
        try {
          await fs.rename(full, target)
        } catch {
          // ignore if target exists or locked
        }
      }
    }
  }
  await walk(root)
}

export function isArchiveFile(filePath: string): boolean {
  return ARCHIVE_EXT.has(path.extname(filePath).toLowerCase())
}

/** 打包后 7za.exe 会被 electron-builder 解包到 app.asar.unpacked。 */
const SEVEN_ZIP_PATH = path7za.replace(
  `app.asar${path.sep}`,
  `app.asar.unpacked${path.sep}`
)

function isPasswordErrorText(text: string): boolean {
  return /password|encrypted|wrong password|data error in encrypted file|can not open encrypted archive/i.test(
    text
  )
}

function run7za(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // 传入 -p"" 防止遇到加密压缩包时 7za 在后台无限等待控制台输入密码
    const child = spawn(SEVEN_ZIP_PATH, ['-p', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else if (isPasswordErrorText(output)) {
        reject(new Error('该压缩包带有密码保护，请先自行使用解压软件解压为文件夹后再导入'))
      } else {
        const detail = output.trim().slice(-400)
        reject(
          new Error(
            `压缩包解压失败（退出码 ${code}），文件可能已损坏或受密码保护，建议自行解压为文件夹后导入${detail ? ` (${detail})` : ''}`
          )
        )
      }
    })
  })
}

async function extractRar(archivePath: string, destination: string): Promise<void> {
  try {
    const unrar = (await import('node-unrar-js')) as {
      createExtractorFromFile: (options: {
        filepath: string
        targetPath: string
      }) => Promise<{ extract: () => { files: Iterable<unknown> } }>
    }
    const extractor = await unrar.createExtractorFromFile({
      filepath: archivePath,
      targetPath: destination
    })
    // node-unrar-js 的 extract() 是惰性生成器：必须消费 files 才会真正写盘。
    const result = extractor.extract()
    for (const _entry of result.files) {
      void _entry
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (isPasswordErrorText(msg) || /ERAR_MISSING_PASSWORD|ERAR_BAD_PASSWORD/i.test(msg)) {
      throw new Error('该 RAR 压缩包带有密码保护，请先自行使用解压软件解压为文件夹后再导入')
    }
    throw new Error(`RAR 解压失败（${msg}），若包含密码或分卷请先自行解压为文件夹后再导入`)
  }
}

async function assertTreeInside(root: string): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (!isInside(root, full)) throw new Error('压缩包包含越界路径，已中止解压')
      if (entry.isSymbolicLink()) throw new Error('压缩包包含符号链接，已中止解压')
      if (entry.isDirectory()) stack.push(full)
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipMemoryEntry {
  name: string // relative posix path e.g. 'covers/endfield/a.png'
  data: Buffer
}

export function buildZipBuffer(entries: ZipMemoryEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const posixName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '')
    const nameBuf = Buffer.from(posixName, 'utf8')
    const raw = entry.data
    const crc = crc32(raw)
    const compressed = zlib.deflateRawSync(raw)
    const useDeflate = compressed.length < raw.length
    const payload = useDeflate ? compressed : raw
    const method = useDeflate ? 8 : 0

    // Local file header (30 bytes + name)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0x0800, 6) // UTF-8 filename flag
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(payload.length, 18)
    lfh.writeUInt32LE(raw.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)

    localChunks.push(lfh, nameBuf, payload)

    // Central directory header (46 bytes + name)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(0x0800, 8)
    cdh.writeUInt16LE(method, 10)
    cdh.writeUInt16LE(0, 12)
    cdh.writeUInt16LE(0, 14)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(payload.length, 20)
    cdh.writeUInt32LE(raw.length, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30)
    cdh.writeUInt16LE(0, 32)
    cdh.writeUInt16LE(0, 34)
    cdh.writeUInt16LE(0, 36)
    cdh.writeUInt32LE(0, 38)
    cdh.writeUInt32LE(offset, 42)

    centralChunks.push(cdh, nameBuf)
    offset += lfh.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, centralBuf, eocd])
}

export function readZipBuffer(zipBuf: Buffer): ZipMemoryEntry[] {
  let eocdOffset = -1
  const minOffset = Math.max(0, zipBuf.length - 65558)
  for (let pos = zipBuf.length - 22; pos >= minOffset; pos -= 1) {
    if (zipBuf.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos
      break
    }
  }
  if (eocdOffset < 0) {
    throw new Error('无效的 ZIP / .moddeck-bundle 归档结构')
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10)
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16)
  let ptr = cdOffset
  const out: ZipMemoryEntry[] = []

  for (let i = 0; i < totalEntries; i += 1) {
    if (ptr + 46 > zipBuf.length || zipBuf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('归档中央目录损坏')
    }
    const method = zipBuf.readUInt16LE(ptr + 10)
    const compSize = zipBuf.readUInt32LE(ptr + 20)
    const nameLen = zipBuf.readUInt16LE(ptr + 28)
    const extraLen = zipBuf.readUInt16LE(ptr + 30)
    const commentLen = zipBuf.readUInt16LE(ptr + 32)
    const localHeaderOffset = zipBuf.readUInt32LE(ptr + 42)
    const name = zipBuf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8')
    ptr += 46 + nameLen + extraLen + commentLen

    if (!name || name.endsWith('/')) continue
    if (localHeaderOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`归档条目头损坏: ${name}`)
    }
    const lfhNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26)
    const lfhExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen
    const slice = zipBuf.subarray(dataStart, dataStart + compSize)

    let data: Buffer
    if (method === 0) {
      data = Buffer.from(slice)
    } else if (method === 8) {
      data = zlib.inflateRawSync(slice)
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 (${method}): ${name}`)
    }
    out.push({ name, data })
  }
  return out
}

export async function extractArchive(archivePath: string, destination: string, forceType?: 'zip'): Promise<void> {
  const stat = await fs.stat(archivePath)
  if (!stat.isFile()) throw new Error(`不是文件: ${archivePath}`)
  await fs.mkdir(destination, { recursive: true })

  const ext = path.extname(archivePath).toLowerCase()
  if (ext === '.rar') {
    await extractRar(archivePath, destination)
  } else if (forceType === 'zip' || ext === '.zip' || ext === '.7z' || ext === '.moddeck-bundle') {
    await run7za(['x', '-y', '-bd', `-o${destination}`, archivePath])
  } else {
    throw new Error(`不支持的压缩格式: ${ext || '(无扩展名)'}`)
  }

  await assertTreeInside(destination)
  await fixMojibakeTree(destination)
}
