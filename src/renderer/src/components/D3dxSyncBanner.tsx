import type { D3dxSyncStatus } from '../../../shared/types'
import { useI18n } from '../i18n'
import { formatSyncAge } from '../utils'

export function D3dxSyncBanner({
  status,
  compact = false
}: {
  status: D3dxSyncStatus | null
  compact?: boolean
}) {
  const { t } = useI18n()
  if (!status) return null

  if (status.pendingCount > 0) {
    return (
      <div className={`d3dx-sync-hint warn${compact ? ' is-compact' : ''}`}>
        {t('preset.d3dxStatusPending')}
      </div>
    )
  }

  if (!status.exists) {
    return (
      <div className={`d3dx-sync-hint muted${compact ? ' is-compact' : ''}`}>
        {t('preset.d3dxStatusNoFile')}
      </div>
    )
  }

  const ageSec = status.mtimeMs ? Math.max(0, Math.floor((Date.now() - status.mtimeMs) / 1000)) : 999
  const isStale = status.gameRunning && ageSec > 15
  const timeText = formatSyncAge(status.mtimeMs, t)

  return (
    <div className={`d3dx-sync-hint${isStale ? ' warn' : ' ok'}${compact ? ' is-compact' : ''}`}>
      <span>{t('preset.d3dxStatusUpdatedAgo', { time: timeText })}</span>
      {isStale ? <span className="d3dx-sync-sub">{t('preset.d3dxStatusStaleHint')}</span> : null}
      {!compact && (status.autoSaveInterval === -1 || status.autoSaveInterval >= 60) ? (
        <span className="d3dx-sync-sub">
          {t('preset.d3dxStatusIntervalHint', {
            interval: status.autoSaveInterval === -1 ? 'Off' : `${status.autoSaveInterval}s`
          })}
        </span>
      ) : null}
    </div>
  )
}
