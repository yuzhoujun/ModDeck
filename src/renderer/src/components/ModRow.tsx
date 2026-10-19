import type { ModInfo } from '../../../shared/types'
import { formatDate } from '../utils'
import { Icon } from './Icon'

export function ModRow({
  mod,
  onToggle,
  onOpen,
  onDelete
}: {
  mod: ModInfo
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div className={`mod-row${mod.enabled ? '' : ' is-disabled'}`}>
      <div className="mod-thumb">
        {mod.previewUrl ? (
          <img src={mod.previewUrl} alt="" loading="lazy" />
        ) : (
          <Icon name="image" size={18} />
        )}
      </div>
      <div className="mod-main">
        <div className="mod-name" title={mod.folderName}>
          {mod.name}
          {!mod.hasIni ? <span className="tag warn">缺少 ini</span> : null}
        </div>
        <div className="mod-sub">
          {mod.enabled ? '已启用' : '已禁用'} · {formatDate(mod.updatedAt)}
        </div>
      </div>
      <button
        className={`switch${mod.enabled ? ' on' : ''}`}
        onClick={onToggle}
        role="switch"
        aria-checked={mod.enabled}
        aria-label={mod.enabled ? '禁用' : '启用'}
      >
        <span />
      </button>
      <button className="icon-btn" onClick={onOpen} title="打开目录">
        <Icon name="folder" size={17} />
      </button>
      <button className="icon-btn danger" onClick={onDelete} title="删除到回收站">
        <Icon name="trash" size={17} />
      </button>
    </div>
  )
}
