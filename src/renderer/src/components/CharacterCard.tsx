import type { CharacterInfo } from '../../../shared/types'
import { displayNameOf, initialOf } from '../utils'

export function CharacterCard({
  character,
  accent,
  onOpen
}: {
  character: CharacterInfo
  accent: string
  onOpen: () => void
}) {
  const name = displayNameOf(character)
  return (
    <button className="char-card" onClick={onOpen} title={character.folder}>
      <div className="char-cover" style={{ background: `linear-gradient(145deg, ${accent}33, #141a25)` }}>
        {character.coverUrl ? (
          <img src={character.coverUrl} alt="" loading="lazy" />
        ) : (
          <span className="char-initial" style={{ color: accent }}>
            {initialOf(name)}
          </span>
        )}
        {!character.known ? <span className="tag new">新</span> : null}
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
