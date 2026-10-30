import type { DragEvent } from 'react'
import type { ModInfo } from '../../../shared/types'
import { formatDate } from '../utils'
import { useI18n } from '../i18n'
import { Icon } from './Icon'
import { ScrollTitle } from './ScrollTitle'

export function ModRow({
  mod,

  onToggle,
  onOpen,
  onDelete,
  onSelect,
  selected = false,
  selectable = false,
  checked = false,
  onCheck,
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
  selectable?: boolean
  checked?: boolean
  onCheck?: () => void
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
}) {
  const { t, effectiveLocale } = useI18n()
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
      {selectable ? (
        <input
          type="checkbox"
          className="mod-check"
          checked={checked}
          onChange={(event) => {
            event.stopPropagation()
            onCheck?.()
          }}
          onClick={(event) => event.stopPropagation()}
          aria-label={`选择 ${mod.name}`}
        />
      ) : null}
      <div className="mod-thumb">
        {mod.previewUrl ? (
          <img src={mod.previewUrl} alt="" loading="lazy" />
        ) : (
          <Icon name="image" size={18} />
        )}
      </div>
      <div className="mod-main">
        <div className="mod-name" title={mod.folderName}>
          <ScrollTitle text={mod.name} className="mod-name-text" title={mod.folderName} />
          {!mod.hasIni ? <span className="tag warn">{effectiveLocale === 'zh-CN' ? '缺少 ini' : 'No ini'}</span> : null}
        </div>
        <div className="mod-sub">
          {mod.enabled ? t('common.enabled') : t('common.disabled')} · {formatDate(mod.updatedAt)}
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
        aria-label={mod.enabled ? t('common.disabled') : t('common.enabled')}
      >
        <span />
      </button>
      <button
        className="icon-btn"
        onClick={(event) => {
          event.stopPropagation()
          onOpen()
        }}
        title={t('common.openFolder')}
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
