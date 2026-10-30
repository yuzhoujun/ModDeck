import { useEffect, useState, type DragEvent } from 'react'
import type {
  Bootstrap,
  CharacterInfo,
  EnvironmentCheck,
  GameId,
  GameSnapshot,
  ImportCommitItem,
  ImportParseResult,
  ModInfo,
  SettingsPatch,
  UiSettings
} from '../../shared/types'
import { CreateCharacterModal } from './components/CreateCharacterModal'
import { EditCharacterModal } from './components/EditCharacterModal'
import { Icon } from './components/Icon'
import { ImportPreviewModal } from './components/ImportPreviewModal'
import { RosterPresetModal } from './components/RosterPresetModal'
import { CharacterView } from './views/CharacterView'
import { LibraryView } from './views/LibraryView'
import { SettingsView } from './views/SettingsView'
import { errorMessage } from './utils'
import { useI18n, getLocaleGameShortName } from './i18n'

type View = 'library' | 'character' | 'settings'
type ToastKind = 'ok' | 'err' | 'info'

interface Toast {
  kind: ToastKind
  text: string
}

export default function App() {
  const { t, effectiveLocale } = useI18n()
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [booting, setBooting] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [view, setView] = useState<View>('library')
  const [settingsTab, setSettingsTab] = useState<'general' | 'advanced' | 'games' | 'environment' | 'import' | 'about'>('general')
  const [selected, setSelected] = useState<CharacterInfo | null>(null)
  const [mods, setMods] = useState<ModInfo[]>([])
  const [modsLoading, setModsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [charQuery, setCharQuery] = useState('')
  const [modQuery, setModQuery] = useState('')
  const [editing, setEditing] = useState<CharacterInfo | null>(null)
  const [creating, setCreating] = useState(false)
  const [showRosterPresets, setShowRosterPresets] = useState(false)
  const [envWarning, setEnvWarning] = useState<EnvironmentCheck | null>(null)
  const [parsedImport, setParsedImport] = useState<{
    result: ImportParseResult
    targetCharacter?: string
  } | null>(null)
  const [dropActive, setDropActive] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await window.moddeck.bootstrap()
        if (cancelled) return
        setBoot(data)
        setSnapshot(data.snapshot)
      } catch (error) {
        if (!cancelled) setFatal(errorMessage(error))
      } finally {
        if (!cancelled) setBooting(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (booting) return
    let active = true
    const unsubscribe = window.moddeck.onStateChanged(() => {
      void (async () => {
        try {
          const data = await window.moddeck.bootstrap()
          if (!active || !data.snapshot) return
          setBoot(data)
          const prevGameId = snapshot?.game.id
          setSnapshot(data.snapshot)
          if (prevGameId && prevGameId !== data.snapshot.game.id) {
            setSelected(null)
            setMods([])
            if (view === 'character') setView('library')
            return
          }
          if (selected) {
            const updated =
              data.snapshot.characters.find((entry) => entry.folder === selected.folder) ?? null
            setSelected(updated)
            if (updated) {
              const nextMods = await window.moddeck.getMods(data.snapshot.game.id, updated.folder)
              if (active) setMods(nextMods)
            } else {
              setMods([])
              if (view === 'character') setView('library')
            }
          }
        } catch {
          // ignore background sync errors
        }
      })()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [booting, snapshot?.game.id, selected?.folder, view])

  useEffect(() => {
    if (!boot || !snapshot) return
    if (!boot.settings.ui.envCheckEnabled || boot.settings.ui.envCheckNeverPrompt) {
      setEnvWarning(null)
      return
    }
    let cancelled = false
    window.moddeck
      .checkEnvironment(snapshot.game.id)
      .then((list) => {
        if (cancelled) return
        const active = list.find((item) => item.gameId === snapshot.game.id)
        setEnvWarning(active?.status === 'missing-line' ? active : null)
      })
      .catch(() => {
        if (!cancelled) setEnvWarning(null)
      })
    return () => {
      cancelled = true
    }
  }, [
    boot?.settings.ui.envCheckEnabled,
    boot?.settings.ui.envCheckNeverPrompt,
    snapshot?.game.id
  ])

  async function dismissEnvWarning(never: boolean) {
    setEnvWarning(null)
    if (!never) return
    try {
      const next = await window.moddeck.saveSettings({ ui: { envCheckNeverPrompt: true } })
      setBoot((current) => (current ? { ...current, settings: next } : current))
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  function notify(text: string, kind: ToastKind = 'ok') {
    setToast({ kind, text })
  }

  async function loadModsFor(gameId: GameId, character: CharacterInfo) {
    setModsLoading(true)
    try {
      setMods(await window.moddeck.getMods(gameId, character.folder))
    } catch (error) {
      notify(errorMessage(error), 'err')
    } finally {
      setModsLoading(false)
    }
  }

  async function refreshSnapshot(gameId: GameId): Promise<GameSnapshot> {
    const snap = await window.moddeck.scanGame(gameId)
    if (!snap) throw new Error(t('common.scanFailed'))
    setSnapshot(snap)
    return snap
  }

  async function syncSelected(snap: GameSnapshot) {
    if (!selected) return
    const updated = snap.characters.find((entry) => entry.folder === selected.folder) ?? null
    setSelected(updated)
    if (updated) await loadModsFor(snap.game.id, updated)
  }

  async function switchGame(gameId: GameId) {
    if (!snapshot) return
    if (gameId === snapshot.game.id) {
      setView('library')
      return
    }
    try {
      const snap = await window.moddeck.switchGame(gameId)
      if (snap) {
        setSnapshot(snap)
        setView('library')
        setSelected(null)
        setMods([])
        setCharQuery('')
      }
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function openCharacter(character: CharacterInfo) {
    if (!snapshot) return
    setSelected(character)
    setView('character')
    setModQuery('')
    await loadModsFor(snapshot.game.id, character)
  }

  async function toggleMod(mod: ModInfo, exclusive = false) {
    if (!selected || !snapshot) return
    const gameId = snapshot.game.id
    const originalFolder = mod.folderName
    const enable = !mod.enabled

    setMods((list) =>
      list.map((item) =>
        item.folderName === originalFolder
          ? {
              ...item,
              enabled: enable,
              folderName: enable ? item.name : `DISABLED_${item.name}`
            }
          : item
      )
    )

    try {
      const result = await window.moddeck.toggleMod(
        gameId,
        selected.folder,
        originalFolder,
        enable,
        exclusive
      )
      if (!result.ok) {
        notify(result.error || t('common.switchFailed'), 'err')
        await loadModsFor(gameId, selected)
        return
      }
      if (exclusive) await loadModsFor(gameId, selected)
      const snap = await refreshSnapshot(gameId)
      const updated = snap.characters.find((entry) => entry.folder === selected.folder)
      if (updated) setSelected(updated)
    } catch (error) {
      notify(errorMessage(error), 'err')
      await loadModsFor(gameId, selected)
    }
  }

  async function deleteMod(mod: ModInfo) {
    if (!selected || !snapshot) return
    if (!window.confirm(t('common.confirmDeleteMod', { name: mod.name }))) return
    try {
      const result = await window.moddeck.deleteMod(
        snapshot.game.id,
        selected.folder,
        mod.folderName
      )
      if (!result.ok) {
        notify(result.error || t('common.deleteFailed'), 'err')
        return
      }
      setMods((list) => list.filter((item) => item.folderName !== mod.folderName))
      const snap = await refreshSnapshot(snapshot.game.id)
      const updated = snap.characters.find((entry) => entry.folder === selected.folder)
      if (updated) setSelected(updated)
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function openModFolder(mod: ModInfo) {
    if (!selected || !snapshot) return
    const result = await window.moddeck.openModFolder(
      snapshot.game.id,
      selected.folder,
      mod.folderName
    )
    if (!result.ok && result.error) notify(result.error, 'err')
  }

  async function openImportPreview(paths: string[], targetCharacter?: string) {
    if (!snapshot || paths.length === 0) return
    if (!snapshot.modsPathExists) {
      notify(t('common.modsDirNotConfigured'), 'err')
      return
    }
    setBusy(true)
    try {
      const parsed = await window.moddeck.importParse({
        gameId: snapshot.game.id,
        paths,
        targetCharacter
      })
      if (parsed.candidates.length === 0) {
        await window.moddeck.importDiscard(parsed.sessionId)
        const msg = parsed.errors[0]?.message || t('common.noModsFoundInImport')
        notify(msg, 'err')
        return
      }
      setParsedImport({ result: parsed, targetCharacter })
    } catch (error) {
      notify(errorMessage(error), 'err')
    } finally {
      setBusy(false)
    }
  }

  async function runImport(kind: 'files' | 'folder') {
    if (!snapshot) return
    const paths =
      kind === 'files'
        ? await window.moddeck.pickImportFiles()
        : await window.moddeck.pickImportFolders()
    if (!paths || paths.length === 0) return
    const targetCharacter = view === 'character' && selected ? selected.folder : undefined
    await openImportPreview(paths, targetCharacter)
  }

  async function commitParsedImport(items: ImportCommitItem[]) {
    if (!snapshot || !parsedImport) return
    const gameId = snapshot.game.id
    const sessionId = parsedImport.result.sessionId
    setBusy(true)
    try {
      const result = await window.moddeck.importCommit({
        sessionId,
        gameId,
        items
      })
      setParsedImport(null)
      const failed = result.items.filter((item) => !item.ok)
      if (result.importedMods > 0) {
        const created =
          result.createdCharacters.length > 0
            ? t('common.createdCharactersSummary', { chars: result.createdCharacters.join('、') })
            : ''
        notify(t('common.importedModsSummary', { count: result.importedMods, created }))
      }
      if (failed.length > 0) {
        notify(failed[0].message || t('common.someImportsFailed'), 'err')
      } else if (result.importedMods === 0) {
        notify(t('common.noContentImported'), 'info')
      }
      const snap = await refreshSnapshot(gameId)
      if (view === 'character' && selected) {
        const updated = snap.characters.find((entry) => entry.folder === selected.folder)
        if (updated) {
          setSelected(updated)
          await loadModsFor(gameId, updated)
        }
      }
    } catch (error) {
      notify(errorMessage(error), 'err')
    } finally {
      setBusy(false)
    }
  }

  async function cancelParsedImport() {
    if (!parsedImport) return
    const sessionId = parsedImport.result.sessionId
    setParsedImport(null)
    await window.moddeck.importDiscard(sessionId).catch(() => undefined)
  }

  function isExternalFileDrag(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files')
  }

  function handleMainDragOver(event: DragEvent<HTMLElement>) {
    if (view === 'settings' || editing || creating || parsedImport) return
    if (!isExternalFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  function handleMainDragLeave(event: DragEvent<HTMLElement>) {
    if (!dropActive) return
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setDropActive(false)
  }

  function handleMainDrop(event: DragEvent<HTMLElement>) {
    if (view === 'settings' || editing || creating || parsedImport) return
    if (!isExternalFileDrag(event)) return
    event.preventDefault()
    setDropActive(false)
    const files = Array.from(event.dataTransfer.files)
    const paths = files
      .map((file) => window.moddeck.getPathForFile(file))
      .filter((item): item is string => Boolean(item))
    if (paths.length === 0) return
    const targetCharacter = view === 'character' && selected ? selected.folder : undefined
    void openImportPreview(paths, targetCharacter)
  }

  async function saveCharacterMeta(patch: {
    displayName?: string
    aliases?: string[]
    order?: number
  }) {
    if (!selected || !snapshot) return
    try {
      const snap = await window.moddeck.updateCharacterMeta(
        snapshot.game.id,
        selected.folder,
        patch
      )
      if (snap) {
        setSnapshot(snap)
        const updated = snap.characters.find((entry) => entry.folder === selected.folder) ?? null
        setSelected(updated)
      }
      setEditing(null)
      notify(t('common.characterSaved'))
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function resetCharacterMeta() {
    if (!selected || !snapshot) return
    try {
      const snap = await window.moddeck.resetCharacterMeta(
        snapshot.game.id,
        selected.folder
      )
      if (snap) {
        setSnapshot(snap)
        const updated = snap.characters.find((entry) => entry.folder === selected.folder) ?? null
        setSelected(updated)
      }
      setEditing(null)
      notify(t('common.restoredDefault'))
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function changeCover() {
    if (!selected || !snapshot) return
    try {
      const result = await window.moddeck.setCharacterCover(snapshot.game.id, selected.folder)
      if (!result.ok) {
        if (result.error !== '已取消' && result.error !== 'Canceled') notify(result.error || t('common.setCoverFailed'), 'err')
        return
      }
      const snap = await refreshSnapshot(snapshot.game.id)
      const updated = snap.characters.find((entry) => entry.folder === selected.folder) ?? null
      setSelected(updated)
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function saveCharacterCoverData(dataUrl: string) {
    if (!selected || !snapshot) return
    const snap = await window.moddeck.saveCharacterCoverData(
      snapshot.game.id,
      selected.folder,
      dataUrl
    )
    if (snap) {
      setSnapshot(snap)
      const updated = snap.characters.find((entry) => entry.folder === selected.folder) ?? null
      setSelected(updated)
      setEditing(updated)
    }
    notify(t('common.coverSaved'))
  }

  async function removeCharacterCover() {
    if (!selected || !snapshot) return
    const snap = await window.moddeck.clearCharacterCover(snapshot.game.id, selected.folder)
    if (snap) {
      setSnapshot(snap)
      const updated = snap.characters.find((entry) => entry.folder === selected.folder) ?? null
      setSelected(updated)
      setEditing(updated)
    }
    notify(t('common.coverRemoved'))
  }

  async function createCharacter(input: {
    folder: string
    displayName?: string
    aliases?: string[]
    kind?: 'character' | 'utility'
  }) {
    if (!snapshot) return
    const snap = await window.moddeck.createCharacter(snapshot.game.id, input)
    if (!snap) return
    setSnapshot(snap)
    setCreating(false)
    const created = snap.characters.find((entry) => entry.folder === input.folder) ?? null
    if (created) {
      setSelected(created)
      setView('character')
      await loadModsFor(snap.game.id, created)
    }
    notify(t('common.characterCreated', { name: created?.displayName || input.folder }))
  }

  async function setModsEnabled(folders: string[], enable: boolean) {
    if (!selected || !snapshot) return
    try {
      const result = await window.moddeck.setModsEnabled(
        snapshot.game.id,
        selected.folder,
        folders,
        enable
      )
      if (!result.ok) {
        notify(result.error || t('common.batchOpFailed'), 'err')
      }
      await loadModsFor(snapshot.game.id, selected)
      const snap = await refreshSnapshot(snapshot.game.id)
      const updated = snap.characters.find((entry) => entry.folder === selected.folder)
      if (updated) setSelected(updated)
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function changeModSelectMode(value: UiSettings['modSelectMode']) {
    try {
      const next = await window.moddeck.saveSettings({ ui: { modSelectMode: value } })
      setBoot((current) => (current ? { ...current, settings: next } : current))
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function saveSettings(patch: SettingsPatch) {
    const next = await window.moddeck.saveSettings(patch)
    setBoot((current) => (current ? { ...current, settings: next } : current))
    const snap = await window.moddeck.scanGame(next.activeGameId)
    setSnapshot(snap)
    if (view === 'character') {
      setView('library')
      setSelected(null)
      setMods([])
    }
  }

  async function changeCharacterSort(value: UiSettings['sortCharacters']) {
    try {
      const next = await window.moddeck.saveSettings({ ui: { sortCharacters: value } })
      setBoot((current) => (current ? { ...current, settings: next } : current))
      if (snapshot) await refreshSnapshot(snapshot.game.id)
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function changeModSort(value: UiSettings['sortMods']) {
    try {
      const next = await window.moddeck.saveSettings({ ui: { sortMods: value } })
      setBoot((current) => (current ? { ...current, settings: next } : current))
      if (snapshot && selected) await loadModsFor(snapshot.game.id, selected)
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function changeCharacterFilter(value: UiSettings['characterFilter']) {
    try {
      const next = await window.moddeck.saveSettings({ ui: { characterFilter: value } })
      setBoot((current) => (current ? { ...current, settings: next } : current))
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function launchConfigured(kind: 'game' | 'loader') {
    if (!snapshot) return
    try {
      const result =
        kind === 'game'
          ? await window.moddeck.launchGame(snapshot.game.id)
          : await window.moddeck.launchLoader(snapshot.game.id)
      if (!result.ok) notify(result.error || t('common.startupFailed'), 'err')
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function reorderCharacters(folders: string[]) {
    if (!snapshot) return
    try {
      const result = await window.moddeck.reorderCharacters(snapshot.game.id, folders)
      if (!result.ok) {
        notify(result.error || t('common.sortSaveFailed'), 'err')
        return
      }
      await refreshSnapshot(snapshot.game.id)
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function reorderMods(folders: string[]) {
    if (!snapshot || !selected) return
    try {
      const result = await window.moddeck.reorderMods(
        snapshot.game.id,
        selected.folder,
        folders
      )
      if (!result.ok) {
        notify(result.error || t('common.sortSaveFailed'), 'err')
        return
      }
      setMods(await window.moddeck.getMods(snapshot.game.id, selected.folder))
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function openCharacterFolder() {
    if (!selected || !snapshot) return
    const result = await window.moddeck.openCharacterFolder(
      snapshot.game.id,
      selected.folder
    )
    if (!result.ok && result.error) notify(result.error, 'err')
  }

  if (booting) {
    return (
      <div className="boot-screen">
        <div className="brand-mark large">M</div>
        <div className="spinner" />
        <p className="muted">{t('common.readingLibrary')}</p>
      </div>
    )
  }

  if (fatal || !boot || !snapshot) {
    return (
      <div className="boot-screen">
        <div className="brand-mark large">M</div>
        <h2>{t('common.startupFailed')}</h2>
        <p className="muted">{fatal || t('common.startupFailed')}</p>
        <button className="btn" onClick={() => window.location.reload()}>{t('common.retry')}</button>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>ModDeck</strong>
            <span>{t('sidebar.localModManager')}</span>
          </div>
        </div>

        <div className="side-label">{t('sidebar.games')}</div>
        <nav className="game-nav">
          {boot.games.map((game) => {
            const active = snapshot.game.id === game.id
            return (
              <button
                key={game.id}
                className={`game-nav-item${active ? ' active' : ''}`}
                onClick={() => void switchGame(game.id)}
                style={active ? { borderColor: `${game.accent}55` } : undefined}
                role="radio"
                aria-checked={active}
                title={active ? (effectiveLocale === 'zh-CN' ? '当前游戏' : 'Current game') : (effectiveLocale === 'zh-CN' ? `切换到 ${game.name}` : `Switch to ${game.nameEn || game.name}`)}
              >
                <span className="dot" style={{ background: game.accent }} />
                <span className="grow">{getLocaleGameShortName(game, effectiveLocale)}</span>
                {active ? (
                  <span className="game-count">
                    {snapshot.totalMods}
                  </span>
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-foot">
          <button
            className={`side-action${view === 'settings' ? ' active' : ''}`}
            onClick={() => { setSettingsTab('general'); setView('settings'); }}
          >
            <Icon name="settings" size={17} />
            {t('sidebar.settings')}
          </button>
          <div className="version">v{boot.appVersion} · MIT</div>
        </div>
      </aside>

      <main
        className={`main${dropActive ? ' is-drop-active' : ''}`}
        onDragOver={handleMainDragOver}
        onDragLeave={handleMainDragLeave}
        onDrop={handleMainDrop}
      >
        {dropActive ? (
          <div className="drop-indicator">
            <div className="drop-indicator-box">
              <Icon name="upload" size={28} />
              <strong>
                {view === 'character' && selected
                  ? t('common.dropToImportCharacter', { name: selected.displayName })
                  : t('common.dropToImportGame', { game: getLocaleGameShortName(snapshot.game, effectiveLocale) })}
              </strong>
              <span>{t('common.dropSupportHint')}</span>
            </div>
          </div>
        ) : null}
        {envWarning ? (
          <div className="env-banner">
            <div className="env-banner-main">
              <Icon name="box" size={18} />
              <div>
                <strong>{t('common.efmiNoticeTitle')}</strong>
                <span>
                  {envWarning.detail || t('common.efmiNoticeDefault')}
                </span>
              </div>
            </div>
            <div className="env-banner-actions">
              <button
                className="btn ghost small-btn"
                onClick={() => void window.moddeck.openEnvironmentFolder(envWarning.gameId)}
              >{t('common.openDir')}</button>
              <button
                className="btn ghost small-btn"
                onClick={() => {
                  setEnvWarning(null)
                  setSettingsTab('environment'); setView('settings');
                }}
              >{t('sidebar.settings')}</button>
              <button
                className="btn ghost small-btn"
                onClick={() => void dismissEnvWarning(true)}
                title={t('common.dontShowAgainTip')}
              >{t('common.dontShowAgain')}</button>
              <button
                className="icon-btn"
                onClick={() => void dismissEnvWarning(false)}
                title={t('common.closeThisTime')}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          </div>
        ) : null}
        {view === 'settings' ? (
          <SettingsView
            games={boot.games}
            settings={boot.settings}
            initialTab={settingsTab}
            onSave={saveSettings}
            onNotify={notify}
          />
        ) : view === 'character' && selected ? (
          <CharacterView
            game={snapshot.game}
            character={selected}
            mods={mods}
            loading={modsLoading}
            query={modQuery}
            onQuery={setModQuery}
            sort={boot.settings.ui.sortMods}
            onSort={changeModSort}
            onBack={() => setView('library')}
            onToggle={toggleMod}
            selectMode={boot.settings.ui.modSelectMode}
            onSelectMode={changeModSelectMode}
            onSetMods={setModsEnabled}
            onOpen={openModFolder}
            onDelete={deleteMod}
            onImport={() => void runImport('files')}
            onImportFolder={() => void runImport('folder')}
            onEdit={() => setEditing(selected)}
            onCover={changeCover}
            onOpenCharacterFolder={openCharacterFolder}
            onReorderMods={reorderMods}
            onRefresh={() =>
              void (async () => {
                const snap = await refreshSnapshot(snapshot.game.id)
                await syncSelected(snap)
              })()
            }
            onNotify={notify}
          />
        ) : (
          <LibraryView
            game={snapshot.game}
            snapshot={snapshot}
            query={charQuery}
            onQuery={setCharQuery}
            sort={boot.settings.ui.sortCharacters}
            onSort={changeCharacterSort}
            filter={boot.settings.ui.characterFilter}
            onFilter={changeCharacterFilter}
            onOpenCharacter={openCharacter}
            onImport={() => void runImport('files')}
            onImportFolder={() => void runImport('folder')}
            onRefresh={() => void refreshSnapshot(snapshot.game.id)}
            onOpenSettings={(targetTab) => { setSettingsTab(targetTab ?? 'games'); setView('settings'); }}
            onLaunchGame={() => void launchConfigured('game')}
            onLaunchLoader={() => void launchConfigured('loader')}
            onReorderCharacters={reorderCharacters}
            onAdd={() => setCreating(true)}
            onOpenRosterPresets={() => setShowRosterPresets(true)}
          />
        )}
      </main>

      {showRosterPresets && snapshot ? (
        <RosterPresetModal
          game={snapshot.game}
          snapshot={snapshot}
          onClose={() => setShowRosterPresets(false)}
          onNotify={notify}
        />
      ) : null}
      {editing ? (
        <EditCharacterModal
          character={editing}
          onClose={() => setEditing(null)}
          onSave={saveCharacterMeta}
          onReset={resetCharacterMeta}
          onSaveCover={saveCharacterCoverData}
          onRemoveCover={removeCharacterCover}
        />
      ) : null}

      {creating && snapshot ? (
        <CreateCharacterModal
          game={snapshot.game}
          existingFolders={snapshot.characters.map((character) => character.folder)}
          onClose={() => setCreating(false)}
          onCreate={createCharacter}
        />
      ) : null}

      {parsedImport && snapshot ? (
        <ImportPreviewModal
          game={snapshot.game}
          parsed={parsedImport.result}
          characters={snapshot.characters}
          rosterNames={boot.rosterMap?.[snapshot.game.id]}
          targetCharacter={parsedImport.targetCharacter}
          onCancel={() => void cancelParsedImport()}
          onCommit={commitParsedImport}
        />
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.text}</div> : null}

      {busy ? (
        <div className="busy-overlay">
          <div className="spinner" />
          <span>{t('common.loading')}</span>
        </div>
      ) : null}
    </div>
  )
}
