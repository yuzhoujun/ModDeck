import type { DragEvent } from 'react'
import type { CharacterInfo } from '../../../shared/types'
import { displayNameOf, initialOf } from '../utils'

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
  const name = displayNameOf(character)
  return (
    <button
      className={`char-card${dragging ? ' is-dragging' : ''}`}
      onClick={onOpen}
      title={draggable ? `${character.folder}（拖动排序）` : character.folder}
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
        {!character.known ? <span className="tag new">新</span> : null}
        {character.kind === 'utility' ? <span className="tag utility">功能</span> : null}
      </div>
      <div className="char-meta">
        <div className="char-name" title={name}>
          {name}
        </div>
        <div className="char-sub">
          {character.modCount} 个 Mod
          {character.enabledCount > 0 ? ` · ${character.enabledCount} 启用` : ''}
        </div>
      </div>
    </button>
  )
}
