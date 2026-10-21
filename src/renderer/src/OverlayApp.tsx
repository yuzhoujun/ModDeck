import { useEffect, useMemo, useState } from 'react'
import type { Bootstrap, CharacterInfo, GameSnapshot, ModInfo } from '../../shared/types'
import { Icon } from './components/Icon'
import { errorMessage } from './utils'

export function OverlayApp() {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [mods, setMods] = useState<ModInfo[]>([])
  const [query, setQuery] = useState('')
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
        const characters = data.snapshot?.characters ?? []
        const first = characters.find((character) => character.modCount > 0) ?? characters[0]
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

  async function toggle(mod: ModInfo) {
    if (!snapshot) return
    const enable = !mod.enabled
    const original = mod.folderName
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
        enable
      )
      if (!result.ok) {
        setError(result.error || '切换失败')
        setMods(await window.moddeck.getMods(snapshot.game.id, selected))
      }
    } catch (err) {
      setError(errorMessage(err))
      setMods(await window.moddeck.getMods(snapshot.game.id, selected))
    }
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
          {characters.length === 0 ? <option value="">没有角色</option> : null}
          {characters.map((character) => (
            <option key={character.folder} value={character.folder}>
              {character.displayName} ({character.modCount})
            </option>
          ))}
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
            <div className={`overlay-mod${mod.enabled ? ' on' : ''}`} key={mod.folderName}>
              <div className="overlay-mod-main">
                <div className="overlay-mod-name">{mod.name}</div>
                <div className="overlay-mod-sub">{mod.enabled ? '已启用' : '已禁用'}</div>
              </div>
              <button
                className={`switch${mod.enabled ? ' on' : ''}`}
                onClick={() => void toggle(mod)}
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
