import { useMemo } from 'react'
import type { CharacterInfo, GameDef, GameSnapshot, UiSettings } from '../../../shared/types'
import { CharacterCard } from '../components/CharacterCard'
import { Icon } from '../components/Icon'

export function LibraryView({
  game,
  snapshot,
  query,
  onQuery,
  sort,
  onSort,
  onOpenCharacter,
  onImport,
  onImportFolder,
  onRefresh,
  onOpenSettings
}: {
  game: GameDef
  snapshot: GameSnapshot
  query: string
  onQuery: (value: string) => void
  sort: UiSettings['sortCharacters']
  onSort: (value: UiSettings['sortCharacters']) => void
  onOpenCharacter: (character: CharacterInfo) => void
  onImport: () => void
  onImportFolder: () => void
  onRefresh: () => void
  onOpenSettings: () => void
}) {
  const characters = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return snapshot.characters
    return snapshot.characters.filter((character) => {
      const haystack = [
        character.displayName,
        character.folder,
        ...character.aliases
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(value)
    })
  }, [query, snapshot.characters])

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <div className="eyebrow" style={{ color: game.accent }}>
            {game.shortName} · {game.loader}
          </div>
          <h1>角色库</h1>
          <p className="muted">
            {snapshot.characters.length} 个角色 · {snapshot.totalMods} 个 Mod ·{' '}
            {snapshot.enabledMods} 个启用
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onRefresh}>
            <Icon name="refresh" size={16} />
            刷新
          </button>
          <button className="btn ghost" onClick={onImportFolder}>
            <Icon name="folder" size={16} />
            导入文件夹
          </button>
          <button className="btn primary" onClick={onImport}>
            <Icon name="upload" size={16} />
            导入 Mod
          </button>
        </div>
      </header>

      {!snapshot.modsPathExists ? (
        <div className="empty-panel">
          <div className="empty-icon">
            <Icon name="box" size={30} />
          </div>
          <h2>{snapshot.settings.modsPath ? 'Mods 目录不存在' : '还没有配置 Mods 目录'}</h2>
          <p className="muted">
            {snapshot.settings.modsPath
              ? snapshot.settings.modsPath
              : `选择 ${game.name} 的 Mods 文件夹后，ModDeck 会自动扫描角色和 Mod。`}
          </p>
          <div className="actions center">
            <button className="btn primary" onClick={onOpenSettings}>
              <Icon name="folder" size={16} />
              打开设置
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <div className="search">
              <Icon name="search" size={16} />
              <input
                className="input"
                placeholder="搜索角色、别名、目录名"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
              />
            </div>
            <select
              className="select"
              value={sort}
              onChange={(event) => onSort(event.target.value as UiSettings['sortCharacters'])}
            >
              <option value="custom">自定义顺序</option>
              <option value="name">按名称</option>
              <option value="count">按 Mod 数量</option>
            </select>
            <button
              className="path-chip"
              title={snapshot.settings.modsPath}
              onClick={onOpenSettings}
            >
              <Icon name="folder" size={14} />
              {snapshot.settings.modsPath}
            </button>
          </div>

          {characters.length === 0 ? (
            <div className="empty-panel">
              <h2>{query ? '没有匹配的角色' : 'Mods 目录是空的'}</h2>
              <p className="muted">
                {query
                  ? '换个关键词试试。'
                  : '把 Mod 压缩包拖进对应角色，或直接导入，ModDeck 会自动识别角色目录。'}
              </p>
            </div>
          ) : (
            <div className="char-grid">
              {characters.map((character) => (
                <CharacterCard
                  key={character.folder}
                  character={character}
                  accent={game.accent}
                  onOpen={() => onOpenCharacter(character)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
