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
  const { t, effectiveLocale } = useI18n()
  const isZh = effectiveLocale === 'zh-CN'
  const isEditing = Boolean(initialGame)

  // Smart initial field population
  const initZhName = initialGame?.name ?? ''
  const initZhShort = initialGame?.shortName ?? ''
  const initEnName =
    initialGame?.nameEn ?? (!/[\u4e00-\u9fa5]/.test(initZhName) ? initZhName : '')
  const initEnShort =
    initialGame?.shortNameEn ?? (!/[\u4e00-\u9fa5]/.test(initZhShort) ? initZhShort : '')

  const [nameZh, setNameZh] = useState(initZhName)
  const [shortNameZh, setShortNameZh] = useState(initZhShort)
  const [nameEn, setNameEn] = useState(initEnName)
  const [shortNameEn, setShortNameEn] = useState(initEnShort)

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

  function handleNameEnChange(val: string) {
    setNameEn(val)
    if (!idTouched && !isEditing) {
      const generated = slugify(val)
      if (generated) setId(generated)
    }
  }

  function handleNameZhChange(val: string) {
    setNameZh(val)
    if (!idTouched && !isEditing && !nameEn) {
      const generated = slugify(val)
      if (generated) setId(generated)
      else if (!id) setId(`game_${Date.now() % 100000}`)
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
    const cleanZhName = nameZh.trim()
    const cleanEnName = nameEn.trim()
    const cleanZhShort = shortNameZh.trim()
    const cleanEnShort = shortNameEn.trim()

    // Validate that the primary name for current locale is present
    if (isZh) {
      if (!cleanZhName && !cleanEnName) {
        setError(t('customGame.errNameRequired'))
        return
      }
    } else {
      if (!cleanEnName && !cleanZhName) {
        setError(t('customGame.errNameRequired'))
        return
      }
    }

    const finalZhName = cleanZhName || cleanEnName
    const finalEnName = cleanEnName || cleanZhName
    const finalZhShort = cleanZhShort || (cleanZhName ? cleanZhName : cleanEnShort || finalZhName)
    const finalEnShort = cleanEnShort || (cleanEnName ? cleanEnName : cleanZhShort || finalEnName)

    let finalId = (id || '').trim().toLowerCase()
    if (!finalId) {
      finalId = slugify(cleanEnName) || slugify(cleanZhName) || `game_${Date.now()}`
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
        name: finalZhName,
        nameEn: cleanEnName ? cleanEnName : (!isZh ? finalEnName : undefined),
        shortName: finalZhShort,
        shortNameEn: cleanEnShort ? cleanEnShort : (!isZh ? finalEnShort : (cleanEnName ? finalEnShort : undefined)),
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
    const gameDisplayName = isZh
      ? (initialGame.name || initialGame.nameEn || initialGame.id)
      : (initialGame.nameEn || initialGame.name || initialGame.id)
    const confirmed = window.confirm(
      t('customGame.confirmDelete', { name: gameDisplayName })
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
            disabled={saving || deleting || (isZh ? !nameZh.trim() && !nameEn.trim() : !nameEn.trim() && !nameZh.trim())}
          >
            <Icon name="check" size={15} />
            {saving ? t('customGame.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: '14px' }}>
        {error ? <div className="error-text">{error}</div> : null}

        {isZh ? (
          <>
            {/* Primary Row: Chinese */}
            <div className="row" style={{ gap: '12px' }}>
              <label className="field grow">
                <span>{t('customGame.nameZhLabel')} *</span>
                <input
                  className="input"
                  value={nameZh}
                  placeholder={t('customGame.nameZhPlaceholder')}
                  onChange={(e) => handleNameZhChange(e.target.value)}
                  disabled={saving}
                  autoFocus
                />
              </label>
              <label className="field" style={{ width: '160px' }}>
                <span>{t('customGame.shortNameZhLabel')}</span>
                <input
                  className="input"
                  value={shortNameZh}
                  placeholder={nameZh || t('customGame.shortNameZhPlaceholder')}
                  onChange={(e) => setShortNameZh(e.target.value)}
                  disabled={saving}
                />
              </label>
            </div>

            {/* Secondary Row: English */}
            <div className="row" style={{ gap: '12px' }}>
              <label className="field grow">
                <span>{t('customGame.nameEnLabel')}</span>
                <input
                  className="input"
                  value={nameEn}
                  placeholder={t('customGame.nameEnPlaceholder')}
                  onChange={(e) => handleNameEnChange(e.target.value)}
                  disabled={saving}
                />
              </label>
              <label className="field" style={{ width: '160px' }}>
                <span>{t('customGame.shortNameEnLabel')}</span>
                <input
                  className="input"
                  value={shortNameEn}
                  placeholder={nameEn || t('customGame.shortNameEnPlaceholder')}
                  onChange={(e) => setShortNameEn(e.target.value)}
                  disabled={saving}
                />
              </label>
            </div>
          </>
        ) : (
          <>
            {/* Primary Row: English */}
            <div className="row" style={{ gap: '12px' }}>
              <label className="field grow">
                <span>{t('customGame.nameEnLabel')} *</span>
                <input
                  className="input"
                  value={nameEn}
                  placeholder={t('customGame.nameEnPlaceholder')}
                  onChange={(e) => handleNameEnChange(e.target.value)}
                  disabled={saving}
                  autoFocus
                />
              </label>
              <label className="field" style={{ width: '160px' }}>
                <span>{t('customGame.shortNameEnLabel')}</span>
                <input
                  className="input"
                  value={shortNameEn}
                  placeholder={nameEn || t('customGame.shortNameEnPlaceholder')}
                  onChange={(e) => setShortNameEn(e.target.value)}
                  disabled={saving}
                />
              </label>
            </div>

            {/* Secondary Row: Chinese */}
            <div className="row" style={{ gap: '12px' }}>
              <label className="field grow">
                <span>{t('customGame.nameZhLabel')}</span>
                <input
                  className="input"
                  value={nameZh}
                  placeholder={t('customGame.nameZhPlaceholder')}
                  onChange={(e) => handleNameZhChange(e.target.value)}
                  disabled={saving}
                />
              </label>
              <label className="field" style={{ width: '160px' }}>
                <span>{t('customGame.shortNameZhLabel')}</span>
                <input
                  className="input"
                  value={shortNameZh}
                  placeholder={nameZh || t('customGame.shortNameZhPlaceholder')}
                  onChange={(e) => setShortNameZh(e.target.value)}
                  disabled={saving}
                />
              </label>
            </div>
          </>
        )}

        <div className="row" style={{ gap: '12px', alignItems: 'flex-start' }}>
          <label className="field grow">
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
          <label className="field" style={{ width: '150px' }}>
            <span>{t('customGame.loaderLabel')}</span>
            <input
              className="input"
              value={loader}
              placeholder="3DMigoto"
              onChange={(e) => setLoader(e.target.value)}
              disabled={saving}
              list="loader-presets"
            />
            <datalist id="loader-presets">
              {COMMON_LOADERS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
        </div>

        <div className="field">
          <span>{t('customGame.accentColorLabel')}</span>
          <div className="row" style={{ gap: '8px', alignItems: 'center' }}>
            {PRESET_ACCENTS.map((color) => {
              const active = accent.toLowerCase() === color.toLowerCase()
              return (
                <button
                  key={color}
                  type="button"
                  style={{
                    width: '26px',
                    height: '26px',
                    borderRadius: '50%',
                    background: color,
                    border: active ? '2px solid #fff' : '2px solid transparent',
                    boxShadow: active ? `0 0 0 2px ${color}` : 'none',
                    cursor: 'pointer',
                    outline: 'none',
                    transition: 'transform 0.1s ease',
                    transform: active ? 'scale(1.1)' : 'scale(1)'
                  }}
                  onClick={() => setAccent(color)}
                />
              )
            })}
            <input
              type="color"
              value={accent.startsWith('#') ? accent : '#10b981'}
              onChange={(e) => setAccent(e.target.value)}
              style={{
                width: '32px',
                height: '26px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                borderRadius: '4px'
              }}
              title={t('customGame.customColorTip')}
            />
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
          <span className="muted" style={{ fontSize: '11px', marginTop: '4px' }}>
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
