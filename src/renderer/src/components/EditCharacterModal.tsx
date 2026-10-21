import { useRef, useState } from 'react'
import type { CharacterInfo } from '../../../shared/types'
import { CoverCropper } from './CoverCropper'
import { Icon } from './Icon'
import { Modal } from './Modal'

export function EditCharacterModal({
  character,
  onClose,
  onSave,
  onReset,
  onSaveCover,
  onRemoveCover
}: {
  character: CharacterInfo
  onClose: () => void
  onSave: (patch: { displayName?: string; aliases?: string[]; order?: number }) => Promise<void>
  onReset: () => Promise<void>
  onSaveCover: (dataUrl: string) => Promise<void>
  onRemoveCover: () => Promise<void>
}) {
  const [name, setName] = useState(character.displayName)
  const [aliases, setAliases] = useState(character.aliases.join('，'))
  const [order, setOrder] = useState(
    character.order === Number.MAX_SAFE_INTEGER ? '' : String(character.order)
  )
  const [saving, setSaving] = useState(false)
  const [coverPreview, setCoverPreview] = useState(character.coverUrl)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [coverBusy, setCoverBusy] = useState(false)
  const [coverError, setCoverError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function save() {
    setSaving(true)
    try {
      await onSave({
        displayName: name.trim() || character.folder,
        aliases: aliases
          .split(/[,，;；\n]/)
          .map((item) => item.trim())
          .filter(Boolean),
        order: order.trim() ? Number(order) : undefined
      })
    } finally {
      setSaving(false)
    }
  }

  function chooseFile(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setCoverError('请选择图片文件')
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      setCoverError('图片过大（>15MB）')
      return
    }
    setCoverError(null)
    setPendingFile(file)
  }

  async function applyCover(dataUrl: string) {
    setCoverBusy(true)
    try {
      await onSaveCover(dataUrl)
      setCoverPreview(dataUrl)
      setPendingFile(null)
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : String(error))
    } finally {
      setCoverBusy(false)
    }
  }

  async function removeCover() {
    setCoverBusy(true)
    try {
      await onRemoveCover()
      setCoverPreview(null)
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : String(error))
    } finally {
      setCoverBusy(false)
    }
  }

  return (
    <>
      <Modal
        title="编辑角色"
        onClose={onClose}
        footer={
          <>
            <button className="btn ghost" onClick={onReset} disabled={saving || coverBusy}>
              恢复默认
            </button>
            <div className="grow" />
            <button className="btn ghost" onClick={onClose} disabled={saving || coverBusy}>
              取消
            </button>
            <button className="btn primary" onClick={save} disabled={saving || coverBusy}>
              保存
            </button>
          </>
        }
      >
        <div
          className={`cover-editor${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            chooseFile(event.dataTransfer.files[0])
          }}
        >
          <div className="cover-preview">
            {coverPreview ? (
              <img src={coverPreview} alt="" />
            ) : (
              <div className="cover-placeholder">
                <Icon name="image" size={26} />
                <span>拖入图片</span>
              </div>
            )}
          </div>
          <div className="cover-side">
            <strong>角色封面</strong>
            <p className="muted small">
              拖入图片，或点击选择；会裁剪成 1:1 并保存为角色目录下的
              <code>.preview.png</code>。旧的 <code>_cover.png</code> 会作为兜底读取。
            </p>
            <div className="row">
              <button
                className="btn ghost"
                onClick={() => fileInput.current?.click()}
                disabled={coverBusy}
              >
                <Icon name="image" size={15} />
                选择图片
              </button>
              {coverPreview ? (
                <button className="btn ghost danger-text" onClick={removeCover} disabled={coverBusy}>
                  <Icon name="trash" size={15} />
                  移除
                </button>
              ) : null}
            </div>
            {coverError ? <div className="error-text">{coverError}</div> : null}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
            hidden
            onChange={(event) => {
              chooseFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </div>

        <label className="field">
          <span>显示名称</span>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={character.folder}
          />
        </label>
        <label className="field">
          <span>别名（用逗号分隔，用于搜索和合并中英日名）</span>
          <input
            className="input"
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder="例如 Aemeath，爱弥斯"
          />
        </label>
        <label className="field">
          <span>排序权重（越小越靠前，可留空）</span>
          <input
            className="input"
            value={order}
            onChange={(event) => setOrder(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <p className="muted small">
          目录名 <code>{character.folder}</code> 不会改变，只影响显示和搜索。
        </p>
      </Modal>

      {pendingFile ? (
        <CoverCropper
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onApply={(dataUrl) => void applyCover(dataUrl)}
        />
      ) : null}
    </>
  )
}
