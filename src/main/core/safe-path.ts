import path from 'node:path'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/

export function isSafeSegment(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.length > 160) return false
  if (ILLEGAL.test(name)) return false
  if (/[. ]$/.test(name)) return false
  if (/^[. ]/.test(name)) return false
  if (WINDOWS_RESERVED.test(name)) return false
  return true
}

export function assertSafeSegment(name: string, label = '名称'): string {
  if (!isSafeSegment(name)) {
    throw new Error(`${label}不合法: ${name}`)
  }
  return name
}

/** 把任意字符串变成合法的 Windows 目录名（不保证唯一）。 */
export function sanitizeSegment(raw: string, fallback = 'mod'): string {
  let value = String(raw || '')
    .replace(ILLEGAL, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
  value = value.replace(/^[. ]+/, '').replace(/[. ]+$/, '')
  if (!value) value = fallback
  if (WINDOWS_RESERVED.test(value)) value = `_${value}`
  if (value.length > 120) value = value.slice(0, 120).trim()
  return value || fallback
}

/** target 是否位于 root 之内（含 root 本身）。 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function assertInside(root: string, target: string, label = '路径'): string {
  if (!isInside(root, target)) throw new Error(`${label}越界: ${target}`)
  return target
}
