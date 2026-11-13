import type { CharacterInfo, ModInfo } from '../../shared/types'

export function initialOf(value: string): string {
  const text = String(value || '').trim()
  if (!text) return '?'
  const first = Array.from(text)[0]
  return first.toUpperCase()
}

export function formatDate(timestamp: number): string {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

export function displayNameOf(character: CharacterInfo): string {
  return character.displayName || character.folder
}

export function modCountLabel(count: number): string {
  return count === 1 ? '1 Mod' : `${count} Mods`
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const text = String(error ?? '')
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function modMatches(mod: ModInfo, query: string): boolean {
  const value = query.trim().toLowerCase()
  if (!value) return true
  return (
    mod.name.toLowerCase().includes(value) ||
    mod.folderName.toLowerCase().includes(value)
  )
}

export function formatSyncAge(
  mtimeMs: number,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (!mtimeMs) return ''
  const sec = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000))
  if (sec < 3) return t('preset.syncTimeJustNow')
  if (sec < 60) return t('preset.syncTimeSeconds', { n: sec })
  return t('preset.syncTimeMinutes', { n: Math.floor(sec / 60) })
}
