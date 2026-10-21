import { useEffect, useState } from 'react'
import type {
  Bootstrap,
  CharacterInfo,
  GameId,
  GameSnapshot,
  ModInfo,
  SettingsPatch,
  UiSettings
} from '../../shared/types'
import { EditCharacterModal } from './components/EditCharacterModal'
import { Icon } from './components/Icon'
import { CharacterView } from './views/CharacterView'
import { LibraryView } from './views/LibraryView'
import { SettingsView } from './views/SettingsView'
import { errorMessage } from './utils'

type View = 'library' | 'character' | 'settings'
type ToastKind = 'ok' | 'err' | 'info'

interface Toast {
  kind: ToastKind
  text: string
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [booting, setBooting] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [view, setView] = useState<View>('library')
  const [selected, setSelected] = useState<CharacterInfo | null>(null)
  const [mods, setMods] = useState<ModInfo[]>([])
  const [modsLoading, setModsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [charQuery, setCharQuery] = useState('')
  const [modQuery, setModQuery] = useState('')
  const [editing, setEditing] = useState<CharacterInfo | null>(null)

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
    if (!snap) throw new Error('扫描失败')
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

  async function toggleMod(mod: ModInfo) {
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
        enable
      )
      if (!result.ok) {
        notify(result.error || '切换失败', 'err')
        await loadModsFor(gameId, selected)
        return
      }
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
    if (!window.confirm(`确定把「${mod.name}」移到回收站？`)) return
    try {
      const result = await window.moddeck.deleteMod(
        snapshot.game.id,
        selected.folder,
        mod.folderName
      )
      if (!result.ok) {
        notify(result.error || '删除失败', 'err')
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

  async function runImport(kind: 'files' | 'folder') {
    if (!snapshot) return
    const gameId = snapshot.game.id
    const paths =
      kind === 'files'
        ? await window.moddeck.pickImportFiles()
        : [await window.moddeck.pickImportFolder()].filter((item): item is string => Boolean(item))
    if (paths.length === 0) return

    setBusy(true)
    try {
      const result = await window.moddeck.importRun({
        gameId,
        ...(kind === 'files' ? { archivePaths: paths } : { folderPaths: paths }),
        targetCharacter:
          view === 'character' && selected ? selected.folder : undefined
      })
      const failed = result.items.filter((item) => !item.ok)
      if (result.importedMods > 0) {
        const created =
          result.createdCharacters.length > 0
            ? `，新增角色：${result.createdCharacters.join('、')}`
            : ''
        notify(`已导入 ${result.importedMods} 个 Mod${created}`)
      }
      if (failed.length > 0) {
        notify(failed[0].message || '部分文件导入失败', 'err')
      } else if (result.importedMods === 0) {
        notify('没有导入任何内容', 'info')
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
      notify('角色信息已保存')
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
      notify('已恢复默认')
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function changeCover() {
    if (!selected || !snapshot) return
    try {
      const result = await window.moddeck.setCharacterCover(snapshot.game.id, selected.folder)
      if (!result.ok) {
        if (result.error !== '已取消') notify(result.error || '设置封面失败', 'err')
        return
      }
      const snap = await refreshSnapshot(snapshot.game.id)
      const updated = snap.characters.find((entry) => entry.folder === selected.folder) ?? null
      setSelected(updated)
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
      if (!result.ok) notify(result.error || '启动失败', 'err')
    } catch (error) {
      notify(errorMessage(error), 'err')
    }
  }

  async function reorderCharacters(folders: string[]) {
    if (!snapshot) return
    try {
      const result = await window.moddeck.reorderCharacters(snapshot.game.id, folders)
      if (!result.ok) {
        notify(result.error || '排序保存失败', 'err')
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
        notify(result.error || '排序保存失败', 'err')
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
        <p className="muted">正在读取本地库…</p>
      </div>
    )
  }

  if (fatal || !boot || !snapshot) {
    return (
      <div className="boot-screen">
        <div className="brand-mark large">M</div>
        <h2>启动失败</h2>
        <p className="muted">{fatal || '无法读取配置'}</p>
        <button className="btn" onClick={() => window.location.reload()}>
          重试
        </button>
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
            <span>local mod manager</span>
          </div>
        </div>

        <div className="side-label">游戏</div>
        <nav className="game-nav">
          {boot.games.map((game) => {
            const active = snapshot.game.id === game.id
            return (
              <button
                key={game.id}
                className={`game-nav-item${active ? ' active' : ''}`}
                onClick={() => void switchGame(game.id)}
                style={active ? { borderColor: `${game.accent}55` } : undefined}
              >
                <span className="dot" style={{ background: game.accent }} />
                <span className="grow">{game.shortName}</span>
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
            onClick={() => setView('settings')}
          >
            <Icon name="settings" size={17} />
            设置
          </button>
          <div className="version">v{boot.appVersion} · MIT</div>
        </div>
      </aside>

      <main className="main">
        {view === 'settings' ? (
          <SettingsView
            games={boot.games}
            settings={boot.settings}
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
            onOpenSettings={() => setView('settings')}
            onLaunchGame={() => void launchConfigured('game')}
            onLaunchLoader={() => void launchConfigured('loader')}
            onReorderCharacters={reorderCharacters}
          />
        )}
      </main>

      {editing ? (
        <EditCharacterModal
          character={editing}
          onClose={() => setEditing(null)}
          onSave={saveCharacterMeta}
          onReset={resetCharacterMeta}
        />
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.text}</div> : null}

      {busy ? (
        <div className="busy-overlay">
          <div className="spinner" />
          <span>正在导入，请稍候…</span>
        </div>
      ) : null}
    </div>
  )
}
