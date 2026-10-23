import { useEffect, useState } from 'react'
import type { GameId, ModDetails } from '../../shared/types'
import { Icon } from './components/Icon'
import { errorMessage } from './utils'

export function OverlayDetailApp() {
  const params = new URLSearchParams(window.location.search)
  const gameId = params.get('gameId') as GameId | null
  const characterFolder = params.get('character') || ''
  const modFolder = params.get('mod') || ''
  const [details, setDetails] = useState<ModDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!gameId || !characterFolder || !modFolder) return
      try {
        const data = await window.moddeck.getModDetails(gameId, characterFolder, modFolder)
        if (!cancelled) setDetails(data)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [gameId, characterFolder, modFolder])

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

  return (
    <div className="overlay-detail">
      <header className="overlay-head">
        <div className="overlay-brand">
          <span className="brand-mark small">M</span>
          <div>
            <strong>{details?.name || 'Mod 热键'}</strong>
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
        ) : details.hotkeys.length === 0 ? (
          <div className="overlay-empty">
            <Icon name="box" size={24} />
            <span>这个 Mod 的 ini 里没有找到 key</span>
          </div>
        ) : (
          <>
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
            {sent ? <div className="hint">已发送 {sent}</div> : null}
          </>
        )}
      </div>
    </div>
  )
}
