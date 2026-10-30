import { useRef, useState } from 'react'
import type { CharacterInfo } from '../../../shared/types'
import { CoverCropper } from './CoverCropper'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { useI18n } from '../i18n'

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
  const { t } = useI18n()
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
      setCoverError(t('character.errSelectImage'))
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      setCoverError(t('character.errImageTooLarge'))
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
        title={t('character.editModalTitle')}
        onClose={onClose}
        footer={
          <>
            <button className="btn ghost" onClick={onReset} disabled={saving || coverBusy}>{t('character.restoreDefault')}</button>
            <div className="grow" />
            <button className="btn ghost" onClick={onClose} disabled={saving || coverBusy}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={save} disabled={saving || coverBusy}>{t('common.save')}</button>
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
                <span>{t('character.dropImage')}</span>
              </div>
            )}
          </div>
          <div className="cover-side">
            <strong>{t('character.coverTitle')}</strong>
            <p className="muted small">
              {t('character.coverDesc')}
              <code>.preview.png</code>。
            </p>
            <div className="row">
              <button
                className="btn ghost"
                onClick={() => fileInput.current?.click()}
                disabled={coverBusy}
              >
                <Icon name="image" size={15} />{t('character.selectImage')}</button>
              {coverPreview ? (
                <button className="btn ghost danger-text" onClick={removeCover} disabled={coverBusy}>
                  <Icon name="trash" size={15} />{t('character.removeCover')}</button>
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
          <span>{t('character.displayNameLabel')}</span>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={character.folder}
          />
        </label>
        <label className="field">
          <span>{t('character.aliasesEditLabel')}</span>
          <input
            className="input"
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder={t('character.aliasesEditPlaceholder')}
          />
        </label>
        <label className="field">
          <span>{t('character.orderLabel')}</span>
          <input
            className="input"
            value={order}
            onChange={(event) => setOrder(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <p className="muted small">
          <span>{character.folder}</span> {t('character.editTip', { folder: '' })}
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
