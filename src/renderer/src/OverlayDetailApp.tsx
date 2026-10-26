import { useEffect, useState } from 'react'
import type { GameId, ModDetails, ModVariantPreset } from '../../shared/types'
import { Icon } from './components/Icon'
import { ScrollTitle } from './components/ScrollTitle'
import { errorMessage } from './utils'

export function OverlayDetailApp() {
  const params = new URLSearchParams(window.location.search)
  const gameId = params.get('gameId') as GameId | null
  const characterFolder = params.get('character') || ''
  const modFolder = params.get('mod') || ''
  const [details, setDetails] = useState<ModDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  // 2.2.2.1: 单 Mod 预设在游戏快捷侧栏现场展示、切换与保存
  const [presets, setPresets] = useState<ModVariantPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [showSaveBox, setShowSaveBox] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)

  const fetchPresets = async () => {
    if (!gameId || !characterFolder || !modFolder) return
    try {
      setPresetsLoading(true)
      const list = await window.moddeck.getModPresets(gameId, characterFolder, modFolder)
      setPresets(list)
    } catch {
      // ignore
    } finally {
      setPresetsLoading(false)
    }
  }

  const fetchDetails = async () => {
    if (!gameId || !characterFolder || !modFolder) return
    try {
      const data = await window.moddeck.getModDetails(gameId, characterFolder, modFolder)
      setDetails(data)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  useEffect(() => {
    let cancelled = false
    void fetchDetails()
    void fetchPresets()

    const unsubscribe = window.moddeck.onStateChanged(() => {
      if (!cancelled) {
        void fetchDetails()
        void fetchPresets()
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [gameId, characterFolder, modFolder])

  // 发送热键
  async function send(key: string) {
    setSent(null)
    try {
      const result = await window.moddeck.sendModHotkey(key)
      if (!result.ok) setError(result.error || '发送失败')
      else setSent(key)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  // 判定预设是否处于激活状态
  const currentActiveInis = (details?.iniFiles || []).map((f) =>
    f.replace(/\\/g, '/').toLowerCase()
  )

  function isPresetActive(preset: ModVariantPreset): boolean {
    const desired = new Set(preset.activeIniFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()))
    if (desired.size !== currentActiveInis.length) return false
    for (const item of currentActiveInis) {
      if (!desired.has(item)) return false
    }
    return true
  }

  // 应用预设
  async function handleApplyPreset(preset: ModVariantPreset) {
    if (!gameId || !characterFolder || !modFolder) return
    try {
      const res = await window.moddeck.applyModPreset(
        gameId,
        characterFolder,
        modFolder,
        preset.id
      )
      if (res.ok) {
        setSent(`预设「${preset.name}」已应用`)
        void fetchDetails()
        void fetchPresets()
      } else {
        setError(res.error || '应用预设失败')
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  // 现场保存预设
  async function handleSavePreset() {
    if (!gameId || !characterFolder || !modFolder) return
    const name = newPresetName.trim()
    if (!name) return
    try {
      setSavingPreset(true)
      const res = await window.moddeck.saveModPreset(
        gameId,
        characterFolder,
        modFolder,
        name
      )
      if (res.ok) {
        setSent(`当前状态已存为预设「${name}」`)
        setNewPresetName('')
        setShowSaveBox(false)
        void fetchPresets()
      } else {
        setError(res.error || '保存预设失败')
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSavingPreset(false)
    }
  }

  return (
    <div className="overlay-detail">
      <header className="overlay-head">
        <div className="overlay-brand">
          <span className="brand-mark small">M</span>
          <div className="overlay-brand-text">
            <ScrollTitle
              text={details?.name || 'Mod 热键与预设'}
              className="overlay-title-marquee"
            />
            <span>{details ? (details.enabled ? '已启用' : '已禁用') : '读取中…'}</span>
          </div>
        </div>
        <div className="overlay-head-actions">
          <button
            className="icon-btn"
            onClick={() => window.moddeck.hideOverlayDetail()}
            title="关闭"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      {error ? <div className="overlay-error">{error}</div> : null}

      <div className="overlay-detail-body">
        {!details ? (
          <div className="overlay-empty">
            <div className="spinner" />
          </div>
        ) : (
          <>
            {/* 2.2.2.1: 变体预设操作区 */}
            <div className="overlay-section">
              <div className="overlay-section-head">
                <span className="overlay-section-title">变体 / 预设快照</span>
                <button
                  className="btn ghost small-btn overlay-preset-toggle-btn"
                  onClick={() => setShowSaveBox(!showSaveBox)}
                  title="将游戏当前变体状态保存为新预设"
                >
                  <Icon name="plus" size={12} />
                  {showSaveBox ? '取消' : '存为预设'}
                </button>
              </div>

              {showSaveBox ? (
                <div className="overlay-preset-save-box">
                  <input
                    className="input small-input"
                    placeholder="输入预设名（如：长发短裙）"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSavePreset()
                    }}
                    autoFocus
                  />
                  <button
                    className="btn primary small-btn"
                    disabled={savingPreset}
                    onClick={() => void handleSavePreset()}
                  >
                    保存
                  </button>
                </div>
              ) : null}

              <div className="overlay-presets-chips">
                {presetsLoading ? (
                  <span className="muted small">读取中…</span>
                ) : presets.length === 0 ? (
                  <span className="muted small">暂无预设</span>
                ) : (
                  presets.map((preset) => {
                    const active = isPresetActive(preset)
                    return (
                      <button
                        key={preset.id}
                        className={`overlay-preset-chip${active ? ' is-active' : ''}`}
                        onClick={() => void handleApplyPreset(preset)}
                        title={active ? '当前正处于此预设' : `点击应用「${preset.name}」并刷新`}
                      >
                        <span className="preset-dot" />
                        <span className="preset-chip-name">{preset.name}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>

            {/* 游戏内按键区 */}
            <div className="overlay-section" style={{ marginTop: '14px' }}>
              <div className="overlay-section-head">
                <span className="overlay-section-title">游戏内热键 (点击发送)</span>
              </div>
              {details.hotkeys.length === 0 ? (
                <div className="muted small" style={{ marginTop: '4px' }}>
                  该 Mod 的 ini 里没有配置快捷键
                </div>
              ) : (
                <div className="hotkey-grid">
                  {details.hotkeys.map((hotkey, index) => (
                    <button
                      key={`${hotkey.section}-${index}`}
                      className="hotkey-pill"
                      onClick={() => void send(hotkey.key)}
                      title={`${hotkey.section} · 点击发送`}
                    >
                      <kbd>{hotkey.key}</kbd>
                      <span>{hotkey.section}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {sent ? <div className="hint" style={{ marginTop: '10px' }}>{sent}</div> : null}
          </>
        )}
      </div>
    </div>
  )
}
