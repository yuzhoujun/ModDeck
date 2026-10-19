import fs from 'node:fs/promises'
import path from 'node:path'

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true })
}

export async function readdirSafe(target: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(target, { withFileTypes: true })
  } catch {
    return []
  }
}

export async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 跨盘符时 rename 会失败，回退到复制再删除。 */
export async function movePath(source: string, destination: string): Promise<void> {
  await ensureDir(path.dirname(destination))
  try {
    await fs.rename(source, destination)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw error
  }
  await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true })
  await fs.rm(source, { recursive: true, force: true })
}

/** 在 dir 下生成不冲突的名字：name, name (2), name (3) … */
export async function uniqueName(dir: string, name: string): Promise<string> {
  let candidate = name
  for (let index = 2; index < 1000; index += 1) {
    if (!(await pathExists(path.join(dir, candidate)))) return candidate
    candidate = `${name} (${index})`
  }
  throw new Error(`无法为 ${name} 生成唯一名称`)
}

/** 只读的递归目录大小，供详情页使用；失败返回 0。 */
export async function directorySize(target: string, limit = 200_000): Promise<number> {
  let total = 0
  let count = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      count += 1
      if (count > limit) return total
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size
        } catch {
          // ignore
        }
      }
    }
  }
  return total
}
