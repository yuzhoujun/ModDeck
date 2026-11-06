import { useState, useMemo } from 'react'
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

const PREDEFINED_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'zh-CN', label: '简体中文 (zh-CN)' },
  { code: 'en-US', label: 'English (en-US)' },
  { code: 'ja-JP', label: '日本語 (ja-JP)' },
  { code: 'ko-KR', label: '한국어 (ko-KR)' },
  { code: 'ru-RU', label: 'Русский (ru-RU)' },
  { code: 'zh-TW', label: '繁體中文 (zh-TW)' },
  { code: 'es-ES', label: 'Español (es-ES)' },
  { code: 'fr-FR', label: 'Français (fr-FR)' },
  { code: 'de-DE', label: 'Deutsch (de-DE)' }
]

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

interface LocalizationRow {
  id: string
  lang: string
  name: string
  shortName: string
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
  const { t, effectiveLocale, availableLocales } = useI18n()
  const isEditing = Boolean(initialGame)

  // Compute available languages dropdown options
  const allLanguageOptions = useMemo(() => {
    const list = [...PREDEFINED_LANGUAGES]
    for (const code of availableLocales) {
      if (!list.some((item) => item.code === code)) {
        list.push({ code, label: `${code} (Custom)` })
      }
    }
    return list
  }, [availableLocales])

  // Resolve initial primary name based on effective locale
  const initPrimaryName = useMemo(() => {
    if (!initialGame) return ''
    if (initialGame.locales?.[effectiveLocale]?.name) {
      return initialGame.locales[effectiveLocale].name!
    }
    if (effectiveLocale === 'zh-CN') return initialGame.name
    return initialGame.nameEn || initialGame.name
  }, [initialGame, effectiveLocale])

  const initPrimaryShortName = useMemo(() => {
    if (!initialGame) return ''
    if (initialGame.locales?.[effectiveLocale]?.shortName) {
      return initialGame.locales[effectiveLocale].shortName!
    }
    if (effectiveLocale === 'zh-CN') return initialGame.shortName
    return initialGame.shortNameEn || initialGame.shortName
  }, [initialGame, effectiveLocale])

  // Resolve initial localization rows
  const initLocalizations = useMemo<LocalizationRow[]>(() => {
    if (!initialGame) return []
    const rows: LocalizationRow[] = []

    if (initialGame.locales) {
      for (const [code, loc] of Object.entries(initialGame.locales)) {
        if (code !== effectiveLocale && (loc?.name || loc?.shortName)) {
          rows.push({
            id: `loc_${code}`,
            lang: code,
            name: loc.name ?? '',
            shortName: loc.shortName ?? ''
          })
        }
      }
    } else {
      // Legacy data fallback: if initialGame had name and nameEn
      if (effectiveLocale === 'en-US' && initialGame.name && initialGame.name !== initialGame.nameEn) {
        rows.push({
          id: 'loc_zh-CN',
          lang: 'zh-CN',
          name: initialGame.name,
          shortName: initialGame.shortName || ''
        })
      } else if (effectiveLocale === 'zh-CN' && initialGame.nameEn) {
        rows.push({
          id: 'loc_en-US',
          lang: 'en-US',
          name: initialGame.nameEn,
          shortName: initialGame.shortNameEn || ''
        })
      }
    }
    return rows
  }, [initialGame, effectiveLocale])

  const [primaryName, setPrimaryName] = useState(initPrimaryName)
  const [primaryShortName, setPrimaryShortName] = useState(initPrimaryShortName)
  const [localizations, setLocalizations] = useState<LocalizationRow[]>(initLocalizations)

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

  function handlePrimaryNameChange(val: string) {
    setPrimaryName(val)
    if (!idTouched && !isEditing) {
      const generated = slugify(val)
      if (generated) setId(generated)
    }
  }

