import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Bootstrap,
  CharacterInfo,
  GameId,
  GameSnapshot,
  ModInfo,
  RecentMod,
  RosterPreset
} from '../../shared/types'
import { isUtilityCategory } from '../../shared/types'
import { Icon } from './components/Icon'
import { ScrollTitle } from './components/ScrollTitle'
import { errorMessage } from './utils'
import { useI18n, getLocaleCharacterName } from './i18n'

type CharacterFilter = 'all' | 'withMods' | 'empty' | 'characters' | 'utility'

export function OverlayApp() {
  const { t, effectiveLocale } = useI18n()
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [mods, setMods] = useState<ModInfo[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CharacterFilter>('all')
  const [selectMode, setSelectMode] = useState<'single' | 'multi'>('multi')
  const [recent, setRecent] = useState<RecentMod[]>([])
  const [pinned, setPinned] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rosterPresets, setRosterPresets] = useState<RosterPreset[]>([])
  const [showPresetDrawer, setShowPresetDrawer] = useState(false)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [showBenchmark, setShowBenchmark] = useState(false)
  const [benchmarkStatus, setBenchmarkStatus] = useState<'idle' | 'running' | 'finished'>('idle')
  const [benchmarkElapsed, setBenchmarkElapsed] = useState(0)
  const benchmarkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const benchmarkStartRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (benchmarkTimerRef.current) clearInterval(benchmarkTimerRef.current)
    }
  }, [])


  useEffect(() => {
    if (!snapshot) return
    let active = true
    window.moddeck
      .getRosterPresets(snapshot.game.id)
      .then((res) => {
        if (active) setRosterPresets(res)
      })
      .catch(() => undefined)


  return () => {
      active = false
    }
  }, [snapshot?.game.id])

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
        setRecent(data.settings.recentMods)
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

  useEffect(() => {
    if (loading) return
    let active = true
    const unsubscribe = window.moddeck.onStateChanged(() => {
      void (async () => {
        try {
          const data = await window.moddeck.bootstrap()
          if (!active || !data.snapshot) return
          setBoot(data)
          setSnapshot(data.snapshot)
          setSelectMode(data.settings.ui.modSelectMode)
          setFilter(data.settings.ui.characterFilter)
          setPinned(data.settings.ui.overlayPinned)
          setRecent(data.settings.recentMods)

          const chars = data.snapshot.characters
          const nextFilter = data.settings.ui.characterFilter
          const candidates = chars.filter((character) => {
            if (nextFilter === 'withMods') return character.modCount > 0
            if (nextFilter === 'empty') return character.modCount === 0
            return true
          })
          let targetFolder = selected
          if (!targetFolder || !chars.some((character) => character.folder === targetFolder)) {
            const first = candidates.find((character) => character.modCount > 0) ?? candidates[0]
            targetFolder = first?.folder ?? ''
            setSelected(targetFolder)
          }
          if (targetFolder) {
            const nextMods = await window.moddeck.getMods(data.snapshot.game.id, targetFolder)
            if (active) setMods(nextMods)
          } else {
            setMods([])
          }

          // 关键：实时同步全角色池方案列表
          try {
            const latestPresets = await window.moddeck.getRosterPresets(data.snapshot.game.id)
            if (active) setRosterPresets(latestPresets)
          } catch {
            // ignore
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
  }, [loading, selected])

  const characters: CharacterInfo[] = snapshot?.characters ?? []
  const filteredCharacters = characters.filter((character) => {
    if (filter === 'withMods') return character.modCount > 0
    if (filter === 'empty') return character.modCount === 0
    if (filter === 'characters') return !isUtilityCategory(character)
    if (filter === 'utility') return isUtilityCategory(character)
    return true
  })
  const current = characters.find((character) => character.folder === selected) ?? null
  async function applyPreset(preset: RosterPreset) {
    if (!snapshot) return
    try {
      const res = await window.moddeck.applyRosterPreset(snapshot.game.id, preset.id)
      if (res.ok) {
        setActivePresetId(preset.id)
        if (boot?.settings.ui.autoReloadRosterPreset === false) {
          setPendingCount((c) => Math.max(1, c + 1))
        }
        if (selected) {
          const list = await window.moddeck.getMods(snapshot.game.id, selected)
          setMods(list)
        }
      } else {
        setError(res.error || '切换预设失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const visibleMods = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return mods
    return mods.filter((mod) => mod.name.toLowerCase().includes(value))
  }, [mods, query])
  const recentForGame = recent
    .filter((item) => item.gameId === snapshot?.game.id)
    .slice(0, boot?.settings.ui.recentModCount ?? 8)

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
      if (result.ok) {
        const entry: RecentMod = {
          gameId: snapshot.game.id,
          characterFolder: selected,
          modFolder: enable ? mod.name : original,
          name: mod.name,
          at: Date.now()
        }
        setRecent((current) =>
          [
            entry,
            ...current.filter(
              (item) =>
                !(
                  item.gameId === entry.gameId &&
                  item.characterFolder === entry.characterFolder &&
                  item.name === entry.name
                )
            )
          ].slice(0, boot?.settings.ui.recentModCount ?? 8)
        )
      }
    } catch (err) {
      setError(errorMessage(err))
      setMods(await window.moddeck.getMods(snapshot.game.id, selected))
    }
  }

  async function openRecent(item: RecentMod) {
    if (!snapshot) return
    await selectCharacter(item.characterFolder)
    const list = await window.moddeck.getMods(snapshot.game.id, item.characterFolder)
    const mod = list.find((entry) => entry.name === item.name)
    if (!mod) {
      setError('这个 Mod 已经不在目录里')
      return
    }
    void window.moddeck.showOverlayDetail({
      gameId: snapshot.game.id,
      characterFolder: item.characterFolder,
      modFolder: mod.folderName
    })
  }

  async function changeGame(gameId: GameId) {
    if (!snapshot || gameId === snapshot.game.id) return
    setLoading(true)
    setError(null)
    try {
      const next = await window.moddeck.switchGame(gameId)
      if (!next) {
        setError('无法切换到这个游戏')
        return
      }
      setSnapshot(next)
      setBoot((current) =>
        current
          ? { ...current, settings: { ...current.settings, activeGameId: gameId } }
          : current
      )
      setSelected('')
      setMods([])
      const candidates = next.characters.filter((character) => {
        if (filter === 'withMods') return character.modCount > 0
        if (filter === 'empty') return character.modCount === 0
        return true
      })
      const first = candidates.find((character) => character.modCount > 0) ?? candidates[0]
      if (first) {
        setSelected(first.folder)
        setMods(await window.moddeck.getMods(gameId, first.folder))
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
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
            <select
              className="overlay-game-select"
              value={snapshot?.game.id ?? ''}
              onChange={(event) => void changeGame(event.target.value as GameId)}
              title="切换当前游戏"
            >
              {!snapshot ? <option value="">未配置游戏</option> : null}
              {boot?.games.map((game) => (
                <option key={game.id} value={game.id}>
                  {game.shortName} · {game.loader}
                </option>
              ))}
            </select>
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
              {getLocaleCharacterName(character, effectiveLocale)} ({character.modCount})
            </option>
          ))}
        </select>
        <select
          className="select compact-select"
          value={filter}
          onChange={(event) => void changeFilter(event.target.value as CharacterFilter)}
          title="分类筛选"
        >
          <option value="all">{t('overlay.filterAll')}</option>
          <option value="characters">{t('overlay.filterCharacters')}</option>
          <option value="utility">{t('overlay.filterUtility')}</option>
          <option value="withMods">{t('overlay.filterWithMods')}</option>
          <option value="empty">{t('overlay.filterEmpty')}</option>
        </select>
        <div className="search compact">
          <Icon name="search" size={15} />
          <input
            className="input"
            placeholder={t('overlay.searchPlaceholder')}
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
            {t('preset.single')}
          </button>
          <button
            className={selectMode === 'multi' ? 'active' : ''}
            onClick={() => void changeSelectMode('multi')}
          >
            {t('preset.multi')}
          </button>
        </div>
      </div>

      {recentForGame.length > 0 ? (
        <div className="overlay-recent">
          <span className="muted small">{t('overlay.recent')}</span>
          <div className="overlay-recent-list">
            {recentForGame.map((item) => (
              <button
                key={`${item.characterFolder}:${item.modFolder}`}
                className="recent-chip"
                onClick={() => void openRecent(item)}
                title={`${item.characterFolder} / ${item.name}`}
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="overlay-list">
        {loading ? (
          <div className="overlay-empty">
            <div className="spinner" />
            <span>{t('common.loading')}</span>
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
                <ScrollTitle text={mod.name} className="overlay-mod-name" />
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

      {showPresetDrawer ? (
        <div className="overlay-preset-drawer">
          <div className="overlay-preset-head">
            <strong>选择全角色预设方案</strong>
            <button className="icon-btn" onClick={() => setShowPresetDrawer(false)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="overlay-preset-list">
            {rosterPresets.length === 0 ? (
              <div className="muted small" style={{ padding: '8px 12px' }}>
                暂无预设方案，请在管理器主界面新建。
              </div>
            ) : (
              rosterPresets.map((p) => {
                const isActive = activePresetId === p.id
                return (
                  <button
                    key={p.id}
                    className={`overlay-preset-item${isActive ? ' is-active' : ''}`}
                    onClick={() => void applyPreset(p)}
                  >
                    <span className="preset-dot" />
                    <span className="overlay-preset-name">{p.name}</span>
                    <span className="muted small">
                      {Object.keys(p.assignments).length} 角色 · {Object.values(p.assignments).reduce((acc, a) => acc + (a?.mods?.length ? a.mods.length : (a?.modName ? 1 : 0)), 0)} Mod
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}

      {showBenchmark ? (
        <div className="overlay-preset-drawer" style={{ maxHeight: '280px' }}>
          <div className="overlay-preset-head">
            <strong>⏱️ 浮动实机重载测速校准</strong>
            <button className="icon-btn" onClick={() => setShowBenchmark(false)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {benchmarkStatus === 'idle' ? (
              <>
                <div className="muted small" style={{ lineHeight: 1.5 }}>
                  浮于游戏窗口之上直接测量，<strong>杜绝 Alt+Tab 切屏反应误差</strong>！
                </div>
                <div style={{ fontSize: '12px', background: 'rgba(255,255,255,0.04)', padding: '8px 10px', borderRadius: '4px' }}>
                  点击下方「开始测速」，ModDeck 将向游戏发送 F10。请直接观察下方游戏画面，当重载卡顿结束、画面恢复流畅时，立即点击「停止计时」！
                </div>
                <button
                  className="btn primary small-btn"
                  style={{ alignSelf: 'flex-end', marginTop: '4px' }}
                  onClick={async () => {
                    setBenchmarkStatus('running')
                    setBenchmarkElapsed(0)
                    benchmarkStartRef.current = Date.now()
                    benchmarkTimerRef.current = setInterval(() => {
                      setBenchmarkElapsed((Date.now() - benchmarkStartRef.current) / 1000)
                    }, 50)
                    try {
                      await window.moddeck.reloadF10()
                    } catch {
                      // ignore
                    }
                  }}
                >
                  开始测速 (触发 F10)
                </button>
              </>
            ) : benchmarkStatus === 'running' ? (
              <div style={{ textAlign: 'center', padding: '10px 0' }}>
                <div className="muted small" style={{ marginBottom: '6px' }}>
                  已向游戏发送 F10，正在重载计时...
                </div>
                <div style={{ fontSize: '36px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--accent, #6366f1)' }}>
                  {benchmarkElapsed.toFixed(1)}s
                </div>
                <button
                  className="btn primary"
                  style={{ width: '100%', height: '36px', marginTop: '10px', fontWeight: 600 }}
                  onClick={() => {
                    if (benchmarkTimerRef.current) clearInterval(benchmarkTimerRef.current)
                    benchmarkTimerRef.current = null
                    const duration = Math.max(0.1, (Date.now() - benchmarkStartRef.current) / 1000)
                    setBenchmarkElapsed(duration)
                    setBenchmarkStatus('finished')
                  }}
                >
                  ⏱️ 画面已恢复流畅，停止计时
                </button>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '6px 0' }}>
                <div className="muted small">实测游戏重载耗时</div>
                <div style={{ fontSize: '26px', fontWeight: 700, fontFamily: 'monospace', margin: '4px 0' }}>
                  {benchmarkElapsed.toFixed(2)} 秒
                </div>
                <div style={{ fontSize: '13px', margin: '8px 0', padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                  推荐缓冲延迟：<strong style={{ color: 'var(--accent, #6366f1)' }}>{Math.min(25, Math.max(2, Math.round((benchmarkElapsed + 1.5) * 2) / 2))} 秒</strong>
                  <span className="muted small" style={{ display: 'block', marginTop: '2px' }}>
                    （实测耗时 + 1.5s 安全余量）
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' }}>
                  <button
                    className="btn ghost small-btn"
                    onClick={() => {
                      setBenchmarkStatus('idle')
                      setBenchmarkElapsed(0)
                    }}
                  >
                    重新测速
                  </button>
                  <button
                    className="btn primary small-btn"
                    onClick={async () => {
                      const rec = Math.min(25, Math.max(2, Math.round((benchmarkElapsed + 1.5) * 2) / 2))
                      await window.moddeck.saveSettings({ ui: { postReloadSyncDelay: rec } })
                      setShowBenchmark(false)
                    }}
                  >
                    应用推荐值 ({Math.min(25, Math.max(2, Math.round((benchmarkElapsed + 1.5) * 2) / 2))}s)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
      <footer className="overlay-foot">
        <span className="muted">
          快捷键 {boot?.settings.ui.overlayHotkey || '未设置'} · Esc 隐藏
        </span>
        <div className="overlay-foot-actions">
          <button
            className={`btn ghost small-btn${showPresetDrawer ? ' active' : ''}`}
            onClick={() => {
              setShowPresetDrawer(!showPresetDrawer)
              if (!showPresetDrawer && snapshot) {
                window.moddeck.getRosterPresets(snapshot.game.id).then(setRosterPresets).catch(() => undefined)
              }
              setShowBenchmark(false)
            }}
            title="一键切换全角色池方案"
          >
            {t('overlay.schemesBtn', { count: rosterPresets.length })}
          </button>
          <button
            className={`btn ghost small-btn${showBenchmark ? ' active' : ''}`}
            onClick={() => {
              setShowBenchmark(!showBenchmark)
              setBenchmarkStatus('idle')
              setBenchmarkElapsed(0)
              setShowPresetDrawer(false)
            }}
            title="浮动实机测速：无需切屏，直接观察游戏重载并精确校准缓冲延迟"
          >
            {t('overlay.benchmarkBtn')}
          </button>
          <button
            className={`btn ghost small-btn${pendingCount > 0 ? ' btn-pending-pulse' : ''}`}
            onClick={() => {
              void (async () => {
                const result = await window.moddeck.reloadF10()
                if (!result.ok) setError(result.error || '重载失败')
                else setPendingCount(0)
              })()
            }}
            title={pendingCount > 0 ? `有 ${pendingCount} 个预设待生效，点击发送 ${boot?.settings.ui.reloadHotkey || 'F10'} 立即刷新实机画面` : `发送 ${boot?.settings.ui.reloadHotkey || 'F10'} 重载 EFMI 配置`}
          >
            {pendingCount > 0 ? t('overlay.applyNowBtn', { count: pendingCount }) : t('overlay.reloadBtn', { hotkey: boot?.settings.ui.reloadHotkey || 'F10' })}
          </button>
          <button
            className="btn ghost small-btn"
            onClick={() => window.moddeck.overlayOpenManager()}
          >
            {t('overlay.openManagerBtn')}
          </button>
        </div>
      </footer>
    </div>
  )
}
