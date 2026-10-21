import { useEffect, useState, type KeyboardEvent } from 'react'
import type { AppInfo, GameDef, Settings, SettingsPatch } from '../../../shared/types'
import { Icon } from '../components/Icon'
import type { IconName } from '../components/Icon'
import { errorMessage } from '../utils'

type SettingsTab = 'general' | 'games' | 'import' | 'about'

export function SettingsView({
  games,
  settings,
  onSave,
  onNotify
}: {
  games: GameDef[]
  settings: Settings
  onSave: (patch: SettingsPatch) => Promise<void>
  onNotify: (text: string, kind?: 'ok' | 'err' | 'info') => void
}) {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [draft, setDraft] = useState<Settings>(settings)
  const [hotkeyDraft, setHotkeyDraft] = useState(settings.ui.overlayHotkey)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [hotkeyMessage, setHotkeyMessage] = useState<string | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    setDraft(settings)
    setHotkeyDraft(settings.ui.overlayHotkey)
  }, [settings])

  useEffect(() => {
    window.moddeck
      .appInfo()
      .then(setInfo)
      .catch(() => undefined)
  }, [])

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
      await onSave({ games: draft.games, import: draft.import })
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
    { id: 'import', label: '导入', icon: 'download' },
    { id: 'about', label: '关于', icon: 'box' }
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
          <button className="btn primary" onClick={save} disabled={saving || tab === 'general'}>
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
                    <span>Mods 目录</span>
                    <div className="field-row">
                      <input
                        className="input"
                        value={value?.modsPath ?? ''}
                        placeholder="例如 D:\\Game-D\\XXMI\\XXMI\\EFMI\\Mods"
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

      {tab === 'import' ? (
        <section className="section first-section">
          <div className="section-head">
            <h2>导入</h2>
            <p className="muted">同名 Mod 默认自动改名，避免覆盖已有目录。</p>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.import.deleteArchiveAfter}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  import: { ...current.import, deleteArchiveAfter: event.target.checked }
                }))
              }
            />
            <span>导入成功后删除压缩包</span>
          </label>
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
            <span>同名时覆盖（旧目录会先移动到 backups）</span>
          </label>
        </section>
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
