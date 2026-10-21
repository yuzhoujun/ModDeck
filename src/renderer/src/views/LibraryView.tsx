import { useMemo, useState } from 'react'
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
  filter,
  onFilter,
  onOpenCharacter,
  onImport,
  onImportFolder,
  onRefresh,
  onOpenSettings,
  onLaunchGame,
  onLaunchLoader,
  onReorderCharacters
}: {
  game: GameDef
  snapshot: GameSnapshot
  query: string
  onQuery: (value: string) => void
  sort: UiSettings['sortCharacters']
  onSort: (value: UiSettings['sortCharacters']) => void
  filter: UiSettings['characterFilter']
  onFilter: (value: UiSettings['characterFilter']) => void
  onOpenCharacter: (character: CharacterInfo) => void
  onImport: () => void
  onImportFolder: () => void
  onRefresh: () => void
  onOpenSettings: () => void
  onLaunchGame: () => void
  onLaunchLoader: () => void
  onReorderCharacters: (folders: string[]) => void
}) {
  const [dragFolder, setDragFolder] = useState<string | null>(null)

  const characters = useMemo(() => {
    const value = query.trim().toLowerCase()
    return snapshot.characters.filter((character) => {
      if (filter === 'withMods' && character.modCount === 0) return false
      if (filter === 'empty' && character.modCount > 0) return false
      if (!value) return true
      const haystack = [character.displayName, character.folder, ...character.aliases]
        .join(' ')
        .toLowerCase()
      return haystack.includes(value)
    })
  }, [filter, query, snapshot.characters])

  function handleDrop(targetFolder: string) {
    if (!dragFolder || dragFolder === targetFolder) return
    const folders = snapshot.characters.map((character) => character.folder)
    const from = folders.indexOf(dragFolder)
    const to = folders.indexOf(targetFolder)
    if (from < 0 || to < 0) return
    const [moved] = folders.splice(from, 1)
    folders.splice(to, 0, moved)
    onReorderCharacters(folders)
    setDragFolder(null)
  }

  const canLaunchGame = Boolean(snapshot.settings.gamePath)
  const canLaunchLoader = Boolean(snapshot.settings.loaderPath)

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
          <button
            className="btn ghost"
            onClick={onLaunchGame}
            disabled={!canLaunchGame}
            title={canLaunchGame ? '启动游戏' : '请先在设置里配置游戏程序'}
          >
            <Icon name="external" size={16} />
            启动游戏
          </button>
          <button
            className="btn ghost"
            onClick={onLaunchLoader}
            disabled={!canLaunchLoader}
            title={canLaunchLoader ? '启动 XXMI / 加载器' : '请先在设置里配置启动器'}
          >
            <Icon name="external" size={16} />
            启动 {game.loader}
          </button>
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
              value={filter}
              onChange={(event) => onFilter(event.target.value as UiSettings['characterFilter'])}
            >
              <option value="all">全部角色</option>
              <option value="withMods">仅有 Mod</option>
              <option value="empty">仅无 Mod</option>
            </select>
            <select
              className="select"
              value={sort}
              onChange={(event) => onSort(event.target.value as UiSettings['sortCharacters'])}
            >
              <option value="custom">自定义顺序</option>
              <option value="name">按名称</option>
              <option value="count">按 Mod 数量</option>
            </select>
            {sort === 'custom' ? <span className="hint">拖动卡片排序</span> : null}
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
              <h2>
                {query
                  ? '没有匹配的角色'
                  : filter === 'withMods'
                    ? '没有带 Mod 的角色'
                    : filter === 'empty'
                      ? '所有角色都已有 Mod'
                      : 'Mods 目录是空的'}
              </h2>
              <p className="muted">
                {query ? '换个关键词试试。' : '可以切换筛选条件，或导入新的 Mod。'}
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
                  draggable={sort === 'custom'}
                  dragging={dragFolder === character.folder}
                  onDragStart={(event) => {
                    setDragFolder(character.folder)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', character.folder)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    handleDrop(character.folder)
                  }}
                  onDragEnd={() => setDragFolder(null)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
