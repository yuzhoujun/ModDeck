import { useEffect, useMemo, useState } from 'react'
import type { Bootstrap, CharacterInfo, GameSnapshot, ModInfo } from '../../shared/types'
import { Icon } from './components/Icon'
import { errorMessage } from './utils'

type CharacterFilter = 'all' | 'withMods' | 'empty'

export function OverlayApp() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [mods, setMods] = useState<ModInfo[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CharacterFilter>('all')
  const [selectMode, setSelectMode] = useState<'single' | 'multi'>('multi')
  const [pinned, setPinned] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await window.moddeck.bootstrap()
        if (cancelled) return
        setBoot(data)
        setSnapshot(data.snapshot)
        setSelectMode(data.settings.ui.modSelectMode)
        setFilter(data.settings.ui.characterFilter)
        setPinned(data.settings.ui.overlayPinned)
        const characters = data.snapshot?.characters ?? []
        const initialFilter = data.settings.ui.characterFilter
        const candidates = characters.filter((character) => {
          if (initialFilter === 'withMods') return character.modCount > 0
          if (initialFilter === 'empty') return character.modCount === 0
          return true
        })
        const first = candidates.find((character) => character.modCount > 0) ?? candidates[0]
        if (first) {
          setSelected(first.folder)
          setMods(await window.moddeck.getMods(data.snapshot!.game.id, first.folder))
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const characters: CharacterInfo[] = snapshot?.characters ?? []
  const filteredCharacters = characters.filter((character) => {
    if (filter === 'withMods') return character.modCount > 0
    if (filter === 'empty') return character.modCount === 0
    return true
  })
  const current = characters.find((character) => character.folder === selected) ?? null
  const visibleMods = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return mods
    return mods.filter((mod) => mod.name.toLowerCase().includes(value))
  }, [mods, query])

  async function selectCharacter(folder: string) {
    if (!snapshot) return
    setSelected(folder)
    setLoading(true)
    try {
      setMods(await window.moddeck.getMods(snapshot.game.id, folder))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  async function changeFilter(value: CharacterFilter) {
    setFilter(value)
    void window.moddeck.saveSettings({ ui: { characterFilter: value } })
    const next = characters.filter((character) => {
      if (value === 'withMods') return character.modCount > 0
      if (value === 'empty') return character.modCount === 0
      return true
    })
    if (next.length > 0 && !next.some((character) => character.folder === selected)) {
      await selectCharacter(next[0].folder)
    }
  }

  async function toggle(mod: ModInfo) {
    if (!snapshot) return
    const enable = !mod.enabled
    const original = mod.folderName
    const exclusive = selectMode === 'single' && enable
    setMods((list) =>
      list.map((item) =>
        item.folderName === original
          ? { ...item, enabled: enable, folderName: enable ? item.name : `DISABLED_${item.name}` }
          : item
      )
    )
    try {
      const result = await window.moddeck.toggleMod(
        snapshot.game.id,
        selected,
        original,
        enable,
        exclusive
      )
      if (!result.ok || exclusive) {
        if (!result.ok) setError(result.error || '切换失败')
        setMods(await window.moddeck.getMods(snapshot.game.id, selected))
      }
    } catch (err) {
      setError(errorMessage(err))
      setMods(await window.moddeck.getMods(snapshot.game.id, selected))
    }
  }

  async function setPinnedState(value: boolean) {
    setPinned(value)
    await window.moddeck.setOverlayPinned(value)
  }

  async function changeSelectMode(value: 'single' | 'multi') {
    setSelectMode(value)
    void window.moddeck.saveSettings({ ui: { modSelectMode: value } })
  }

  return (
    <div className="overlay-app">
      <header className="overlay-head">
        <div className="overlay-brand">
          <span className="brand-mark small">M</span>
          <div>
            <strong>ModDeck Quick</strong>
            <span>{snapshot?.game.shortName ?? '未配置游戏'}</span>
          </div>
        </div>
        <div className="overlay-head-actions">
          <button
            className={`icon-btn${pinned ? ' is-active' : ''}`}
            onClick={() => void setPinnedState(!pinned)}
            title={pinned ? '取消置顶' : '固定最顶层'}
          >
            <Icon name={pinned ? 'pin' : 'pinOff'} size={16} />
          </button>
          <button className="icon-btn" onClick={() => window.moddeck.toggleOverlay()} title="隐藏">
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      {error ? <div className="overlay-error">{error}</div> : null}

      <div className="overlay-toolbar">
        <select
          className="select"
          value={selected}
          onChange={(event) => void selectCharacter(event.target.value)}
        >
          {filteredCharacters.length === 0 ? <option value="">没有匹配角色</option> : null}
          {filteredCharacters.map((character) => (
            <option key={character.folder} value={character.folder}>
              {character.displayName} ({character.modCount})
            </option>
          ))}
        </select>
        <select
          className="select compact-select"
          value={filter}
          onChange={(event) => void changeFilter(event.target.value as CharacterFilter)}
          title="角色筛选"
        >
          <option value="all">全部</option>
          <option value="withMods">有 Mod</option>
          <option value="empty">无 Mod</option>
        </select>
        <div className="search compact">
          <Icon name="search" size={15} />
          <input
            className="input"
            placeholder="搜索 Mod"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="overlay-modebar">
        <div className="segmented compact">
          <button
            className={selectMode === 'single' ? 'active' : ''}
            onClick={() => void changeSelectMode('single')}
          >
            单选
          </button>
          <button
            className={selectMode === 'multi' ? 'active' : ''}
            onClick={() => void changeSelectMode('multi')}
          >
            多选
          </button>
        </div>
        <span className="muted small">
          {selectMode === 'single' ? '启用一个会关闭其他' : '可以同时启用多个'}
        </span>
      </div>

      <div className="overlay-list">
        {loading ? (
          <div className="overlay-empty">
            <div className="spinner" />
            <span>加载中…</span>
          </div>
        ) : visibleMods.length === 0 ? (
          <div className="overlay-empty">
            <Icon name="box" size={24} />
            <span>{current ? '这个角色没有匹配的 Mod' : '没有可显示的角色'}</span>
          </div>
        ) : (
          visibleMods.map((mod) => (
            <div
              className={`overlay-mod${mod.enabled ? ' on' : ''}`}
              key={mod.folderName}
              onClick={() => {
                if (!snapshot || !selected) return
                void window.moddeck.showOverlayDetail({
                  gameId: snapshot.game.id,
                  characterFolder: selected,
                  modFolder: mod.folderName
                })
              }}
              title="点击查看热键"
            >
              <div className="overlay-mod-main">
                <div className="overlay-mod-name">{mod.name}</div>
                <div className="overlay-mod-sub">{mod.enabled ? '已启用' : '已禁用'}</div>
              </div>
              <button
                className={`switch${mod.enabled ? ' on' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  void toggle(mod)
                }}
                role="switch"
                aria-checked={mod.enabled}
                aria-label={mod.enabled ? '禁用' : '启用'}
              >
                <span />
              </button>
            </div>
          ))
        )}
      </div>

      <footer className="overlay-foot">
        <span className="muted">
          快捷键 {boot?.settings.ui.overlayHotkey || '未设置'} · Esc 隐藏
        </span>
        <button className="btn ghost small-btn" onClick={() => window.moddeck.overlayOpenManager()}>
          打开管理器
        </button>
      </footer>
    </div>
  )
}