  function handleAddLocalization() {
    // Find first language that is not current effectiveLocale and not in rows
    const usedLangs = new Set([effectiveLocale, ...localizations.map((r) => r.lang)])
    const candidate = allLanguageOptions.find((opt) => !usedLangs.has(opt.code))
    const lang = candidate ? candidate.code : 'en-US'
    setLocalizations((prev) => [
      ...prev,
      { id: `loc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, lang, name: '', shortName: '' }
    ])
  }

  function handleUpdateLocalization(index: number, patch: Partial<LocalizationRow>) {
    setLocalizations((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    )
  }

  function handleRemoveLocalization(index: number) {
    setLocalizations((prev) => prev.filter((_, idx) => idx !== index))
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
    const finalPrimaryName = primaryName.trim()
    const finalPrimaryShort = primaryShortName.trim() || finalPrimaryName

    if (!finalPrimaryName) {
      setError(t('customGame.errNameRequired'))
      return
    }

    // Build locales map
    const localesMap: Record<string, { name?: string; shortName?: string }> = {}

    // 1. Current effective locale
    localesMap[effectiveLocale] = {
      name: finalPrimaryName,
      shortName: finalPrimaryShort
    }

    // 2. Extra localizations
    for (const row of localizations) {
      const code = row.lang.trim()
      const n = row.name.trim()
      const s = row.shortName.trim() || n
      if (code && n) {
        localesMap[code] = {
          name: n,
          shortName: s
        }
      }
    }

    // Resolve backward-compatible root fields
    let zhName = localesMap['zh-CN']?.name
    let zhShortName = localesMap['zh-CN']?.shortName
    let enName = localesMap['en-US']?.name
    let enShortName = localesMap['en-US']?.shortName

    if (effectiveLocale === 'zh-CN') {
      zhName = finalPrimaryName
      zhShortName = finalPrimaryShort
    } else if (effectiveLocale === 'en-US') {
      enName = finalPrimaryName
      enShortName = finalPrimaryShort
    }

    // Ensure fallback for zhName and shortName if not provided
    if (!zhName) zhName = enName || finalPrimaryName
    if (!zhShortName) zhShortName = enShortName || finalPrimaryShort || zhName

    let finalId = (id || '').trim().toLowerCase()
    if (!finalId) {
      finalId = slugify(enName || '') || slugify(finalPrimaryName) || `game_${Date.now()}`
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
        name: zhName,
        nameEn: enName,
        shortName: zhShortName,
        shortNameEn: enShortName,
        loader: loader.trim() || '3DMigoto',
        accent,
        isCustom: true,
        locales: Object.keys(localesMap).length > 0 ? localesMap : undefined
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
    const gameDisplayName =
      initialGame.locales?.[effectiveLocale]?.name ||
      (effectiveLocale === 'zh-CN' ? initialGame.name : initialGame.nameEn || initialGame.name) ||
      initialGame.id

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
      width={580}
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
            disabled={saving || deleting || !primaryName.trim()}
          >
            <Icon name="check" size={15} />
            {saving ? t('customGame.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: '14px' }}>
        {error ? <div className="error-text">{error}</div> : null}

        {/* Primary Row: Name & Short Name in Current Language */}
        <div className="row" style={{ gap: '12px' }}>
          <label className="field grow">
            <span>{t('customGame.primaryNameLabel')} *</span>
            <input
              className="input"
              value={primaryName}
              placeholder={t('customGame.primaryNamePlaceholder')}
              onChange={(e) => handlePrimaryNameChange(e.target.value)}
              disabled={saving}
              autoFocus
            />
          </label>
          <label className="field" style={{ width: '160px' }}>
            <span>{t('customGame.primaryShortNameLabel')}</span>
            <input
              className="input"
              value={primaryShortName}
              placeholder={primaryName || t('customGame.primaryShortNamePlaceholder')}
              onChange={(e) => setPrimaryShortName(e.target.value)}
              disabled={saving}
            />
          </label>
        </div>

        {/* Localizations Section */}
        <div
          style={{
            padding: '12px',
            background: 'rgba(15, 23, 42, 0.45)',
            borderRadius: '10px',
            border: '1px solid rgba(51, 65, 85, 0.5)'
          }}
        >
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: localizations.length > 0 ? '10px' : '0'
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '12.5px', color: '#e2e8f0' }}>
                {t('customGame.localizationsTitle')}
              </div>
              <div className="muted" style={{ fontSize: '11px', marginTop: '2px' }}>
                {t('customGame.localizationsDesc')}
              </div>
            </div>
            <button
              type="button"
              className="btn ghost small-btn"
              onClick={handleAddLocalization}
              disabled={saving}
              style={{ fontSize: '11.5px', padding: '3px 8px' }}
            >
              <Icon name="plus" size={13} />
              {t('customGame.addLocalizationBtn')}
            </button>
          </div>

          {localizations.length > 0 ? (
            <div className="stack" style={{ gap: '8px', marginTop: '8px' }}>
              {localizations.map((loc, index) => (
                <div key={loc.id} className="row" style={{ gap: '8px', alignItems: 'center' }}>
                  <select
                    className="input"
                    style={{ width: '135px', fontSize: '12px', padding: '4px 6px', flexShrink: 0 }}
                    value={loc.lang}
                    onChange={(e) => handleUpdateLocalization(index, { lang: e.target.value })}
                    disabled={saving}
                  >
                    {allLanguageOptions.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input grow"
                    style={{ fontSize: '12px', padding: '4px 8px' }}
                    value={loc.name}
                    placeholder={t('customGame.locNamePlaceholder')}
                    onChange={(e) => handleUpdateLocalization(index, { name: e.target.value })}
                    disabled={saving}
                  />
                  <input
                    className="input"
                    style={{ width: '130px', fontSize: '12px', padding: '4px 8px', flexShrink: 0 }}
                    value={loc.shortName}
                    placeholder={loc.name || t('customGame.locShortPlaceholder')}
                    onChange={(e) => handleUpdateLocalization(index, { shortName: e.target.value })}
                    disabled={saving}
                  />
                  <button
                    type="button"
                    className="icon-btn danger-hover"
                    onClick={() => handleRemoveLocalization(index)}
                    title={t('customGame.removeLocalizationTooltip')}
                    disabled={saving}
                    style={{ padding: '4px', width: '28px', height: '28px', flexShrink: 0 }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Row 3: Game ID & Loader */}
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
