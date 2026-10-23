import { useState, type DragEvent } from 'react'
import type { ModDetails } from '../../../shared/types'
import { formatDate } from '../utils'
import { Icon } from './Icon'
import { ScrollTitle } from './ScrollTitle'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif|avif)$/i

export function ModDetailsPanel({
  details,
  loading,
  error,
  onClose,
  onToggle,
  onOpen,
  onDelete,
  onSetPreview
}: {
  details: ModDetails | null
  loading: boolean
  error: string | null
  onClose: () => void
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
  onSetPreview?: (sourcePath?: string) => Promise<void> | void
}) {
  const [previewDrag, setPreviewDrag] = useState(false)

  function handlePreviewDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onSetPreview) return
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (!previewDrag) setPreviewDrag(true)
  }

  function handlePreviewDragLeave(event: DragEvent<HTMLDivElement>) {
    event.stopPropagation()
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setPreviewDrag(false)
  }

  function handlePreviewDrop(event: DragEvent<HTMLDivElement>) {
    if (!onSetPreview) return
    event.preventDefault()
    event.stopPropagation()
    setPreviewDrag(false)
    const files = Array.from(event.dataTransfer.files)
    const imgFile = files.find((f) => IMAGE_FILE_PATTERN.test(f.name))
    const targetFile = imgFile ?? files[0]
    if (!targetFile) return
    const filePath = window.moddeck.getPathForFile(targetFile)
    if (filePath) {
      void onSetPreview(filePath)
    }
  }

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <strong>Mod 详情</strong>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <Icon name="close" size={16} />
        </button>
      </div>

      {loading ? (
        <div className="detail-empty">
          <div className="spinner" />
          <span className="muted">读取目录…</span>
        </div>
      ) : error ? (
        <div className="detail-empty">
          <span className="error-text">{error}</span>
        </div>
      ) : details ? (
        <div className="detail-body">
          <div
            className={`detail-preview${onSetPreview ? ' is-interactive' : ''}${previewDrag ? ' is-drag-over' : ''}`}
            onClick={() => {
              if (onSetPreview) void onSetPreview()
            }}
            onDragOver={handlePreviewDragOver}
            onDragLeave={handlePreviewDragLeave}
            onDrop={handlePreviewDrop}
            title={onSetPreview ? '点击或拖入图片更换该 Mod 的预览图' : undefined}
          >
            {details.previewUrl ? (
              <img src={details.previewUrl} alt="" />
            ) : (
              <div className="detail-preview-empty">
                <Icon name="image" size={28} />
                <span>点击或拖入图片设置预览图</span>
              </div>
            )}
            {onSetPreview ? (
              <div className="detail-preview-hint">
                <Icon name="upload" size={15} />
                <span>{previewDrag ? '松开保存为 Mod 预览图' : '点击或拖入图片更换预览图'}</span>
              </div>
            ) : null}
          </div>

          <div className="detail-title">
            <ScrollTitle text={details.name} className="detail-title-text" />
            <span className={`chip ${details.enabled ? 'ok' : ''}`}>
              {details.enabled ? '已启用' : '已禁用'}
            </span>
          </div>
          <div className="detail-path" title={details.folderName}>
            .../{details.characterFolder}/{details.folderName}
          </div>

          <div className="detail-stats">
            <div>
              <span>文件</span>
              <strong>{details.fileCount}</strong>
            </div>
            <div>
              <span>大小</span>
              <strong>{formatBytes(details.sizeBytes)}</strong>
            </div>
            <div>
              <span>更新</span>
              <strong>{formatDate(details.updatedAt)}</strong>
            </div>
            <div>
              <span>INI</span>
              <strong>{details.iniFiles.length}</strong>
            </div>
          </div>

          <div className="detail-section">
            <div className="detail-section-title">热键</div>
            {details.hotkeys.length === 0 ? (
              <div className="muted small">没有在 ini 里找到 key</div>
            ) : (
              <div className="detail-hotkeys">
                {details.hotkeys.slice(0, 30).map((hotkey, index) => (
                  <div key={`${hotkey.section}-${index}`}>
                    <code>{hotkey.key}</code>
                    <span className="muted">{hotkey.section}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="detail-section">
            <div className="detail-section-title">INI 文件</div>
            {details.iniFiles.length === 0 ? (
              <div className="muted small">没有 ini</div>
            ) : (
              <div className="detail-ini">
                {details.iniFiles.slice(0, 40).map((file) => (
                  <code key={file}>{file}</code>
                ))}
              </div>
            )}
          </div>

          <div className="detail-actions">
            <button className="btn primary" onClick={onToggle}>
              <Icon name="check" size={15} />
              {details.enabled ? '禁用' : '启用'}
            </button>
            <button className="btn ghost" onClick={onOpen}>
              <Icon name="folder" size={15} />
              打开目录
            </button>
            <button className="btn ghost danger-text" onClick={onDelete}>
              <Icon name="trash" size={15} />
              删除
            </button>
          </div>
        </div>
      ) : (
        <div className="detail-empty muted">选择一个 Mod 查看详情</div>
      )}
    </aside>
  )
}
