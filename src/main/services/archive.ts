import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { path7za } from '7zip-bin'
import { isInside } from '../core/safe-path'

const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar'])

export function isArchiveFile(filePath: string): boolean {
  return ARCHIVE_EXT.has(path.extname(filePath).toLowerCase())
}

/** 打包后 7za.exe 会被 electron-builder 解包到 app.asar.unpacked。 */
const SEVEN_ZIP_PATH = path7za.replace(
  `app.asar${path.sep}`,
  `app.asar.unpacked${path.sep}`
)

function run7za(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SEVEN_ZIP_PATH, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`7-Zip 解压失败（退出码 ${code}）${stderr ? `: ${stderr.slice(-600)}` : ''}`))
      }
    })
  })
}

async function extractRar(archivePath: string, destination: string): Promise<void> {
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

export async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const stat = await fs.stat(archivePath)
  if (!stat.isFile()) throw new Error(`不是文件: ${archivePath}`)
  await fs.mkdir(destination, { recursive: true })

  const ext = path.extname(archivePath).toLowerCase()
  if (ext === '.rar') {
    await extractRar(archivePath, destination)
  } else if (ext === '.zip' || ext === '.7z') {
    await run7za(['x', '-y', '-bd', `-o${destination}`, archivePath])
  } else {
    throw new Error(`不支持的压缩格式: ${ext || '(无扩展名)'}`)
  }

  await assertTreeInside(destination)
}
