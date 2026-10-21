import type { DragEvent } from 'react'
import type { ModInfo } from '../../../shared/types'
import { formatDate } from '../utils'
import { Icon } from './Icon'

export function ModRow({
  mod,
  onToggle,
  onOpen,
  onDelete,
  onSelect,
  selected = false,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: {
  mod: ModInfo
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
  onSelect: () => void
  selected?: boolean
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
}) {
  return (
    <div
      className={`mod-row${mod.enabled ? '' : ' is-disabled'}${selected ? ' is-selected' : ''}${
        dragging ? ' is-dragging' : ''
      }`}
      onClick={onSelect}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={draggable ? '拖动排序' : mod.folderName}
    >
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
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        role="switch"
        aria-checked={mod.enabled}
        aria-label={mod.enabled ? '禁用' : '启用'}
      >
        <span />
      </button>
      <button
        className="icon-btn"
        onClick={(event) => {
          event.stopPropagation()
          onOpen()
        }}
        title="打开目录"
      >
        <Icon name="folder" size={17} />
      </button>
      <button
        className="icon-btn danger"
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
        title="删除到回收站"
      >
        <Icon name="trash" size={17} />
      </button>
    </div>
  )
}
