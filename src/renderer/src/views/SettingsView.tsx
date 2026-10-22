import { useEffect, useState } from 'react'
import type { AppInfo, GameDef, Settings, SettingsPatch } from '../../../shared/types'
import { Icon } from '../components/Icon'
import { errorMessage } from '../utils'

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
  const [draft, setDraft] = useState<Settings>(settings)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    setDraft(settings)
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
      await onSave({ games: draft.games, import: draft.import, ui: draft.ui })
      setMessage('已保存')
      onNotify('设置已保存')
    } catch (error) {
      onNotify(errorMessage(error), 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <div className="eyebrow">设置</div>
          <h1>设置</h1>
          <p className="muted">路径、导入行为和本地数据。所有配置只保存在本机。</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={save} disabled={saving}>
            <Icon name="check" size={16} />
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </header>

      {message ? <div className="notice">{message}</div> : null}

      <section className="section">
        <div className="section-head">
          <h2>游戏与路径</h2>
          <p className="muted">只需要指向 Mods 目录；游戏路径和启动器可选，用于“打开”按钮。</p>
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
                      placeholder="例如 .../XXMI/XXMI/EFMI/Mods"
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
              </div>
            )
          })}
        </div>
      </section>

      <section className="section">
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

      <section className="section">
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
    </div>
  )
}
