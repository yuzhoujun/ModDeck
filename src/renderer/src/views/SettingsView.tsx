import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type {
  AppInfo,
  EnvironmentCheck,
  GameDef,
  RosterSyncStatus,
  Settings,
  SettingsPatch
} from '../../../shared/types'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import type { IconName } from '../components/Icon'
import { errorMessage } from '../utils'

type SettingsTab = 'general' | 'games' | 'environment' | 'import' | 'about'

export function SettingsView({
  games,
  settings,
  initialTab = 'general',
  onSave,
  onNotify
}: {
  games: GameDef[]
  settings: Settings
  initialTab?: SettingsTab
  onSave: (patch: SettingsPatch) => Promise<void>
  onNotify: (text: string, kind?: 'ok' | 'err' | 'info') => void
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [draft, setDraft] = useState<Settings>(settings)
  const [hotkeyDraft, setHotkeyDraft] = useState(settings.ui.overlayHotkey)
  const [reloadHotkeyDraft, setReloadHotkeyDraft] = useState(settings.ui.reloadHotkey || 'F10')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [hotkeyMessage, setHotkeyMessage] = useState<string | null>(null)
  const [reloadHotkeyMessage, setReloadHotkeyMessage] = useState<string | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [envResults, setEnvResults] = useState<EnvironmentCheck[]>([])
  const [envChecking, setEnvChecking] = useState(false)
  const [rosterStatus, setRosterStatus] = useState<RosterSyncStatus | null>(null)
  const [d3dxAutoSaveInterval, setD3dxAutoSaveInterval] = useState<number>(60)

  useEffect(() => {
    const targetGameId = draft.activeGameId || settings.activeGameId
    if (targetGameId) {
      window.moddeck.getD3dxAutoSaveInterval(targetGameId).then(setD3dxAutoSaveInterval).catch(() => undefined)
    }
  }, [draft.activeGameId, settings.activeGameId])

  const [rosterSyncing, setRosterSyncing] = useState(false)
  const [showF10WarningModal, setShowF10WarningModal] = useState(false)
  const [showDisablePresetReloadModal, setShowDisablePresetReloadModal] = useState<"modPreset" | "rosterPreset" | null>(null)

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedBadgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showBenchmarkModal, setShowBenchmarkModal] = useState(false)
  const [benchmarkStatus, setBenchmarkStatus] = useState<'idle' | 'running' | 'finished'>('idle')
  const [benchmarkElapsed, setBenchmarkElapsed] = useState(0)
  const benchmarkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const benchmarkStartRef = useRef<number>(0)

  useEffect(() => {
    setDraft(settings)
    setHotkeyDraft(settings.ui.overlayHotkey)
    setReloadHotkeyDraft(settings.ui.reloadHotkey || 'F10')
  }, [settings])

  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    window.moddeck
      .appInfo()
      .then(setInfo)
      .catch(() => undefined)
    window.moddeck
      .getRosterStatus()
      .then(setRosterStatus)
      .catch(() => undefined)
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      if (savedBadgeTimerRef.current) clearTimeout(savedBadgeTimerRef.current)
    }
  }, [])

  async function persistPatch(patch: SettingsPatch, debounced = false) {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    const execute = async () => {
      setSaveStatus('saving')
      try {
        await onSave(patch)
        setSaveStatus('saved')
        if (savedBadgeTimerRef.current) clearTimeout(savedBadgeTimerRef.current)
        savedBadgeTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2400)
      } catch (error) {
        setSaveStatus('idle')
        onNotify(errorMessage(error), 'err')
      }
    }

    if (debounced) {
      setSaveStatus('saving')
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        void execute()
      }, 400)
    } else {
      await execute()
    }
  }

  async function handleSyncRoster() {
    setRosterSyncing(true)
    try {
      const res = await window.moddeck.syncRemoteRoster(draft.import.rosterRemoteUrl)
      if (res.ok) {
        if (res.status) setRosterStatus(res.status)
        onNotify(`角色词库已合并更新（共处理 ${res.addedOrUpdated ?? 0} 条云端记录）`)
      } else {
        onNotify(res.error || '同步角色词库失败', 'err')
      }
    } catch (error) {
      onNotify(errorMessage(error), 'err')
    } finally {
      setRosterSyncing(false)
    }
  }

  async function refreshEnvironment() {
    setEnvChecking(true)
    try {
      setEnvResults(await window.moddeck.checkEnvironment())
    } catch {
      setEnvResults([])
    } finally {
      setEnvChecking(false)
    }
  }

  useEffect(() => {
    if (settings.ui.envCheckEnabled) void refreshEnvironment()
  }, [settings.ui.envCheckEnabled])

  function updateUi(patch: Partial<Settings['ui']>, debounced = false) {
    setDraft((current) => ({ ...current, ui: { ...current.ui, ...patch } }))
    void persistPatch({ ui: patch }, debounced)
  }

  function updateImport(patch: Partial<Settings['import']>, debounced = false) {
    setDraft((current) => ({ ...current, import: { ...current.import, ...patch } }))
    void persistPatch({ import: patch }, debounced)
  }

  function shortPath(value: string): string {
    const parts = value.split(/[\\/]/).filter(Boolean)
    return parts.length <= 2 ? value : `.../${parts.slice(-2).join('/')}`
  }

  function envStatusText(status: EnvironmentCheck['status'] | undefined): string {
    if (status === 'ok') return '规则存在，DISABLED_ 会生效'
    if (status === 'missing-line') return '缺少 exclude_recursive = DISABLED*'
    if (status === 'missing-file') return '找不到 EFMI 根目录的 d3dx.ini'
    if (status === 'no-root') return '还没有配置 EFMI 目录'
    return '尚未检测'
  }

  function updateGame(
    gameId: string,
    patch: Partial<Settings['games'][string]>,
    debounced = false
  ) {
    setDraft((current) => {
      const nextGame = { ...current.games[gameId], ...patch }
      void persistPatch({ games: { [gameId]: nextGame } }, debounced)
      return {
        ...current,
        games: {
          ...current.games,
          [gameId]: nextGame
        }
      }
    })
  }

  async function pickInto(
    gameId: string,
    field: 'modsPath' | 'gamePath' | 'loaderPath',
    picker: () => Promise<string | null>
  ) {
    const picked = await picker()
    if (picked) updateGame(gameId, { [field]: picked }, false)
  }

  function formatCapturedKey(event: KeyboardEvent<HTMLInputElement>): string | null {
    event.preventDefault()
    if (event.key === 'Escape') return null
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null

    const parts: string[] = []
    if (event.ctrlKey) parts.push('Control')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    if (event.metaKey) parts.push('Super')

    let key = event.key
    if (key === ' ') key = 'Space'
    else if (key.length === 1) key = key.toUpperCase()
    parts.push(key)
    return parts.join('+')
  }

  function captureHotkey(event: KeyboardEvent<HTMLInputElement>) {
    const combo = formatCapturedKey(event)
    if (!combo) return
    setHotkeyDraft(combo)
    void applyHotkey(combo)
  }

  async function applyHotkey(value: string) {
    setHotkeyMessage(null)
    try {
      const result = await window.moddeck.setOverlayHotkey(value)
      if (!result.ok) {
        setHotkeyMessage(result.error || '快捷键保存失败')
        return
      }
      const nextVal = result.hotkey ?? value
      setHotkeyDraft(nextVal)
      await persistPatch({ ui: { overlayHotkey: nextVal } }, false)
      setHotkeyMessage(nextVal ? `已自动保存：${nextVal}` : '已禁用快捷窗口快捷键')
    } catch (error) {
      setHotkeyMessage(errorMessage(error))
    }
  }

  function captureReloadHotkey(event: KeyboardEvent<HTMLInputElement>) {
    const combo = formatCapturedKey(event)
    if (!combo) return
    setReloadHotkeyDraft(combo)
    void applyReloadHotkey(combo)
  }

  async function applyReloadHotkey(value: string) {
    setReloadHotkeyMessage(null)
    try {
      const result = await window.moddeck.setReloadHotkey(value)
      if (!result.ok) {
        setReloadHotkeyMessage(result.error || '重载快捷键保存失败')
        return
      }
      const nextVal = result.hotkey ?? (value || 'F10')
      setReloadHotkeyDraft(nextVal)
      setDraft((current) => ({ ...current, ui: { ...current.ui, reloadHotkey: nextVal } }))
      setReloadHotkeyMessage(`已自动保存：${nextVal}`)
      setSaveStatus('saved')
      if (savedBadgeTimerRef.current) clearTimeout(savedBadgeTimerRef.current)
      savedBadgeTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2400)
    } catch (error) {
      setReloadHotkeyMessage(errorMessage(error))
    }
  }

  const tabs: Array<{ id: SettingsTab; label: string; icon: IconName }> = [
    { id: 'general', label: '通用', icon: 'settings' },
    { id: 'games', label: '配置', icon: 'folder' },
    { id: 'environment', label: '环境', icon: 'box' },
    { id: 'import', label: '导入', icon: 'download' },
    { id: 'about', label: '关于', icon: 'info' }
  ]

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <div className="eyebrow">首选项</div>
          <h1>设置</h1>
          <p className="muted">通用行为、游戏路径、环境检测与导入设置。所有改动实时自动保存在本机。</p>
        </div>
        <div className="actions">
          <div className={`settings-saved-pill ${saveStatus}`}>
            <span className="status-dot-pulse" />
            <span>
              {saveStatus === 'saving'
                ? '正在保存…'
                : saveStatus === 'saved'
                  ? '已自动保存'
                  : '修改实时自动保存'}
            </span>
          </div>
        </div>
      </header>

      <div className="settings-tabs">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={`settings-tab${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={16} />
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'general' ? (
        <>
          <section className="settings-card">
            <div className="settings-card-head">
              <div className="settings-card-icon">
                <Icon name="settings" size={18} />
              </div>
              <div>
                <h3>快捷窗口 (Quick Overlay)</h3>
                <p className="muted">
                  在游戏内使用浮动快捷窗口随时开关 Mod 与切换预设。点击输入框后直接按下组合键即可保存。
                </p>
              </div>
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header">
                <span className="setting-group-title">呼出快捷键</span>
                <span className="muted small">
                  当前：{settings.ui.overlayHotkey || '未设置'} · 按 Esc 隐藏快捷窗口
                </span>
              </div>
              <div className="hotkey-row">
                <input
                  className="input hotkey-input"
                  value={hotkeyDraft}
                  placeholder="点击后按下组合键，例如 Alt+Shift+M"
                  readOnly
                  onKeyDown={captureHotkey}
                  onFocus={(event) => event.target.select()}
                />
                <button className="btn ghost" onClick={() => void applyHotkey('Alt+Shift+M')}>
                  恢复默认
                </button>
                <button className="btn ghost" onClick={() => void applyHotkey('')}>
                  禁用
                </button>
                <button className="btn ghost" onClick={() => window.moddeck.toggleOverlay()}>
                  测试呼出
                </button>
              </div>
              {hotkeyMessage ? <div className="hint" style={{ marginTop: '8px' }}>{hotkeyMessage}</div> : null}
            </div>

            <div className="setting-group-box">
              <label className="check-row-card">
                <input
                  type="checkbox"
                  checked={draft.ui.allowHotkeySend}
                  onChange={(event) => updateUi({ allowHotkeySend: event.target.checked })}
                />
                <div>
                  <div style={{ fontWeight: 600, color: '#f1f5f9' }}>允许点击热键发送到游戏</div>
                  <div className="muted small" style={{ marginTop: '2px' }}>
                    在快捷窗口内点击 Mod 变体热键胶囊时，自动向处于前台的游戏窗口发送物理按键信号。
                  </div>
                </div>
              </label>
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header">
                <span className="setting-group-title">快捷窗口最近使用 Mod 栏展示数量</span>
                <span className="setting-val-badge">{draft.ui.recentModCount} 个</span>
              </div>
              <div className="setting-range-container">
                <input
                  type="range"
                  className="setting-range"
                  min="0"
                  max="15"
                  step="1"
                  value={draft.ui.recentModCount}
                  onChange={(event) => updateUi({ recentModCount: Number(event.target.value) }, true)}
                />
              </div>
              <div className="setting-group-desc">
                在游戏内浮动快捷窗口顶部展示的最近操作 Mod 快捷胶囊数量（设为 0 则在快捷窗口中完全隐藏最近使用栏）。
              </div>
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-head">
              <div
                className="settings-card-icon"
                style={{
                  background: 'rgba(56, 189, 248, 0.12)',
                  color: '#38bdf8',
                  borderColor: 'rgba(56, 189, 248, 0.25)'
                }}
              >
                <Icon name="refresh" size={18} />
              </div>
              <div>
                <h3>游戏刷新与快捷行为</h3>
                <p className="muted">控制 3DMigoto 游戏重载热键、预设自动换装策略及刷盘同步延迟。</p>
              </div>
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header">
                <span className="setting-group-title">3DMigoto 游戏重载快捷键</span>
                <span className="muted small">默认 F10，点击输入框后按键即可修改</span>
              </div>
              <div className="hotkey-row">
                <input
                  className="input hotkey-input"
                  value={reloadHotkeyDraft}
                  placeholder="默认 F10"
                  readOnly
                  onKeyDown={captureReloadHotkey}
                  onFocus={(event) => event.target.select()}
                />
                <button className="btn ghost" onClick={() => void applyReloadHotkey('F10')}>
                  恢复默认 (F10)
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    void window.moddeck.reloadF10()
                  }}
                >
                  测试发送
                </button>
              </div>
              {reloadHotkeyMessage ? <div className="hint" style={{ marginTop: '8px' }}>{reloadHotkeyMessage}</div> : null}
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header" style={{ marginBottom: '10px' }}>
                <span className="setting-group-title">自动重载与换装生效策略</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label className="check-row-card">
                  <input
                    type="checkbox"
                    checked={draft.ui.autoReloadModToggle === true}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setShowF10WarningModal(true)
                      } else {
                        updateUi({ autoReloadModToggle: false, autoReloadF10: false })
                      }
                    }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: '#f1f5f9' }}>切换普通 Mod 启停后自动重载</div>
                    <div className="muted small" style={{ marginTop: '2px' }}>
                      默认关闭。避免在 Mod 库批量启用/禁用 Mod 时导致游戏画面频繁停顿卡顿。
                    </div>
                  </div>
                </label>

                <label className="check-row-card">
                  <input
                    type="checkbox"
                    checked={draft.ui.autoReloadModPreset !== false}
                    onChange={(event) => {
                      if (!event.target.checked) {
                        setShowDisablePresetReloadModal('modPreset')
                      } else {
                        updateUi({ autoReloadModPreset: true })
                      }
                    }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: '#f1f5f9' }}>
                      切换单 Mod 变体预设后自动重载 <span className="tag ok" style={{ marginLeft: '6px' }}>推荐常开</span>
                    </div>
                    <div className="muted small" style={{ marginTop: '2px' }}>
                      在主界面或快捷窗口点击单个 Mod 预设时，自动向游戏发送重载，即刻换装生效。
                    </div>
                  </div>
                </label>

                <label className="check-row-card">
                  <input
                    type="checkbox"
                    checked={draft.ui.autoReloadRosterPreset !== false}
                    onChange={(event) => {
                      if (!event.target.checked) {
                        setShowDisablePresetReloadModal('rosterPreset')
                      } else {
                        updateUi({ autoReloadRosterPreset: true })
                      }
                    }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: '#f1f5f9' }}>
                      切换全角色池方案后自动重载 <span className="tag ok" style={{ marginLeft: '6px' }}>推荐常开</span>
                    </div>
                    <div className="muted small" style={{ marginTop: '2px' }}>
                      在快捷窗口或主界面切换全局角色池方案时，自动向游戏发送重载，一键全队阵容换装。
                    </div>
                  </div>
                </label>
              </div>

              {(draft.ui.autoReloadModPreset === false || draft.ui.autoReloadRosterPreset === false) && (
                <div
                  className="alert-box warning"
                  style={{
                    marginTop: '12px',
                    padding: '12px 16px',
                    borderRadius: '10px',
                    background: 'rgba(234, 179, 8, 0.08)',
                    border: '1px solid rgba(234, 179, 8, 0.28)',
                    color: '#facc15',
                    fontSize: '12.5px',
                    lineHeight: '1.6'
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                    <Icon name="info" size={15} />
                    <span>⚠️ 手动重载模式生效特别提醒</span>
                  </div>
                  <div>
                    您已关闭部分预设自动重载。挑选预设后，造型变量已预写入集中桥接文件，但<strong>实机画面仍需一次重载才能呈现</strong>。
                  </div>
                  <div style={{ marginTop: '6px' }}>
                    • <strong>推荐重载生效方式</strong>：在游戏内按快捷键（默认 <code>{draft.ui.overlayHotkey || 'Alt+Shift+M'}</code>）呼出浮动快捷窗口，点击底部的 <strong>「重载 F10 / 立即生效」</strong> 按钮（当有待生效预设排队时会显示为高亮脉冲 <strong>「● 立即生效 (N)」</strong>，平时显示为 <strong>「重载 F10」</strong>）。ModDeck 将启动安全缓冲同步，自动清空排队指示灯并保全冷启动数据。
                  </div>
                  <div style={{ marginTop: '6px' }}>
                    • <strong>物理键盘 F10 说明</strong>：若您在游戏内直接按键盘物理 <code>F10</code>，游戏画面会<strong>立即变身换装生效</strong>（集中桥接配置已被 3DMigoto 读取），但 ModDeck UI 状态由于 Windows 进程隔离无法自动截获键盘按键并转绿。建议您随时呼出快捷窗口点击生效，让指示灯与磁盘完全同步闭环。
                  </div>
                </div>
              )}
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="setting-group-title">3DMigoto 运行时变量自动刷盘间隔</span>
                  <span className="tag warning">需 F10 重载生效</span>
                </div>
                <span className="muted small">
                  实机 ini: {d3dxAutoSaveInterval === -1 ? '已禁用定时' : `${d3dxAutoSaveInterval}s`}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                <select
                  className="select"
                  style={{ flex: 1 }}
                  value={d3dxAutoSaveInterval}
                  onChange={async (e) => {
                    const val = Number(e.target.value)
                    setD3dxAutoSaveInterval(val)
                    const gId = draft.activeGameId || settings.activeGameId
                    if (gId) {
                      setSaveStatus('saving')
                      try {
                        const res = await window.moddeck.setD3dxAutoSaveInterval(gId, val)
                        if (res.ok) {
                          setSaveStatus('saved')
                          if (savedBadgeTimerRef.current) clearTimeout(savedBadgeTimerRef.current)
                          savedBadgeTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
                        } else {
                          setSaveStatus('idle')
                          onNotify(res.error || '保存 d3dx.ini 失败', 'err')
                        }
                      } catch (err) {
                        setSaveStatus('idle')
                        onNotify(String(err), 'err')
                      }
                    }
                  }}
                >
                  <option value={10}>10 秒（极速同步，推荐实机热键调造型时使用）</option>
                  <option value={30}>30 秒（均衡）</option>
                  <option value={60}>60 秒（3DMigoto 官方出厂默认）</option>
                  <option value={-1}>-1（禁用定时刷盘，仅在游戏退出或按 F10 时保存）</option>
                </select>
                <button
                  type="button"
                  className="btn ghost small-btn"
                  onClick={() => {
                    void window.moddeck.reloadF10()
                    onNotify('已向游戏发送 F10 重载，使 3DMigoto 读取新的刷盘周期')
                  }}
                  title="若游戏运行中修改，可点击向游戏发送重载，立即应用新刷盘周期"
                >
                  <Icon name="refresh" size={13} />
                  <span>立即 F10 生效</span>
                </button>
              </div>
              <div className="setting-group-desc">
                💡 控制 3DMigoto 在游戏后台自动将内存中的外观持久化变量刷入 <code>d3dx_user.ini</code> 的周期。数值越小，ModDeck 感知游戏内热键变化越灵敏。修改后会直接写回 <code>d3dx.ini</code>。若游戏正在运行中，需按 F10 重载一次以使 3DMigoto 读取并应用新周期；下次启动游戏亦会自动生效。
              </div>
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="setting-group-title">3DMigoto 重载缓冲同步延迟</span>
                  <span className="tag ok">纯热生效 · 无需重载</span>
                </div>
                <span className="muted small">当前: {draft.ui.postReloadSyncDelay ?? 6}s</span>
              </div>
              <div className="setting-range-container">
                <input
                  type="range"
                  className="setting-range"
                  min="2"
                  max="25"
                  step="0.5"
                  value={draft.ui.postReloadSyncDelay ?? 6}
                  onChange={(e) => updateUi({ postReloadSyncDelay: Number(e.target.value) }, true)}
                />
                <span className="setting-val-badge">{draft.ui.postReloadSyncDelay ?? 6}s</span>
                <button
                  type="button"
                  className="btn ghost small-btn"
                  onClick={() => {
                    setBenchmarkStatus('idle')
                    setBenchmarkElapsed(0)
                    setShowBenchmarkModal(true)
                  }}
                  title="在游戏运行中实测重载耗时并自动设置最适延迟"
                >
                  <Icon name="refresh" size={13} />
                  <span>测速校准</span>
                </button>
              </div>
              <div className="setting-group-desc">
                💡 该参数为 ModDeck 内部的异步等待定时器，纯内存热生效，修改后无需按 F10 或重启游戏，下一次重载立刻按照新设时长计时。F10 重载后 ModDeck 等待游戏编译 Shader 及跨入渲染帧的缓冲时间（之后自动补写持久化配置并清除桥接）。Mod 库较大（10s+）请适度调大；亦可点击「测速校准」自动测量。
              </div>
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-head">
              <div
                className="settings-card-icon"
                style={{
                  background: 'rgba(168, 85, 247, 0.12)',
                  color: '#c084fc',
                  borderColor: 'rgba(168, 85, 247, 0.25)'
                }}
              >
                <Icon name="close" size={18} />
              </div>
              <div>
                <h3>关闭行为</h3>
                <p className="muted">最小化后 ModDeck 会留在托盘，全局快捷键和快捷窗口继续可用。</p>
              </div>
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header">
                <span className="setting-group-title">关闭主窗口时</span>
                <span className="muted small">
                  {draft.ui.closeBehavior === 'minimize'
                    ? '托盘菜单可打开管理器或退出'
                    : '关闭主窗口会直接结束进程'}
                </span>
              </div>
              <select
                className="select"
                value={draft.ui.closeBehavior}
                onChange={(event) =>
                  updateUi({
                    closeBehavior: event.target.value === 'minimize' ? 'minimize' : 'quit'
                  })
                }
              >
                <option value="quit">直接退出 ModDeck</option>
                <option value="minimize">最小化到系统托盘（推荐）</option>
              </select>
            </div>
          </section>
        </>
      ) : null}

      {tab === 'games' ? (
        <section className="settings-card">
          <div className="settings-card-head">
            <div className="settings-card-icon" style={{ background: 'rgba(52, 211, 153, 0.12)', color: '#34d399', borderColor: 'rgba(52, 211, 153, 0.25)' }}>
              <Icon name="folder" size={18} />
            </div>
            <div>
              <h3>游戏与目录路径</h3>
              <p className="muted">
                只需要指向 Mods 目录；游戏程序和启动器用于顶部的“启动游戏 / 启动 XXMI”按钮。
              </p>
            </div>
          </div>
          <div className="game-settings">
            {games.map((game) => {
              const value = draft.games[game.id]
              return (
                <div className="game-setting" key={game.id}>
                  <div className="game-setting-head">
                    <span className="dot" style={{ background: game.accent }} />
                    <strong>{game.name}</strong>
                    <span className="muted">{game.loader}</span>
                  </div>

                  <label className="field">
                    <span>{game.loader} 根目录或 Mods 目录</span>
                    <div className="field-row">
                      <input
                        className="input"
                        value={value?.modsPath ?? ''}
                        placeholder={`例如 D:/Games/XXMI/${game.loader} 或 D:/Games/XXMI/${game.loader}/Mods`}
                        onChange={(event) =>
                          updateGame(game.id, { modsPath: event.target.value }, true)
                        }
                      />
                      <button
                        className="icon-btn"
                        title="选择目录"
                        onClick={() =>
                          pickInto(game.id, 'modsPath', () => window.moddeck.pickModsFolder())
                        }
                      >
                        <Icon name="folder" size={17} />
                      </button>
                    </div>
                  </label>

                  <label className="field">
                    <span>游戏程序（可选）</span>
                    <div className="field-row">
                      <input
                        className="input"
                        value={value?.gamePath ?? ''}
                        placeholder={game.exeHint}
                        onChange={(event) =>
                          updateGame(game.id, { gamePath: event.target.value }, true)
                        }
                      />
                      <button
                        className="icon-btn"
                        title="选择游戏程序"
                        onClick={() =>
                          pickInto(game.id, 'gamePath', () => window.moddeck.pickGameExe())
                        }
                      >
                        <Icon name="folder" size={17} />
                      </button>
                    </div>
                  </label>

                  <label className="field">
                    <span>启动器（可选）</span>
                    <div className="field-row">
                      <input
                        className="input"
                        value={value?.loaderPath ?? ''}
                        placeholder="XXMI Launcher.exe"
                        onChange={(event) =>
                          updateGame(game.id, { loaderPath: event.target.value }, true)
                        }
                      />
                      <button
                        className="icon-btn"
                        title="选择启动器"
                        onClick={() =>
                          pickInto(game.id, 'loaderPath', () => window.moddeck.pickLoader())
                        }
                      >
                        <Icon name="folder" size={17} />
                      </button>
                    </div>
                  </label>

                  <label className="field">
                    <span>启动参数（可选）</span>
                    <input
                      className="input"
                      value={value?.launchArgs ?? ''}
                      placeholder="例如 -dx11"
                      onChange={(event) =>
                        updateGame(game.id, { launchArgs: event.target.value }, true)
                      }
                    />
                  </label>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {tab === 'environment' ? (
        <section className="settings-card">
          <div className="settings-card-head">
            <div className="settings-card-icon" style={{ background: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8', borderColor: 'rgba(56, 189, 248, 0.25)' }}>
              <Icon name="box" size={18} />
            </div>
            <div>
              <h3>MI 运行环境检查</h3>
              <p className="muted">
                当前只接入 EFMI 的环境检查。其他 MI 的配置位置已保留，后续版本补充。
              </p>
            </div>
          </div>

          <label className="check-row-card" style={{ marginBottom: '14px' }}>
            <input
              type="checkbox"
              checked={draft.ui.envCheckEnabled}
              onChange={(event) => {
                updateUi({ envCheckEnabled: event.target.checked })
                if (event.target.checked) void refreshEnvironment()
              }}
            />
            <div>
              <div style={{ fontWeight: 600, color: '#f1f5f9' }}>启动时检查 DISABLED 规则（默认开启）</div>
              <div className="muted small" style={{ marginTop: '2px' }}>
                自动校验 d3dx.ini 中是否已包含 exclude_recursive = DISABLED* 规则。
              </div>
            </div>
          </label>
          <div className="row" style={{ marginBottom: '14px' }}>
            <button
              className="btn ghost small-btn"
              onClick={() => void refreshEnvironment()}
              disabled={envChecking}
            >
              <Icon name="refresh" size={14} />
              {envChecking ? '检测中…' : '重新检测全部'}
            </button>
            {draft.ui.envCheckNeverPrompt ? (
              <button
                className="btn ghost small-btn"
                onClick={() => updateUi({ envCheckNeverPrompt: false })}
              >
                恢复启动提示
              </button>
            ) : null}
          </div>

          <div className="env-game-list">
            {games.map((game) => {
              const supported = game.id === 'endfield'
              const env = envResults.find((item) => item.gameId === game.id)
              return (
                <div className={`env-game-card${supported ? '' : ' pending'}`} key={game.id}>
                  <div className="env-game-head">
                    <span className="dot" style={{ background: game.accent }} />
                    <strong>{game.name}</strong>
                    <span className="muted">{game.loader}</span>
                    <span className={`chip${supported && env?.status === 'ok' ? ' ok' : ''}`}>
                      {supported ? envStatusText(env?.status) : '待接入'}
                    </span>
                  </div>
                  {supported ? (
                    <>
                      <div className="muted small">
                        根目录：
                        {shortPath(env?.root || draft.games[game.id]?.modsPath || '未配置')}
                      </div>
                      <p className="muted small">
                        规则：<code>exclude_recursive = DISABLED*</code>
                      </p>
                      <div className="row">
                        <button
                          className="btn ghost small-btn"
                          onClick={() => void window.moddeck.openEnvironmentFolder(game.id)}
                        >
                          <Icon name="folder" size={14} />
                          打开 EFMI 目录
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="muted small">
                      该 MI 的环境检查尚未接入，配置位置已保留，后续版本补充。
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {tab === 'import' ? (
        <>
          <section className="settings-card">
            <div className="settings-card-head">
              <div className="settings-card-icon" style={{ background: 'rgba(168, 85, 247, 0.12)', color: '#c084fc', borderColor: 'rgba(168, 85, 247, 0.25)' }}>
                <Icon name="download" size={18} />
              </div>
              <div>
                <h3>Mod 导入行为</h3>
                <p className="muted">
                  支持批量选择或拖入 .zip / .7z / .rar 压缩包与已解压的 Mod 文件夹。默认复制不删除原包。
                </p>
              </div>
            </div>
            <div className="setting-group-box">
              <div className="setting-group-header">
                <span className="setting-group-title">导入方式</span>
              </div>
              <div className="segmented">
                <button
                  type="button"
                  className={(draft.import.mode ?? (draft.import.deleteArchiveAfter ? 'move' : 'copy')) === 'copy' ? 'active' : ''}
                  onClick={() => updateImport({ mode: 'copy', deleteArchiveAfter: false })}
                >
                  复制（保留原文件/文件夹）
                </button>
                <button
                  type="button"
                  className={(draft.import.mode ?? (draft.import.deleteArchiveAfter ? 'move' : 'copy')) === 'move' ? 'active' : ''}
                  onClick={() => updateImport({ mode: 'move', deleteArchiveAfter: true })}
                >
                  移动（导入成功后删除原压缩包/文件夹）
                </button>
              </div>
            </div>
            <div className="setting-group-box">
              <label className="check-row-card">
                <input
                  type="checkbox"
                  checked={draft.import.overwriteExisting}
                  onChange={(event) => updateImport({ overwriteExisting: event.target.checked })}
                />
                <div>
                  <div style={{ fontWeight: 600, color: '#f1f5f9' }}>同名时覆盖</div>
                  <div className="muted small" style={{ marginTop: '2px' }}>
                    旧目录会先自动安全备份到 backups 目录；关闭则自动重命名递增。
                  </div>
                </div>
              </label>
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-head">
              <div className="settings-card-icon" style={{ background: 'rgba(52, 211, 153, 0.12)', color: '#34d399', borderColor: 'rgba(52, 211, 153, 0.25)' }}>
                <Icon name="refresh" size={18} />
              </div>
              <div>
                <h3>角色匹配词库（内置离线 + 云端增量合并）</h3>
                <p className="muted">
                  内置完整离线角色词典（中英文、拼音、别名），开箱即用。点击更新可拉取远程 roster.json 并与内置词典做增量合并，不会丢失任何内置角色。
                </p>
              </div>
            </div>
            <div className="setting-group-box">
              <div className="setting-group-header">
                <span className="setting-group-title">远程词库 JSON 地址</span>
                <span className="muted small">GitHub Raw 或自定义镜像地址</span>
              </div>
              <div className="field-row">
                <input
                  className="input"
                  value={draft.import.rosterRemoteUrl ?? ''}
                  placeholder="https://raw.githubusercontent.com/yuzhoujun/ModDeck/main/roster.json"
                  onChange={(event) =>
                    updateImport({ rosterRemoteUrl: event.target.value }, true)
                  }
                />
                <button
                  type="button"
                  className="btn ghost small-btn"
                  onClick={() => void handleSyncRoster()}
                  disabled={rosterSyncing}
                >
                  <Icon name="refresh" size={14} />
                  {rosterSyncing ? '更新中…' : '一键更新词库'}
                </button>
              </div>
              {rosterStatus ? (
                <div className="setting-group-desc">
                  当前词库状态：
                  {games
                    .map((g) => `${g.shortName} ${rosterStatus.gameCounts[g.id] ?? 0} 项`)
                    .join(' · ')}
                  {rosterStatus.updatedAt
                    ? ` · 上次云端同步：${new Date(rosterStatus.updatedAt).toLocaleString()}`
                    : ' · 当前使用内置离线词库'}
                </div>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      {tab === 'about' ? (
        <>
          <section className="settings-card">
            <div className="settings-card-head">
              <div
                className="settings-card-icon"
                style={{
                  background: 'rgba(56, 189, 248, 0.12)',
                  color: '#38bdf8',
                  borderColor: 'rgba(56, 189, 248, 0.25)'
                }}
              >
                <Icon name="info" size={18} />
              </div>
              <div>
                <h3>关于 ModDeck</h3>
                <p className="muted">ModDeck · MIT License · 本地优先 (Local-First 架构)</p>
              </div>
            </div>
            {info ? (
              <div className="kv" style={{ marginBottom: 0 }}>
                <div>
                  <span>软件版本</span>
                  <code>{info.version}</code>
                </div>
                <div>
                  <span>Electron 运行时</span>
                  <code>{info.electron}</code>
                </div>
                <div>
                  <span>Node.js 内核</span>
                  <code>{info.node}</code>
                </div>
                <div>
                  <span>开源协议</span>
                  <code>MIT License</code>
                </div>
              </div>
            ) : null}
          </section>

          <section className="settings-card">
            <div className="settings-card-head">
              <div
                className="settings-card-icon"
                style={{
                  background: 'rgba(234, 179, 8, 0.12)',
                  color: '#fbbf24',
                  borderColor: 'rgba(234, 179, 8, 0.25)'
                }}
              >
                <Icon name="folder" size={18} />
              </div>
              <div>
                <h3>本地数据与存储</h3>
                <p className="muted">设置、角色元数据、封面、快照和日志都保存在本机，纯本地无云端泄露隐患。</p>
              </div>
            </div>

            <div className="setting-group-box">
              <div className="setting-group-header">
                <span className="setting-group-title">数据存储根目录 (userData)</span>
                <span className="muted small">本地持久化存储</span>
              </div>
              <div style={{ margin: '8px 0 12px 0' }}>
                <code
                  style={{
                    display: 'block',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: 'rgba(0, 0, 0, 0.28)',
                    border: '1px solid var(--line-soft)',
                    color: '#cbd5e1',
                    fontSize: '12px',
                    wordBreak: 'break-all',
                    userSelect: 'all'
                  }}
                >
                  {info?.userData || '获取中...'}
                </code>
              </div>
              <div className="row">
                <button className="btn ghost" onClick={() => window.moddeck.openPath('data')}>
                  <Icon name="folder" size={16} />
                  打开数据目录 (userData)
                </button>
                <button className="btn ghost" onClick={() => window.moddeck.openPath('logs')}>
                  <Icon name="folder" size={16} />
                  打开运行日志 (logs)
                </button>
              </div>
              <div className="setting-group-desc">
                💡 包含 ModDeck 配置、角色匹配数据、预设方案快照及运行日志。在重装系统或迁移设备时，直接打包复制该文件夹即可完整保留所有设置与预设。
              </div>
            </div>
          </section>
        </>
      ) : null}

      {showF10WarningModal ? (
        <Modal
          title="开启自动重载确认"
          onClose={() => setShowF10WarningModal(false)}
          width={420}
          footer={
            <>
              <button className="btn ghost" onClick={() => setShowF10WarningModal(false)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setShowF10WarningModal(false)
                  updateUi({ autoReloadModToggle: true, autoReloadF10: true })
                }}
              >
                确认开启
              </button>
            </>
          }
        >
          <div className="danger-confirm-dialog">
            <p>
              开启后，每次切换 Mod 或应用预设都会在 600ms 防抖后自动向游戏发送{' '}
              <code>{draft.ui.reloadHotkey || 'F10'}</code>。
            </p>
            <p className="muted small">
              注意：当 Mods 目录下启用的 Mod 较多时，3DMigoto 执行每次重载大约会有数秒钟的画面停顿，属于加载器正常现象。
            </p>
          </div>
        </Modal>
      ) : null}
      {showDisablePresetReloadModal ? (
        <Modal
          title="关闭预设自动重载确认"
          onClose={() => setShowDisablePresetReloadModal(null)}
          width={440}
          footer={
            <>
              <button className="btn ghost" onClick={() => setShowDisablePresetReloadModal(null)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const target = showDisablePresetReloadModal
                  setShowDisablePresetReloadModal(null)
                  if (target === 'modPreset') {
                    updateUi({ autoReloadModPreset: false })
                  } else if (target === 'rosterPreset') {
                    updateUi({ autoReloadRosterPreset: false })
                  }
                }}
              >
                确认关闭
              </button>
            </>
          }
        >
          <div className="danger-confirm-dialog">
            <p>
              关闭后，在主界面或快捷窗口切换预设将<strong>不再自动驱动游戏换装</strong>。
            </p>
            <p className="muted small">
              新预设将暂存为“待生效”状态（显示为蓝色脉冲光标），您可以在离线状态下挑选多个角色的不同预设，最后<strong>手动按下 {draft.ui.reloadHotkey || 'F10'}</strong>（或点击快捷窗口底部的“立即生效”按钮）一次性全部换装。
            </p>
          </div>
        </Modal>
      ) : null}

      {showBenchmarkModal ? (
        <Modal
          title="3DMigoto 重载耗时测速校准"
          onClose={() => {
            if (benchmarkTimerRef.current) clearInterval(benchmarkTimerRef.current)
            benchmarkTimerRef.current = null
            setShowBenchmarkModal(false)
          }}
          width={460}
          footer={
            benchmarkStatus === 'running' ? (
              <button
                className="btn primary"
                style={{ width: '100%', height: '36px', fontSize: '14px', fontWeight: 600 }}
                onClick={() => {
                  if (benchmarkTimerRef.current) clearInterval(benchmarkTimerRef.current)
                  benchmarkTimerRef.current = null
                  const duration = Math.max(0.1, (Date.now() - benchmarkStartRef.current) / 1000)
                  setBenchmarkElapsed(duration)
                  setBenchmarkStatus('finished')
                }}
              >
                ⏱️ 游戏已重载完毕，停止计时
              </button>
            ) : benchmarkStatus === 'finished' ? (
              <div style={{ display: 'flex', gap: '8px', width: '100%', justifyContent: 'flex-end' }}>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setBenchmarkStatus('idle')
                    setBenchmarkElapsed(0)
                  }}
                >
                  重新测速
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    const rec = Math.min(25, Math.max(2, Math.round((benchmarkElapsed + 1.5) * 2) / 2))
                    updateUi({ postReloadSyncDelay: rec })
                    setShowBenchmarkModal(false)
                  }}
                >
                  应用推荐值 ({Math.min(25, Math.max(2, Math.round((benchmarkElapsed + 1.5) * 2) / 2))}s) 并保存
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', width: '100%', justifyContent: 'flex-end' }}>
                <button
                  className="btn ghost"
                  onClick={() => setShowBenchmarkModal(false)}
                >
                  取消
                </button>
                <button
                  className="btn primary"
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
                  开始测速
                </button>
              </div>
            )
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' }}>
            {benchmarkStatus === 'idle' ? (
              <>
                <p style={{ margin: 0, lineHeight: 1.6 }}>
                  不同玩家的电脑配置与已装 Mod 数量/材质大小不同，3DMigoto 执行 F10 重载的实际耗时差异很大（通常在 1.1s 到 18s 不等）。
                </p>
                <div style={{ background: 'var(--bg-subtle, rgba(255,255,255,0.04))', padding: '10px 12px', borderRadius: '6px', fontSize: '13px' }}>
                  <strong>测速说明：</strong>
                  <ol style={{ margin: '6px 0 0 18px', padding: 0, lineHeight: 1.5 }}>
                    <li>请确保<strong>游戏已在运行中</strong>且处于可游玩画面；</li>
                    <li>点击下方「开始测速」，ModDeck 将向游戏发送 F10 重载按键并即时启动毫秒计时；</li>
                    <li>观察游戏画面：当卡顿结束、左上角提示消失、画面恢复流畅时，立即点击「停止计时」；</li>
                    <li>ModDeck 将自动根据您实测的重载耗时 + 1.5 秒安全余量，计算出最适合您的缓冲同步参数。</li>
                  </ol>
                </div>
              </>
            ) : benchmarkStatus === 'running' ? (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div style={{ fontSize: '13px', color: 'var(--text-muted, #888)', marginBottom: '8px' }}>
                  已向游戏发送 F10，正在重载...
                </div>
                <div style={{ fontSize: '42px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--accent, #6366f1)' }}>
                  {benchmarkElapsed.toFixed(1)}s
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary, #aaa)', marginTop: '8px' }}>
                  👀 请注意观察游戏画面：一旦画面恢复正常流动，请立即点击下方绿色大按钮！
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '12px 0' }}>
                <div style={{ fontSize: '14px', color: 'var(--text-secondary, #aaa)', marginBottom: '4px' }}>
                  实机测量耗时
                </div>
                <div style={{ fontSize: '32px', fontWeight: 700, fontFamily: 'monospace' }}>
                  {benchmarkElapsed.toFixed(2)} 秒
                </div>
                <div style={{ margin: '14px 0', padding: '10px', background: 'var(--bg-subtle, rgba(255,255,255,0.04))', borderRadius: '6px' }}>
                  <div style={{ fontSize: '14px' }}>
                    推荐延迟：<strong style={{ color: 'var(--accent, #6366f1)', fontSize: '16px' }}>{Math.min(25, Math.max(2, Math.round((benchmarkElapsed + 1.5) * 2) / 2))} 秒</strong>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted, #888)', marginTop: '4px' }}>
                    （测得耗时 {benchmarkElapsed.toFixed(1)}s + 1.5s 安全余量，确保 Shader 编译完成并跨过 Present 帧）
                  </div>
                </div>
              </div>
            )}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
