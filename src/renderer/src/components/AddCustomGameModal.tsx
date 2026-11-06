import { useState } from 'react'
import type { GameDef, GameSettings, GameSnapshot } from '../../../shared/types'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { useI18n } from '../i18n'

const PRESET_ACCENTS = [
  '#10b981', // Emerald
  '#5eead4', // Teal
  '#38bdf8', // Sky
  '#818cf8', // Indigo
  '#a78bfa', // Purple
  '#f472b6', // Pink
  '#fb923c', // Orange
  '#facc15'  // Yellow
]

const COMMON_LOADERS = ['3DMigoto', 'XXMI', 'GIMI', 'WWMI', 'SRMI', 'ZZMI', 'EFMI', 'Custom']

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

export function AddCustomGameModal({
  initialGame,
  initialSettings,
  existingGameIds,
  onClose,
  onSuccess,
  onDelete
}: {
  initialGame?: GameDef | null
  initialSettings?: GameSettings | null
  existingGameIds: string[]
  onClose: () => void
  onSuccess: (snapshot: GameSnapshot) => void
  onDelete?: (gameId: string) => Promise<void>
}) {
  const { t } = useI18n()
  const isEditing = Boolean(initialGame)

  const [name, setName] = useState(initialGame?.name ?? '')
  const [nameEn, setNameEn] = useState(initialGame?.nameEn ?? '')
  const [shortName, setShortName] = useState(initialGame?.shortName ?? '')
  const [id, setId] = useState(initialGame?.id ?? '')
  const [idTouched, setIdTouched] = useState(isEditing)
  const [loader, setLoader] = useState(initialGame?.loader ?? '3DMigoto')
  const [accent, setAccent] = useState(initialGame?.accent ?? '#10b981')
  const [modsPath, setModsPath] = useState(initialSettings?.modsPath ?? '')
  const [gamePath, setGamePath] = useState(initialSettings?.gamePath ?? '')
  const [launchArgs, setLaunchArgs] = useState(initialSettings?.launchArgs ?? '')

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleNameChange(value: string) {
    setName(value)
    if (!idTouched && !isEditing) {
      const generated = slugify(value)
      setId(generated || `game_${Date.now() % 100000}`)
    }
  }

  async function handlePickMods() {
    try {
      const path = await window.moddeck.pickModsFolder()
      if (path) setModsPath(path)
    } catch {
      // Ignored
    }
  }

  async function handlePickGameExe() {
    try {
      const path = await window.moddeck.pickGameExe()
      if (path) setGamePath(path)
    } catch {
      // Ignored
    }
  }

  async function handleSave() {
    const finalName = name.trim()
    if (!finalName) {
      setError(t('customGame.errNameRequired'))
      return
    }

    let finalId = (id || '').trim().toLowerCase()
    if (!finalId) {
      finalId = slugify(finalName) || `game_${Date.now()}`
    }

    if (!/^[a-z0-9_-]+$/.test(finalId)) {
      setError(t('customGame.errInvalidIdChars'))
      return
    }

    if (!isEditing && existingGameIds.includes(finalId)) {
      setError(t('customGame.errIdExists', { id: finalId }))
      return
    }

    setError(null)
    setSaving(true)

    try {
      const gameDef: GameDef = {
        id: finalId,
        name: finalName,
        nameEn: nameEn.trim() || undefined,
        shortName: (shortName || finalName).trim(),
        loader: loader.trim() || '3DMigoto',
        accent,
        isCustom: true
      }

      const gameSettings: GameSettings = {
        modsPath: modsPath.trim(),
        gamePath: gamePath.trim() || undefined,
        launchArgs: launchArgs.trim() || undefined
      }

      const res = await window.moddeck.saveCustomGame(gameDef, gameSettings)
      if (!res.ok || !res.snapshot) {
        setError(res.error || t('customGame.saveFailed'))
      } else {
        onSuccess(res.snapshot)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!initialGame || !onDelete) return
    const confirmed = window.confirm(
      t('customGame.confirmDelete', { name: initialGame.name })
    )
    if (!confirmed) return

    setDeleting(true)
    setError(null)
    try {
      await onDelete(initialGame.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDeleting(false)
    }
  }

  return (
    <Modal
      title={isEditing ? t('customGame.modalTitleEdit') : t('customGame.modalTitleAdd')}
      onClose={() => {
        if (!saving && !deleting) onClose()
      }}
      width={560}
      footer={
        <>
          {isEditing && initialGame?.isCustom && onDelete ? (
            <button
              type="button"
              className="btn danger"
              onClick={() => void handleDelete()}
              disabled={saving || deleting}
            >
              <Icon name="trash" size={15} />
              {deleting ? t('customGame.deleting') : t('customGame.deleteGame')}
            </button>
          ) : null}
          <div className="grow" />
          <button
            type="button"
            className="btn ghost"
            onClick={onClose}
            disabled={saving || deleting}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSave()}
            disabled={saving || deleting || !name.trim()}
          >
            <Icon name="check" size={15} />
            {saving ? t('customGame.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: '14px' }}>
        {error ? <div className="error-text">{error}</div> : null}

        <div className="row" style={{ gap: '12px' }}>
          <label className="field grow">
            <span>{t('customGame.nameLabel')} *</span>
            <input
              className="input"
              value={name}
              placeholder={t('customGame.namePlaceholder')}
              onChange={(e) => handleNameChange(e.target.value)}
              disabled={saving}
              autoFocus
            />
          </label>
          <label className="field" style={{ width: '140px' }}>
            <span>{t('customGame.shortNameLabel')}</span>
            <input
              className="input"
              value={shortName}
              placeholder={name || t('customGame.shortNamePlaceholder')}
              onChange={(e) => setShortName(e.target.value)}
              disabled={saving}
            />
          </label>
        </div>

        <div className="row" style={{ gap: '12px' }}>
          <label className="field grow">
            <span>{t('customGame.nameEnLabel')}</span>
            <input
              className="input"
              value={nameEn}
              placeholder={t('customGame.nameEnPlaceholder')}
              onChange={(e) => setNameEn(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="field" style={{ width: '180px' }}>
            <span>{t('customGame.idLabel')} *</span>
            <input
              className="input"
              value={id}
              placeholder="e.g. genshin-impact"
              onChange={(e) => {
                setId(e.target.value)
                setIdTouched(true)
              }}
              disabled={isEditing || saving}
              title={isEditing ? t('customGame.idLockedTip') : undefined}
            />
          </label>
        </div>

        <div className="row" style={{ gap: '12px', alignItems: 'flex-start' }}>
          <label className="field" style={{ width: '180px' }}>
            <span>{t('customGame.loaderLabel')}</span>
            <input
              className="input"
              list="loader-presets"
              value={loader}
              placeholder="3DMigoto / XXMI"
              onChange={(e) => setLoader(e.target.value)}
              disabled={saving}
            />
            <datalist id="loader-presets">
              {COMMON_LOADERS.map((ldr) => (
                <option key={ldr} value={ldr} />
              ))}
            </datalist>
          </label>

          <div className="field grow">
            <span>{t('customGame.accentColorLabel')}</span>
            <div className="row" style={{ gap: '8px', alignItems: 'center', marginTop: '4px' }}>
              {PRESET_ACCENTS.map((color) => {
                const selected = accent.toLowerCase() === color.toLowerCase()
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setAccent(color)}
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '50%',
                      background: color,
                      border: selected ? '2px solid #fff' : '2px solid transparent',
                      boxShadow: selected ? `0 0 0 2px ${color}` : undefined,
                      cursor: 'pointer',
                      padding: 0
                    }}
                    title={color}
                  />
                )
              })}
              <input
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                style={{
                  width: '26px',
                  height: '26px',
                  padding: 0,
                  border: 'none',
                  borderRadius: '4px',
                  background: 'none',
                  cursor: 'pointer'
                }}
                title={t('customGame.customColorTip')}
              />
            </div>
          </div>
        </div>

        <label className="field">
          <span>{t('customGame.modsPathLabel')}</span>
          <div className="field-row">
            <input
              className="input"
              value={modsPath}
              placeholder={t('customGame.modsPathPlaceholder')}
              onChange={(e) => setModsPath(e.target.value)}
              disabled={saving}
            />
            <button
              type="button"
              className="icon-btn"
              title={t('settings.games.pickFolderTooltip')}
              onClick={() => void handlePickMods()}
              disabled={saving}
            >
              <Icon name="folder" size={17} />
            </button>
          </div>
          <span className="muted small" style={{ marginTop: '2px' }}>
            {t('customGame.modsPathHint')}
          </span>
        </label>

        <label className="field">
          <span>{t('customGame.gamePathLabel')}</span>
          <div className="field-row">
            <input
              className="input"
              value={gamePath}
              placeholder={t('customGame.gamePathPlaceholder')}
              onChange={(e) => setGamePath(e.target.value)}
              disabled={saving}
            />
            <button
              type="button"
              className="icon-btn"
              title={t('settings.games.pickGameTooltip')}
              onClick={() => void handlePickGameExe()}
              disabled={saving}
            >
              <Icon name="folder" size={17} />
            </button>
          </div>
        </label>

        <label className="field">
          <span>{t('customGame.launchArgsLabel')}</span>
          <input
            className="input"
            value={launchArgs}
            placeholder={t('settings.games.argsPlaceholder')}
            onChange={(e) => setLaunchArgs(e.target.value)}
            disabled={saving}
          />
        </label>
      </div>
    </Modal>
  )
}
