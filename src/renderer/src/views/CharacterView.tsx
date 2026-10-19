import type {
  CharacterInfo,
  GameDef,
  ModInfo,
  UiSettings
} from '../../../shared/types'
import { Icon } from '../components/Icon'
import { ModRow } from '../components/ModRow'
import { displayNameOf, initialOf, modMatches } from '../utils'

export function CharacterView({
  game,
  character,
  mods,
  loading,
  query,
  onQuery,
  sort,
  onSort,
  onBack,
  onToggle,
  onOpen,
  onDelete,
  onImport,
  onImportFolder,
  onEdit,
  onCover,
  onOpenCharacterFolder,
  onRefresh
}: {
  game: GameDef
  character: CharacterInfo
  mods: ModInfo[]
  loading: boolean
  query: string
  onQuery: (value: string) => void
  sort: UiSettings['sortMods']
  onSort: (value: UiSettings['sortMods']) => void
  onBack: () => void
  onToggle: (mod: ModInfo) => void
  onOpen: (mod: ModInfo) => void
  onDelete: (mod: ModInfo) => void
  onImport: () => void
  onImportFolder: () => void
  onEdit: () => void
  onCover: () => void
  onOpenCharacterFolder: () => void
  onRefresh: () => void
}) {
  const name = displayNameOf(character)
  const visible = mods.filter((mod) => modMatches(mod, query))

  return (
    <div className="view">
      <button className="back-link" onClick={onBack}>
        <Icon name="back" size={16} />
        返回角色库
      </button>

      <header className="char-head">
        <button
          className="char-avatar"
          onClick={onCover}
          title="更换封面"
          style={{ borderColor: `${game.accent}66` }}
        >
          {character.coverUrl ? (
            <img src={character.coverUrl} alt="" />
          ) : (
            <span style={{ color: game.accent }}>{initialOf(name)}</span>
          )}
        </button>
        <div className="char-head-main">
          <div className="eyebrow" style={{ color: game.accent }}>
            {game.shortName} · {character.folder}
          </div>
          <h1>{name}</h1>
          <div className="chips">
            <span className="chip">{character.modCount} 个 Mod</span>
            <span className="chip ok">{character.enabledCount} 启用</span>
            {character.hiddenCount > 0 ? (
              <span className="chip">{character.hiddenCount} 禁用</span>
            ) : null}
            {!character.known ? <span className="chip new">新角色</span> : null}
          </div>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onEdit}>
            <Icon name="edit" size={15} />
            编辑
          </button>
          <button className="btn ghost" onClick={onOpenCharacterFolder}>
            <Icon name="folder" size={15} />
            打开目录
          </button>
          <button className="btn primary" onClick={onImport}>
            <Icon name="upload" size={15} />
            导入到该角色
          </button>
        </div>
      </header>

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input
            className="input"
            placeholder="搜索 Mod"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
        <select
          className="select"
          value={sort}
          onChange={(event) => onSort(event.target.value as UiSettings['sortMods'])}
        >
          <option value="name">按名称</option>
          <option value="recent">按更新时间</option>
          <option value="enabled">启用的优先</option>
        </select>
        <button className="btn ghost" onClick={onRefresh}>
          <Icon name="refresh" size={15} />
          刷新
        </button>
        <button className="btn ghost" onClick={onImportFolder}>
          <Icon name="folder" size={15} />
          导入文件夹
        </button>
      </div>

      {loading ? (
        <div className="empty-panel">
          <div className="spinner" />
          <p className="muted">正在扫描 Mod…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-panel">
          <div className="empty-icon">
            <Icon name="box" size={28} />
          </div>
          <h2>{query ? '没有匹配的 Mod' : '这个角色还没有 Mod'}</h2>
          <p className="muted">
            {query ? '换个关键词试试。' : '点右上角“导入到该角色”，或把压缩包拖进来。'}
          </p>
        </div>
      ) : (
        <div className="mod-list">
          {visible.map((mod) => (
            <ModRow
              key={mod.folderName}
              mod={mod}
              onToggle={() => onToggle(mod)}
              onOpen={() => onOpen(mod)}
              onDelete={() => onDelete(mod)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
