import type { DragEvent } from 'react'
import type { CharacterInfo } from '../../../shared/types'
import { initialOf } from '../utils'
import { useI18n, getLocaleCharacterName } from '../i18n'

export function CharacterCard({
  character,
  accent,
  onOpen,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  character: CharacterInfo
  accent: string
  onOpen: () => void
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLButtonElement>) => void
  onDrop?: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd?: () => void
}) {
  const { t, effectiveLocale } = useI18n()
  const name = getLocaleCharacterName(character, effectiveLocale)

  return (
    <button
      className={`char-card${dragging ? ' is-dragging' : ''}`}
      onClick={onOpen}
      title={draggable ? `${character.folder} (${t('library.dragFolderHint')})` : character.folder}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="char-cover" style={{ background: `linear-gradient(145deg, ${accent}33, #141a25)` }}>
        {character.coverUrl ? (
          <img src={character.coverUrl} alt="" loading="lazy" />
        ) : (
          <span className="char-initial" style={{ color: accent }}>
            {initialOf(name)}
          </span>
        )}
        {!character.known ? <span className="tag new">{effectiveLocale === 'zh-CN' ? '新' : 'NEW'}</span> : null}
        {character.kind === 'utility' ? (
          <span className="tag utility">{effectiveLocale === 'zh-CN' ? '功能' : 'UTIL'}</span>
        ) : null}
      </div>
      <div className="char-meta">
        <div className="char-name" title={name}>
          {name}
        </div>
        <div className="char-sub">
          {t('common.modsCount', { count: character.modCount })}
          {character.enabledCount > 0 ? ` · ${t('common.enabledCount', { count: character.enabledCount })}` : ''}
        </div>
      </div>
    </button>
  )
}
