import { useMemo, useState } from 'react'
import type {
  CharacterInfo,
  GameDef,
  ImportCommitItem,
  ImportParseResult
} from '../../../shared/types'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { useI18n, getLocaleCharacterName, getLocaleGameShortName } from '../i18n'

export function ImportPreviewModal({
  game,
  parsed,
  characters,
  rosterNames,
  targetCharacter,
  onCancel,
  onCommit
}: {
  game: GameDef
  parsed: ImportParseResult
  characters: CharacterInfo[]
  rosterNames?: string[]
  targetCharacter?: string
  onCancel: () => void
  onCommit: (items: ImportCommitItem[]) => Promise<void>
}) {
  const { t, effectiveLocale } = useI18n()

  const defaultOtherFolder = useMemo(() => {
    return characters.some((c) => c.folder === 'Others') ? 'Others' : '其他'
  }, [characters])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(parsed.candidates.map((c) => c.id))
  )
  const [charAssignments, setCharAssignments] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    for (const candidate of parsed.candidates) {
      map[candidate.id] = targetCharacter || candidate.suggestedCharacter || defaultOtherFolder
    }
    return map
  })
  const [submitting, setSubmitting] = useState(false)

  const otherLabel = t('common.other')

  const characterOptions = useMemo(() => {
    const options = new Map<string, { folder: string; label: string; isExisting: boolean }>()

    // 1. Existing folders in Mods directory
    for (const char of characters) {
      const localizedName = getLocaleCharacterName(char, effectiveLocale)
      options.set(char.folder, {
        folder: char.folder,
        label:
          localizedName !== char.folder
            ? `${localizedName} (${char.folder})`
            : localizedName,
        isExisting: true
      })
    }

    // 2. Ensure "Other" folder is always available
    if (!options.has('其他') && !options.has('Others')) {
      options.set(defaultOtherFolder, {
        folder: defaultOtherFolder,
        label: t('importModal.newFolderSuffix', { name: otherLabel }),
        isExisting: false
      })
    }

    // 3. Ensure any suggested characters from parser are in the list
    for (const candidate of parsed.candidates) {
      const folder = candidate.suggestedCharacter || defaultOtherFolder
      if (!options.has(folder)) {
        const isOther = folder === '其他' || folder === 'Others'
        options.set(folder, {
          folder,
          label: t('importModal.newFolderSuffix', { name: isOther ? otherLabel : folder }),
          isExisting: false
        })
      }
    }

    // 4. Built-in + remote merged roster names for this game
    for (const name of rosterNames ?? []) {
      if (!options.has(name)) {
        const isOther = name === '其他' || name === 'Others'
        options.set(name, {
          folder: name,
          label: t('importModal.newFolderSuffix', { name: isOther ? otherLabel : name }),
          isExisting: false
        })
      }
    }

    return Array.from(options.values())
  }, [characters, defaultOtherFolder, effectiveLocale, otherLabel, parsed.candidates, rosterNames, t])

  const existingOptions = characterOptions.filter((opt) => opt.isExisting)
  const newOptions = characterOptions.filter((opt) => !opt.isExisting)

  const allChecked =
    parsed.candidates.length > 0 && selectedIds.size === parsed.candidates.length

  function toggleAll() {
    if (allChecked) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(parsed.candidates.map((c) => c.id)))
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setAllCharacter(folder: string) {
    if (!folder) return
    setCharAssignments((current) => {
      const next = { ...current }
      for (const candidate of parsed.candidates) {
        if (selectedIds.has(candidate.id)) {
          next[candidate.id] = folder
        }
      }
      return next
    })
  }

  async function handleConfirm() {
    if (selectedIds.size === 0) return
    setSubmitting(true)
    try {
      const items: ImportCommitItem[] = parsed.candidates
        .filter((candidate) => selectedIds.has(candidate.id))
        .map((candidate) => ({
          id: candidate.id,
          characterFolder: charAssignments[candidate.id] || defaultOtherFolder,
          modName: candidate.modName
        }))
      await onCommit(items)
    } finally {
      setSubmitting(false)
    }
  }

  function formatMatchReason(reason: string | undefined): string {
    if (!reason) return ''
    if (reason === '当前角色页' || reason === 'Current character page') {
      return t('importModal.matchCurrentPage')
    }
    if (
      reason === '未匹配（默认其他）' ||
      reason === 'Unmatched (Default to Other)'
    ) {
      return t('importModal.matchUnmatched')
    }
    const matchZh = reason.match(/^匹配「(.+)」$/)
    if (matchZh) {
      return t('importModal.matchMatched', { name: matchZh[1] })
    }
    const matchEn = reason.match(/^Matched "(.+)"$/)
    if (matchEn) {
      return t('importModal.matchMatched', { name: matchEn[1] })
    }
    return reason
  }

  const targetCharInfo = targetCharacter
    ? characters.find((c) => c.folder === targetCharacter)
    : undefined
  const targetDisplayName = targetCharInfo
    ? getLocaleCharacterName(targetCharInfo, effectiveLocale)
    : targetCharacter

  const modalTitle = targetDisplayName
    ? t('importModal.titleTarget', { character: targetDisplayName })
    : t('importModal.titleGame', { game: getLocaleGameShortName(game, effectiveLocale) })

  return (
    <Modal
      title={modalTitle}
      onClose={() => {
        if (!submitting) onCancel()
      }}
      width={680}
      footer={
        <>
          <span className="muted small">
            {t('importModal.selectedCount', {
              selected: selectedIds.size,
              total: parsed.candidates.length
            })}
          </span>
          <div className="grow" />
          <button className="btn ghost" onClick={onCancel} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            onClick={() => void handleConfirm()}
            disabled={submitting || selectedIds.size === 0}
          >
            <Icon name="check" size={15} />
            {submitting
              ? t('importModal.importing')
              : t('importModal.importButton', { count: selectedIds.size })}
          </button>
        </>
      }
    >
      <div className="import-parse-head">
        <label className="check-row" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
            disabled={parsed.candidates.length === 0 || submitting}
          />
          <span>{t('importModal.selectAll')}</span>
        </label>
        <div className="grow" />
        {parsed.candidates.length > 1 ? (
          <div className="row" style={{ gap: 6 }}>
            <span className="muted small">{t('importModal.batchSetTo')}</span>
            <select
              className="select compact-select"
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) {
                  setAllCharacter(event.target.value)
                  event.target.value = ''
                }
              }}
              disabled={submitting}
            >
              <option value="">{t('importModal.selectTargetCharacter')}</option>
              {existingOptions.length > 0 ? (
                <optgroup label={t('importModal.existingFoldersGroup')}>
                  {existingOptions.map((opt) => (
                    <option key={opt.folder} value={opt.folder}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {newOptions.length > 0 ? (
                <optgroup label={t('importModal.newFoldersGroup')}>
                  {newOptions.map((opt) => (
                    <option key={opt.folder} value={opt.folder}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
        ) : null}
      </div>

      {parsed.errors.length > 0 ? (
        <div className="import-parse-errors">
          {parsed.errors.map((err, idx) => (
            <div key={idx} className="error-text">
              {err.source}: {err.message}
            </div>
          ))}
        </div>
      ) : null}

      {parsed.candidates.length === 0 ? (
        <div className="empty-panel" style={{ marginTop: 12, padding: '28px 16px' }}>
          <p className="muted">{t('importModal.emptyCandidates')}</p>
        </div>
      ) : (
        <div className="import-candidate-list">
          {parsed.candidates.map((candidate) => {
            const checked = selectedIds.has(candidate.id)
            const assigned = charAssignments[candidate.id] || defaultOtherFolder
            return (
              <div
                key={candidate.id}
                className={`import-candidate-row${checked ? ' is-checked' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mod-check"
                  checked={checked}
                  onChange={() => toggleOne(candidate.id)}
                  disabled={submitting}
                />
                <div
                  className="import-candidate-main"
                  onClick={() => {
                    if (!submitting) toggleOne(candidate.id)
                  }}
                >
                  <div className="import-candidate-title">
                    <strong>{candidate.modName}</strong>
                    {!candidate.hasIni ? (
                      <span className="tag warn" title={t('importModal.noIniTooltip')}>
                        {t('importModal.noIni')}
                      </span>
                    ) : null}
                  </div>
                  <div className="import-candidate-sub">
                    <span>
                      {t('importModal.sourcePrefix')}
                      {candidate.sourceName}
                    </span>
                    {candidate.matchReason ? (
                      <span> · {formatMatchReason(candidate.matchReason)}</span>
                    ) : null}
                  </div>
                </div>
                <select
                  className="select compact-select import-char-select"
                  value={assigned}
                  onChange={(event) =>
                    setCharAssignments((current) => ({
                      ...current,
                      [candidate.id]: event.target.value
                    }))
                  }
                  disabled={submitting}
                  title={t('importModal.selectCharTooltip')}
                >
                  {existingOptions.length > 0 ? (
                    <optgroup label={t('importModal.existingFoldersGroup')}>
                      {existingOptions.map((opt) => (
                        <option key={opt.folder} value={opt.folder}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {newOptions.length > 0 ? (
                    <optgroup label={t('importModal.newFoldersGroup')}>
                      {newOptions.map((opt) => (
                        <option key={opt.folder} value={opt.folder}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
