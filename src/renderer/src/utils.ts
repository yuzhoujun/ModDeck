import type { CharacterInfo, ModInfo } from '../../shared/types'

export function initialOf(value: string): string {
  const text = String(value || '').trim()
  if (!text) return '?'
  const first = Array.from(text)[0]
  return first.toUpperCase()
}

export function formatDate(timestamp: number): string {
  if (!timestamp) return '未知'
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

export function displayNameOf(character: CharacterInfo): string {
  return character.displayName || character.folder
}

export function modCountLabel(count: number): string {
  return `${count} 个 Mod`
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
