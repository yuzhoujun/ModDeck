import { useEffect, useState, type KeyboardEvent } from 'react'
import type {
  AppInfo,
  EnvironmentCheck,
  GameDef,
  RosterSyncStatus,
  Settings,
  SettingsPatch
} from '../../../shared/types'
import { Icon } from '../components/Icon'
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
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [hotkeyMessage, setHotkeyMessage] = useState<string | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [envResults, setEnvResults] = useState<EnvironmentCheck[]>([])
  const [envChecking, setEnvChecking] = useState(false)
  const [rosterStatus, setRosterStatus] = useState<RosterSyncStatus | null>(null)
  const [rosterSyncing, setRosterSyncing] = useState(false)

  useEffect(() => {
    setDraft(settings)
    setHotkeyDraft(settings.ui.overlayHotkey)
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
  }, [])

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

  function updateUi(patch: Partial<Settings['ui']>) {
    setDraft((current) => ({ ...current, ui: { ...current.ui, ...patch } }))
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

  function updateGame(gameId: string, patch: Partial<Settings['games'][string]>) {
    setDraft((current) => ({
      ...current,
      games: {
        ...current.games,
        [gameId]: { ...current.games[gameId], ...patch }
      }
    }))
  }

  async function pickInto(
    gameId: string,
    field: 'modsPath' | 'gamePath' | 'loaderPath',
    picker: () => Promise<string | null>
  ) {
    const picked = await picker()
    if (picked) updateGame(gameId, { [field]: picked })
  }

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      await onSave({
        games: draft.games,
        import: draft.import,
        ui: {
          allowHotkeySend: draft.ui.allowHotkeySend,
          envCheckEnabled: draft.ui.envCheckEnabled,
          envCheckNeverPrompt: draft.ui.envCheckNeverPrompt,
          autoReloadF10: draft.ui.autoReloadF10,
          recentModCount: draft.ui.recentModCount,
          closeBehavior: draft.ui.closeBehavior
        }
      })
      setMessage('已保存')
      onNotify('设置已保存')
    } catch (error) {
      onNotify(errorMessage(error), 'err')
    } finally {
      setSaving(false)
    }
  }

  function captureHotkey(event: KeyboardEvent<HTMLInputElement>) {
    event.preventDefault()
    if (event.key === 'Escape') return
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return

    const parts: string[] = []
    if (event.ctrlKey) parts.push('Control')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    if (event.metaKey) parts.push('Super')

    let key = event.key
    if (key === ' ') key = 'Space'
    else if (key.length === 1) key = key.toUpperCase()
    parts.push(key)
    setHotkeyDraft(parts.join('+'))
  }

  async function applyHotkey(value: string) {
    setHotkeyMessage(null)
    try {
      const result = await window.moddeck.setOverlayHotkey(value)
      if (!result.ok) {
        setHotkeyMessage(result.error || '快捷键保存失败')
        return
      }
      await onSave({ ui: { overlayHotkey: result.hotkey ?? value } })
      setHotkeyMessage(value ? `已保存：${value}` : '已禁用快捷窗口快捷键')
      onNotify(value ? `快捷键已设为 ${value}` : '已禁用快捷键')
    } catch (error) {
      setHotkeyMessage(errorMessage(error))
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
          <div className="eyebrow">设置</div>
          <h1>设置</h1>
          <p className="muted">通用、游戏路径、导入行为和本地数据。所有配置只保存在本机。</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={save} disabled={saving}>
            <Icon name="check" size={16} />
            {saving ? '保存中…' : '保存设置'}
          </button>
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

      {message ? <div className="notice">{message}</div> : null}

      {tab === 'general' ? (
        <>
          <section className="section first-section">
            <div className="section-head">
              <h2>快捷窗口</h2>
              <p className="muted">
                在游戏里按快捷键呼出紧凑的 Mod 开关面板。快捷键全局生效，冲突时请换一个。
              </p>
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
              <button className="btn" onClick={() => void applyHotkey(hotkeyDraft)}>
                应用
              </button>
              <button className="btn ghost" onClick={() => void applyHotkey('')}>
                禁用
              </button>
              <button className="btn ghost" onClick={() => window.moddeck.toggleOverlay()}>
                测试
              </button>
            </div>
            {hotkeyMessage ? <div className="hint">{hotkeyMessage}</div> : null}
            <div className="muted small">
              当前：{settings.ui.overlayHotkey || '未设置'} · 按 Esc 隐藏快捷窗口
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.ui.allowHotkeySend}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    ui: { ...current.ui, allowHotkeySend: event.target.checked }
                  }))
                }
              />
              <span>允许点击热键发送到游戏（游戏需要在前台）</span>
            </label>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>快捷窗口行为</h2>
              <p className="muted">控制切换 Mod 后的刷新方式和最近使用记录。</p>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.ui.autoReloadF10}
                onChange={(event) => updateUi({ autoReloadF10: event.target.checked })}
              />
              <span>
                切换 Mod 后自动发送 F10（仅快捷窗口、800ms 防抖、前台是游戏时）
              </span>
            </label>
            <label className="field">
              <span>最近使用 Mod 数量：{draft.ui.recentModCount}</span>
              <input
                type="range"
                min="0"
                max="15"
                step="1"
                value={draft.ui.recentModCount}
                onChange={(event) => updateUi({ recentModCount: Number(event.target.value) })}
              />
            </label>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>关闭行为</h2>
              <p className="muted">
                最小化后 ModDeck 会留在托盘，全局快捷键和快捷窗口继续可用。
              </p>
            </div>
            <label className="field">
              <span>关闭主窗口时</span>
              <select
                className="select"
                value={draft.ui.closeBehavior}
                onChange={(event) =>
                  updateUi({
                    closeBehavior: event.target.value === 'minimize' ? 'minimize' : 'quit'
                  })
                }
              >
                <option value="quit">直接退出</option>
                <option value="minimize">最小化到托盘</option>
              </select>
            </label>
            <div className="muted small">
              当前：{draft.ui.closeBehavior === 'minimize' ? '最小化到托盘' : '直接退出'}
              {draft.ui.closeBehavior === 'minimize'
                ? ' · 托盘菜单可打开管理器或退出'
                : ' · 关闭主窗口会结束进程'}
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>本地数据</h2>
              <p className="muted">设置、角色元数据、封面和日志都保存在本机。</p>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={() => window.moddeck.openPath('data')}>
                <Icon name="folder" size={16} />
                打开数据目录
              </button>
              <button className="btn ghost" onClick={() => window.moddeck.openPath('logs')}>
                <Icon name="folder" size={16} />
                打开日志
              </button>
            </div>
          </section>
        </>
      ) : null}

      {tab === 'games' ? (
        <section className="section first-section">
          <div className="section-head">
            <h2>游戏与路径</h2>
            <p className="muted">
              只需要指向 Mods 目录；游戏程序和启动器用于顶部的“启动游戏 / 启动 XXMI”按钮。
            </p>
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
                          updateGame(game.id, { modsPath: event.target.value })
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
                          updateGame(game.id, { gamePath: event.target.value })
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
                          updateGame(game.id, { loaderPath: event.target.value })
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
                        updateGame(game.id, { launchArgs: event.target.value })
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
        <section className="section first-section">
          <div className="section-head">
            <h2>MI 环境</h2>
            <p className="muted">
              当前只接入 EFMI 的环境检查。其他 MI 的配置位置已保留，后续版本补充。
            </p>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.ui.envCheckEnabled}
              onChange={(event) => {
                updateUi({ envCheckEnabled: event.target.checked })
                if (event.target.checked) void refreshEnvironment()
              }}
            />
            <span>启动时检查 DISABLED 规则（默认开启）</span>
          </label>
          <div className="row">
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
          <section className="section first-section">
            <div className="section-head">
              <h2>导入行为</h2>
              <p className="muted">
                支持批量选择或拖入 .zip / .7z / .rar 压缩包与已解压的 Mod 文件夹。默认复制不删除原包。
              </p>
            </div>
            <div className="field">
              <span>导入方式</span>
              <div className="segmented">
                <button
                  type="button"
                  className={(draft.import.mode ?? (draft.import.deleteArchiveAfter ? 'move' : 'copy')) === 'copy' ? 'active' : ''}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      import: { ...current.import, mode: 'copy', deleteArchiveAfter: false }
                    }))
                  }
                >
                  复制（保留原文件/文件夹）
                </button>
                <button
                  type="button"
                  className={(draft.import.mode ?? (draft.import.deleteArchiveAfter ? 'move' : 'copy')) === 'move' ? 'active' : ''}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      import: { ...current.import, mode: 'move', deleteArchiveAfter: true }
                    }))
                  }
                >
                  移动（导入成功后删除原压缩包/文件夹）
                </button>
              </div>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.import.overwriteExisting}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    import: { ...current.import, overwriteExisting: event.target.checked }
                  }))
                }
              />
              <span>同名时覆盖（旧目录会先移动到 backups；关闭则自动重命名）</span>
            </label>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>角色匹配词库（内置离线 + 云端增量合并）</h2>
              <p className="muted">
                内置完整离线角色词典（中英文、拼音、别名），开箱即用。点击更新可拉取远程 roster.json 并与内置词典做增量合并，不会丢失任何内置角色。
              </p>
            </div>
            <label className="field">
              <span>远程词库 JSON 地址（GitHub Raw 或镜像地址）</span>
              <div className="field-row">
                <input
                  className="input"
                  value={draft.import.rosterRemoteUrl ?? ''}
                  placeholder="https://raw.githubusercontent.com/yuzhoujun/ModDeck/main/roster.json"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      import: { ...current.import, rosterRemoteUrl: event.target.value }
                    }))
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
            </label>
            {rosterStatus ? (
              <div className="muted small">
                当前词库状态：
                {games
                  .map((g) => `${g.shortName} ${rosterStatus.gameCounts[g.id] ?? 0} 项`)
                  .join(' · ')}
                {rosterStatus.updatedAt
                  ? ` · 上次云端同步：${new Date(rosterStatus.updatedAt).toLocaleString()}`
                  : ' · 当前使用内置离线词库'}
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {tab === 'about' ? (
        <section className="section first-section">
          <div className="section-head">
            <h2>关于</h2>
            <p className="muted">ModDeck · MIT License · 完全离线</p>
          </div>
          {info ? (
            <div className="kv">
              <div>
                <span>版本</span>
                <code>{info.version}</code>
              </div>
              <div>
                <span>Electron</span>
                <code>{info.electron}</code>
              </div>
              <div>
                <span>Node</span>
                <code>{info.node}</code>
              </div>
              <div>
                <span>数据目录</span>
                <code>{info.userData}</code>
              </div>
            </div>
          ) : null}
          <div className="row">
            <button className="btn ghost" onClick={() => window.moddeck.openPath('data')}>
              <Icon name="folder" size={16} />
              打开数据目录
            </button>
            <button className="btn ghost" onClick={() => window.moddeck.openPath('logs')}>
              <Icon name="folder" size={16} />
              打开日志
            </button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
