import { useRef, useState } from 'react'
import type { CharacterKind, CreateCharacterInput, GameDef } from '../../../shared/types'
import { CoverCropper } from './CoverCropper'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { useI18n, getLocaleGameName } from '../i18n'

function folderFromName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function CreateCharacterModal({
  game,
  existingFolders,
  onClose,
  onCreate
}: {
  game: GameDef
  existingFolders: string[]
  onClose: () => void
  onCreate: (input: CreateCharacterInput) => Promise<void>
}) {
  const { t, effectiveLocale } = useI18n()
  const [kind, setKind] = useState<CharacterKind>('character')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [folderTouched, setFolderTouched] = useState(false)
  const [aliases, setAliases] = useState('')
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [coverError, setCoverError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  function changeName(value: string) {
    setName(value)
    if (!folderTouched) setFolder(folderFromName(value))
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
    setCoverDataUrl(dataUrl)
    setPendingFile(null)
  }

  async function create() {
    const finalFolder = folder.trim()
    if (!finalFolder) {
      setError(t('character.errEnterFolderName'))
      return
    }
    if (finalFolder.startsWith('.') || finalFolder.startsWith('_')) {
      setError(t('character.errNoDotOrUnderscore'))
      return
    }
    if (/[\\/:*?"<>|]/.test(finalFolder)) {
      setError(t('character.errInvalidChars'))
      return
    }
    if (
      existingFolders.some((item) => item.toLowerCase() === finalFolder.toLowerCase())
    ) {
      setError(t('character.errFolderExists'))
      return
    }

    setCreating(true)
    setError(null)
    try {
      await onCreate({
        folder: finalFolder,
        displayName: name.trim() || finalFolder,
        aliases: aliases
          .split(/[,，;；\n]/)
          .map((item) => item.trim())
          .filter(Boolean),
        kind,
        coverDataUrl: coverDataUrl ?? undefined
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Modal
        title={t('character.createModalTitle')}
        onClose={onClose}
        footer={
          <>
            <div className="grow" />
            <button className="btn ghost" onClick={onClose} disabled={creating}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" onClick={create} disabled={creating}>
              {creating ? t('character.creating') : t('character.create')}
            </button>
          </>
        }
      >
        <div className="segmented">
          <button
            className={kind === 'character' ? 'active' : ''}
            onClick={() => setKind('character')}
          >
            <Icon name="userPlus" size={15} />
            {t('character.tabNewCharacter')}
          </button>
          <button
            className={kind === 'utility' ? 'active' : ''}
            onClick={() => setKind('utility')}
          >
            <Icon name="box" size={15} />
            {t('character.tabUtility')}
          </button>
        </div>
        <p className="muted small">
          {kind === 'character'
            ? t('character.charDesc', { game: getLocaleGameName(game, effectiveLocale) })
            : t('character.utilityDesc')}
        </p>

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
            {coverDataUrl ? (
              <img src={coverDataUrl} alt="" />
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
                disabled={creating}
              >
                <Icon name="image" size={15} />
                {t('character.selectImage')}
              </button>
              {coverDataUrl ? (
                <button
                  className="btn ghost danger-text"
                  onClick={() => setCoverDataUrl(null)}
                  disabled={creating}
                >
                  <Icon name="trash" size={15} />
                  {t('character.removeCover')}
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
          <span>{t('character.displayNameLabel')}</span>
          <input
            className="input"
            value={name}
            onChange={(event) => changeName(event.target.value)}
            placeholder={
              kind === 'character'
                ? t('character.displayNameCharPlaceholder')
                : t('character.displayNameUtilityPlaceholder')
            }
            autoFocus
          />
        </label>
        <label className="field">
          <span>{t('character.folderLabel')}</span>
          <input
            className="input"
            value={folder}
            onChange={(event) => {
              setFolder(event.target.value)
              setFolderTouched(true)
            }}
            placeholder={t('character.folderPlaceholder')}
          />
        </label>
        <label className="field">
          <span>{t('character.aliasesLabel')}</span>
          <input
            className="input"
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder={t('character.aliasesPlaceholder')}
          />
        </label>
        <p className="muted small">{t('character.createTip')}</p>
        {error ? <div className="error-text">{error}</div> : null}
      </Modal>

      {pendingFile ? (
        <CoverCropper
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onApply={applyCover}
        />
      ) : null}
    </>
  )
}
