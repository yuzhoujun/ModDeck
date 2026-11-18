import { useEffect, useState } from 'react'
import type {
  CharacterHashConflict,
  CharacterInfo,
  GameDef,
  ModDetails,
  ModInfo,
  UiSettings
} from '../../../shared/types'
import { Icon } from '../components/Icon'
import { ImportDropdown } from '../components/ImportDropdown'
import { ModDetailsPanel } from '../components/ModDetailsPanel'
import { ModRow } from '../components/ModRow'
import { displayNameOf, initialOf, modMatches } from '../utils'
import { useI18n, getLocaleCharacterName, getLocaleGameName } from '../i18n'

export function CharacterView({
  game,
  character,
  mods,
  loading,
  query,
  onQuery,
  sort,
  onSort,
  onBack,
  onToggle,
  selectMode,
  onSelectMode,
  onSetMods,
  onOpen,
  onDelete,
  onDeleteMods,
  onImport,
  onImportFolder,
  onEdit,
  onCover,
  onOpenCharacterFolder,
  onReorderMods,
  onRefresh,
  onNotify
}: {
  game: GameDef
  character: CharacterInfo
  mods: ModInfo[]
  loading: boolean
  query: string
  onQuery: (value: string) => void
  sort: UiSettings['sortMods']
  onSort: (value: UiSettings['sortMods']) => void
  onBack: () => void
  onToggle: (mod: ModInfo, exclusive?: boolean) => Promise<void> | void
  selectMode: UiSettings['modSelectMode']
  onSelectMode: (value: UiSettings['modSelectMode']) => void
  onSetMods: (folders: string[], enable: boolean) => Promise<void> | void
  onOpen: (mod: ModInfo) => void
  onDelete: (mod: ModInfo) => Promise<void> | void
  onDeleteMods?: (mods: ModInfo[]) => Promise<void> | void
  onImport: () => void
  onImportFolder: () => void
  onEdit: () => void
  onCover: () => void
  onOpenCharacterFolder: () => void
  onReorderMods: (folders: string[]) => void
  onRefresh: () => void
  onNotify?: (text: string, kind?: 'ok' | 'err' | 'info') => void
}) {
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [details, setDetails] = useState<ModDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [dragName, setDragName] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [conflicts, setConflicts] = useState<CharacterHashConflict[]>([])
  const [conflictsExpanded, setConflictsExpanded] = useState(false)

  const { t, effectiveLocale } = useI18n()
  const name = getLocaleCharacterName(character, effectiveLocale)
  const visible = mods.filter((mod) => modMatches(mod, query))
  const selectedMod = selectedName ? mods.find((mod) => mod.name === selectedName) ?? null : null
  const conflictFolders = new Set<string>()
  for (const item of conflicts) {
    for (const m of item.mods) conflictFolders.add(m.folderName)
  }

  useEffect(() => {
    setChecked(new Set())
    setConflictsExpanded(false)
  }, [character.folder])

  useEffect(() => {
    setChecked((curr) => {
      if (curr.size === 0) return curr
      const valid = new Set(mods.map((m) => m.name))
      const next = new Set(Array.from(curr).filter((name) => valid.has(name)))
      return next.size === curr.size ? curr : next
    })
  }, [mods])

  useEffect(() => {
    const enabledCount = mods.filter((m) => m.enabled).length
    if (enabledCount < 2) {
      setConflicts([])
      return
    }
    let cancelled = false
    window.moddeck
      .scanCharacterHashConflicts(game.id, character.folder)
      .then((res) => {
        if (!cancelled) setConflicts(res)
      })
      .catch(() => {
        if (!cancelled) setConflicts([])
      })
    return () => {
      cancelled = true
    }
  }, [game.id, character.folder, mods])

  useEffect(() => {
    if (!selectedName) return
    const match = mods.find((mod) => mod.name === selectedName)
    if (!match) {
      setSelectedName(null)
      setDetails(null)
      return
    }
    if (
      details &&
      details.name === match.name &&
      (details.enabled !== match.enabled || details.previewUrl !== match.previewUrl)
    ) {
      void window.moddeck
        .getModDetails(game.id, character.folder, match.folderName)
        .then((next) => setDetails(next))
        .catch(() => undefined)
    }
  }, [mods, selectedName, details, game.id, character.folder])

  async function loadDetails(mod: ModInfo) {
    setSelectedName(mod.name)
    setDetailsLoading(true)
    setDetailsError(null)
    try {
      setDetails(await window.moddeck.getModDetails(game.id, character.folder, mod.folderName))
    } catch (error) {
      setDetailsError(error instanceof Error ? error.message : String(error))
      setDetails(null)
    } finally {
      setDetailsLoading(false)
    }
  }

  async function toggleAndRefresh(mod: ModInfo) {
    const nextFolder = mod.enabled ? `DISABLED_${mod.name}` : mod.name
    await onToggle(mod, selectMode === 'single')
    if (selectedName === mod.name) {
      try {
        setDetails(await window.moddeck.getModDetails(game.id, character.folder, nextFolder))
      } catch {
        // 下次点击会重新读取
      }
    }
  }

  async function handleSetModPreview(sourcePath?: string) {
    const targetMod = selectedMod || (details ? { folderName: details.folderName, name: details.name } : null)
    if (!targetMod) return
    try {
      const res = await window.moddeck.setModPreview(
        game.id,
        character.folder,
        targetMod.folderName,
        sourcePath
      )
      if (!res.ok) {
        if (res.error && res.error !== '已取消') {
          onNotify?.(res.error, 'err')
        }
        return
      }
      const nextDetails = await window.moddeck.getModDetails(
        game.id,
        character.folder,
        targetMod.folderName
      )
      setDetails(nextDetails)
      onRefresh()
      onNotify?.(t('character.previewUpdated'), 'ok')
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : String(error), 'err')
    }
  }

  function handleDrop(targetName: string) {
    if (!dragName || dragName === targetName) return
    const names = mods.map((mod) => mod.name)
    const from = names.indexOf(dragName)
    const to = names.indexOf(targetName)
    if (from < 0 || to < 0) return
    const [moved] = names.splice(from, 1)
    names.splice(to, 0, moved)
    onReorderMods(names)
    setDragName(null)
  }

  return (
    <div className="view">
      <button className="back-link" onClick={onBack}>
        <Icon name="back" size={16} />
        {t('character.backToLibrary')}
      </button>

      <header className="char-head">
        <button
          className="char-avatar"
          onClick={onCover}
          title={t('character.changeCover')}
          style={{ borderColor: `${game.accent}66` }}
        >
          {character.coverUrl ? (
            <img src={character.coverUrl} alt="" />
          ) : (
            <span style={{ color: game.accent }}>{initialOf(name)}</span>
          )}
        </button>
        <div className="char-head-main">
          <div className="eyebrow" style={{ color: game.accent }}>
            {getLocaleGameName(game, effectiveLocale)} · {name}
          </div>
          <h1>{name}</h1>
          <div className="chips">
            <span className="chip">{t('common.modsCount', { count: character.modCount })}</span>
            <span className="chip ok">{t('common.enabledCount', { count: character.enabledCount })}</span>
            {character.hiddenCount > 0 ? (
              <span className="chip">{character.hiddenCount} {t('common.disabled')}</span>
            ) : null}
            {!character.known ? <span className="chip new">{t('character.tagNew')}</span> : null}
          </div>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onEdit}>
            <Icon name="edit" size={15} />
            {t('common.edit')}
          </button>
          <button className="btn ghost" onClick={onOpenCharacterFolder}>
            <Icon name="folder" size={15} />
            {t('character.openFolder')}
          </button>
          <ImportDropdown label={t('character.importToCategory')} onImport={onImport} onImportFolder={onImportFolder} />
        </div>
      </header>

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input
            className="input"
            placeholder={t('character.searchPlaceholder')}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
        <select
          className="select"
          value={sort}
          onChange={(event) => onSort(event.target.value as UiSettings['sortMods'])}
        >
          <option value="name">{t('library.sortByName')}</option>
          <option value="recent">{t('character.sortByRecent')}</option>
          <option value="enabled">{t('character.sortByEnabled')}</option>
          <option value="custom">{t('library.sortByCustom')}</option>
        </select>
        <div className="segmented compact">
          <button
            className={selectMode === 'single' ? 'active' : ''}
            onClick={() => {
              onSelectMode('single')
              setChecked(new Set())
            }}
            title={t('character.singleModTooltip')}
          >
            {t('preset.single')}
          </button>
          <button
            className={selectMode === 'multi' ? 'active' : ''}
            onClick={() => onSelectMode('multi')}
            title={t('character.multiModTooltip')}
          >
            {t('preset.multi')}
          </button>
        </div>
        {selectMode === 'multi' && visible.length > 0 ? (
          <>
            <button
              className="btn ghost"
              onClick={() => setChecked(new Set(visible.map((m) => m.name)))}
              disabled={visible.every((m) => checked.has(m.name))}
            >
              {t('character.selectAll')}
            </button>
            <button
              className="btn ghost"
              onClick={() => setChecked(new Set())}
              disabled={checked.size === 0}
            >
              {t('character.deselectAll')}
            </button>
            {checked.size > 0 ? (
              <>
                <span className="hint">{t('character.selectedCount', { count: checked.size })}</span>
                <button
                  className="btn ghost"
                  onClick={() => {
                    void onSetMods(
                      mods.filter((mod) => checked.has(mod.name)).map((mod) => mod.folderName),
                      true
                    )
                    setChecked(new Set())
                  }}
                >
                  {t('character.enableSelected')}
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    void onSetMods(
                      mods.filter((mod) => checked.has(mod.name)).map((mod) => mod.folderName),
                      false
                    )
                    setChecked(new Set())
                  }}
                >
                  {t('character.disableSelected')}
                </button>
                <button
                  className="btn ghost danger-text"
                  onClick={() => {
                    const targets = mods.filter((mod) => checked.has(mod.name))
                    if (targets.length === 0) return
                    if (onDeleteMods) {
                      void onDeleteMods(targets)
                    } else {
                      void onDelete(targets[0])
                    }
                  }}
                  title={t('character.deleteToRecycleBin')}
                >
                  <Icon name="trash" size={14} />
                  {t('character.deleteSelected')}
                </button>
              </>
            ) : null}
          </>
        ) : null}
        {sort === 'custom' ? <span className="hint">{t('character.dragToSort')}</span> : null}
        <button className="btn ghost" onClick={onRefresh}>
          <Icon name="refresh" size={15} />
          {t('common.refresh')}
        </button>

      </div>

      <div className={`char-body${selectedName ? ' has-detail' : ''}`}>
        <div className="char-main">
          {loading ? (
            <div className="empty-panel">
              <div className="spinner" />
              <p className="muted">{t('common.loading')}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-panel">
              <div className="empty-icon">
                <Icon name="box" size={28} />
              </div>
              <h2>{query ? t('common.noMatchingMods') : t('character.emptyModsTitle')}</h2>
              <p className="muted">{query ? t('library.emptySearchDesc') : t('character.emptyModsDesc')}</p>
            </div>
          ) : (
            <>
              {conflicts.length > 0 ? (
                <div className="conflict-banner">
                  <div className="conflict-banner-head">
                    <div className="conflict-banner-title">
                      <Icon name="info" size={15} />
                      <span>{t('character.conflictBannerTitle', { count: conflicts.length })}</span>
                    </div>
                    <button
                      type="button"
                      className="btn ghost tiny-btn"
                      onClick={() => setConflictsExpanded(!conflictsExpanded)}
                    >
                      {conflictsExpanded ? t('character.conflictCollapse') : t('character.conflictExpand')}
                    </button>
                  </div>
                  <div className="muted small">{t('character.conflictBannerDesc')}</div>
                  {conflictsExpanded ? (
                    <div className="conflict-banner-list">
                      {conflicts.slice(0, 20).map((conflict) => (
                        <div key={conflict.hash} className="conflict-item">
                          <div className="conflict-item-head">
                            <code>{conflict.hash}</code>
                            <span className="tag">{conflict.kind}</span>
                            {conflict.severity ? (
                              <span className={`tag sev-${conflict.severity}`}>
                                {conflict.severity.toUpperCase()}
                              </span>
                            ) : null}
                          </div>
                          <div className="conflict-item-mods">
                            {conflict.mods.map((m) => (
                              <span key={m.folderName} className="chip">
                                {m.name} ({m.files[0] || ''}
                                {m.lines?.[0] ? `:${m.lines[0]}` : ''}{' '}
                                {m.sections[0] ? `[${m.sections[0]}]` : ''})
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="mod-list">
              {visible.map((mod) => (
                <ModRow
                  key={mod.folderName}
                  mod={mod}
                  selected={selectedName === mod.name}
                  draggable={sort === 'custom'}
                  dragging={dragName === mod.name}
                  selectable={selectMode === 'multi'}
                  checked={checked.has(mod.name)}
                  hasHashConflict={conflictFolders.has(mod.folderName)}
                  onCheck={() =>
                    setChecked((current) => {
                      const next = new Set(current)
                      if (next.has(mod.name)) next.delete(mod.name)
                      else next.add(mod.name)
                      return next
                    })
                  }
                  onSelect={() => void loadDetails(mod)}
                  onToggle={() => void toggleAndRefresh(mod)}
                  onOpen={() => onOpen(mod)}
                  onDelete={() => {
                    void onDelete(mod)
                  }}
                  onDragStart={(event) => {
                    setDragName(mod.name)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', mod.name)
                  }}
                  onDragOver={(event) => {
                    if (!dragName) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(event) => {
                    if (!dragName) return
                    event.preventDefault()
                    handleDrop(mod.name)
                  }}
                  onDragEnd={() => setDragName(null)}
                />
              ))}
              </div>
            </>
          )}
        </div>

        {selectedName ? (
          <ModDetailsPanel
            gameId={game.id}
            details={details}
            loading={detailsLoading}
            error={detailsError}
            conflicts={conflicts}
            onClose={() => {
              setSelectedName(null)
              setDetails(null)
            }}
            onToggle={() => {
              if (selectedMod) void toggleAndRefresh(selectedMod)
            }}
            onOpen={() => {
              if (selectedMod) onOpen(selectedMod)
            }}
            onDelete={() => {
              if (!selectedMod) return
              void onDelete(selectedMod)
            }}
            onRefreshDetails={() => {
              if (selectedMod) {
                void window.moddeck
                  .getModDetails(game.id, character.folder, selectedMod.folderName)
                  .then(setDetails)
                  .catch(() => undefined)
              }
            }}
            onSetPreview={(sourcePath) => void handleSetModPreview(sourcePath)}
            onNotify={onNotify}
          />
        ) : null}
      </div>
    </div>
  )
}
