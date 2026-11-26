import { useEffect, useState } from 'react'
import type {
  ConflictSeverity,
  GameConflictAuditReport,
  GameDef
} from '../../../shared/types'
import { useI18n, getLocaleGameName } from '../i18n'
import { errorMessage } from '../utils'
import { Icon } from './Icon'
import { Modal } from './Modal'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function ConflictAuditModal({
  game,
  onClose,
  onNotify,
  onMutated,
  onReportLoaded
}: {
  game: GameDef
  onClose: () => void
  onNotify: (text: string, kind?: 'ok' | 'err' | 'info') => void
  onMutated?: () => void
  onReportLoaded?: (report: GameConflictAuditReport) => void
}) {
  const { t, effectiveLocale } = useI18n()
  const [loading, setLoading] = useState(true)
  const [report, setReport] = useState<GameConflictAuditReport | null>(null)
  const [filter, setFilter] = useState<'all' | ConflictSeverity>('all')
  const [catFilter, setCatFilter] = useState<'all' | 'render' | 'hotkeys'>('all')
  const [clearingCache, setClearingCache] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [disablingKey, setDisablingKey] = useState<string | null>(null)

  async function runAudit() {
    setLoading(true)
    try {
      const next = await window.moddeck.auditGameConflicts(game.id)
      setReport(next)
      onReportLoaded?.(next)
    } catch (error) {
      onNotify(errorMessage(error), 'err')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void runAudit()
  }, [game.id])

  async function handleClearShaderCache() {
    setClearingCache(true)
    try {
      const res = await window.moddeck.clearShaderCache(game.id)
      if (!res.ok) {
        onNotify(res.error || t('common.operationFailed'), 'err')
      } else {
        onNotify(
          t('audit.clearCacheSuccess', {
            count: res.deletedFiles ?? 0,
            size: formatBytes(res.freedBytes ?? 0)
          }),
          'ok'
        )
        await runAudit()
      }
    } catch (error) {
      onNotify(errorMessage(error), 'err')
    } finally {
      setClearingCache(false)
    }
  }

  async function handleDisableMod(characterFolder: string, folderName: string) {
    const key = `${characterFolder}/${folderName}`
    setDisablingKey(key)
    try {
      const res = await window.moddeck.toggleMod(game.id, characterFolder, folderName, false)
      if (!res.ok) {
        onNotify(res.error || t('common.operationFailed'), 'err')
        return
      }
      onNotify(t('audit.disabledModSuccess', { mod: folderName.replace(/^DISABLED_/i, '') }), 'ok')
      onMutated?.()
      await runAudit()
    } catch (error) {
      onNotify(errorMessage(error), 'err')
    } finally {
      setDisablingKey(null)
    }
  }

  async function handleExport() {
    if (!report) return
    setExporting(true)
    try {
      const res = await window.moddeck.exportConflictAuditReport(game.id, report)
      if (res.ok && res.filePath) {
        onNotify(t('audit.exportSuccess', { path: res.filePath }), 'ok')
      }
    } catch (error) {
      onNotify(errorMessage(error), 'err')
    } finally {
      setExporting(false)
    }
  }

  const items = report?.items || []
  const hotkeyCount = items.filter((item) => item.category === 'hotkey-collision').length
  const renderCount = items.length - hotkeyCount

  const visibleItems = items.filter((item) => {
    const matchesSeverity = filter === 'all' || item.severity === filter
    const isHotkey = item.category === 'hotkey-collision'
    const matchesCategory =
      catFilter === 'all' ||
      (catFilter === 'hotkeys' && isHotkey) ||
      (catFilter === 'render' && !isHotkey)
    return matchesSeverity && matchesCategory
  })

  const shouldCollapseCrossCharHotkeys = filter === 'all' && catFilter === 'all'
  const crossCharInfoHotkeys = shouldCollapseCrossCharHotkeys
    ? visibleItems.filter(
        (item) => item.severity === 'info' && item.category === 'hotkey-collision'
      )
    : []
  const mainItems = shouldCollapseCrossCharHotkeys
    ? visibleItems.filter(
        (item) => !(item.severity === 'info' && item.category === 'hotkey-collision')
      )
    : visibleItems

  function renderAuditCard(item: GameConflictAuditReport['items'][number]) {
    const seenMods = new Set<string>()
    return (
      <div key={item.id} className={`audit-card sev-${item.severity}`}>
        <div className="audit-card-head">
          <span className={`tag sev-${item.severity}`}>
            {item.severity === 'high'
              ? t('audit.severityHigh')
              : item.severity === 'warning'
                ? t('audit.severityWarning')
                : t('audit.severityInfo')}
          </span>
          <strong className="audit-card-title">{item.message}</strong>
        </div>
        {item.detail ? <div className="muted small">{item.detail}</div> : null}
        {item.locations.length > 0 ? (
          <div className="audit-loc-list">
            {item.locations.slice(0, 12).map((loc, idx) => {
              const modKey = `${loc.characterFolder}/${loc.folderName}`
              const showAction = !seenMods.has(modKey)
              seenMods.add(modKey)
              return (
                <div key={`${modKey}-${loc.file}-${loc.line}-${idx}`} className="audit-loc-row">
                  <div className="audit-loc-text">
                    <span className="audit-mod-name">
                      {loc.characterFolder ? `${loc.characterFolder} / ${loc.name}` : loc.name}
                    </span>
                    <code className="audit-file-loc">
                      {loc.file}
                      {loc.line > 0 ? `:${loc.line}` : ''}
                    </code>
                    {loc.section ? <span className="tag">[{loc.section}]</span> : null}
                  </div>
                  {showAction ? (
                    <div className="audit-loc-actions">
                      {loc.characterFolder ? (
                        <>
                          <button
                            type="button"
                            className="btn ghost tiny-btn"
                            onClick={() =>
                              void window.moddeck.openModFolder(
                                game.id,
                                loc.characterFolder,
                                loc.folderName
                              )
                            }
                          >
                            <Icon name="folder" size={12} />
                          </button>
                          <button
                            type="button"
                            className="btn ghost tiny-btn"
                            disabled={disablingKey === modKey}
                            onClick={() =>
                              void handleDisableMod(loc.characterFolder, loc.folderName)
                            }
                          >
                            {t('audit.disableMod')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn ghost tiny-btn"
                          onClick={() => void window.moddeck.openPath('mods', game.id)}
                        >
                          <Icon name="folder" size={12} />
                          {t('audit.openModsFolder')}
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {item.locations.length > 12 ? (
              <div className="muted small">
                {t('audit.moreLocations', { count: item.locations.length - 12 })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <Modal
      title={`${t('audit.modalTitle')} · ${getLocaleGameName(game, effectiveLocale)}`}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button
            className="btn ghost"
            onClick={() => void handleExport()}
            disabled={!report || loading || exporting}
          >
            <Icon name="download" size={14} />
            {t('audit.exportReport')}
          </button>
          <button className="btn ghost" onClick={() => void runAudit()} disabled={loading}>
            <Icon name="refresh" size={14} />
            {t('audit.rescan')}
          </button>
          <button className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      {loading && !report ? (
        <div className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>
          {t('audit.scanning')}
        </div>
      ) : report ? (
        <div className="audit-modal-body">
          <div className="audit-summary-bar">
            <div className="muted small">
              {t('audit.scannedSummary', {
                mods: report.scannedMods,
                inis: report.scannedIniFiles
              })}
            </div>
            <div className="audit-filter-chips">
              <button
                type="button"
                className={`chip-btn${filter === 'all' ? ' active' : ''}`}
                onClick={() => setFilter('all')}
              >
                {t('common.all')} ({report.items.length})
              </button>
              <button
                type="button"
                className={`chip-btn${filter === 'high' ? ' active' : ''}`}
                onClick={() => setFilter('high')}
              >
                {t('audit.severityHigh')} ({report.summary.high})
              </button>
              <button
                type="button"
                className={`chip-btn${filter === 'warning' ? ' active' : ''}`}
                onClick={() => setFilter('warning')}
              >
                {t('audit.severityWarning')} ({report.summary.warning})
              </button>
              <button
                type="button"
                className={`chip-btn${filter === 'info' ? ' active' : ''}`}
                onClick={() => setFilter('info')}
              >
                {t('audit.severityInfo')} ({report.summary.info})
              </button>
            </div>
          </div>

          <div className="audit-filter-chips">
            <button
              type="button"
              className={`chip-btn${catFilter === 'all' ? ' active' : ''}`}
              onClick={() => setCatFilter('all')}
            >
              {t('audit.catAll')} ({items.length})
            </button>
            <button
              type="button"
              className={`chip-btn${catFilter === 'render' ? ' active' : ''}`}
              onClick={() => setCatFilter('render')}
            >
              {t('audit.catRender')} ({renderCount})
            </button>
            <button
              type="button"
              className={`chip-btn${catFilter === 'hotkeys' ? ' active' : ''}`}
              onClick={() => setCatFilter('hotkeys')}
            >
              {t('audit.catHotkeys')} ({hotkeyCount})
            </button>
          </div>

          {report.environment?.shaderCache?.dirExists &&
          report.environment.shaderCache.fileCount > 0 ? (
            <div className="audit-cache-bar">
              <div>
                <div style={{ fontWeight: 600, fontSize: '13px', color: '#f1f5f9' }}>
                  {t('settings.environment.shaderCacheLabel')}:{' '}
                  {report.environment.shaderCache.fileCount} ({formatBytes(report.environment.shaderCache.totalBytes)})
                </div>
                <div className="muted small">{t('audit.shaderCacheBarHint')}</div>
              </div>
              <button
                type="button"
                className="btn ghost small-btn"
                disabled={clearingCache}
                onClick={() => void handleClearShaderCache()}
              >
                <Icon name="trash" size={14} />
                {clearingCache ? t('common.processing') : t('settings.environment.clearShaderCache')}
              </button>
            </div>
          ) : null}

          {visibleItems.length === 0 ? (
            <div className="empty-box" style={{ padding: '24px 12px' }}>
              <Icon name="check" size={24} />
              <div style={{ marginTop: '8px', fontWeight: 600 }}>{t('audit.noIssuesFound')}</div>
            </div>
          ) : (
            <div className="audit-list">
              {mainItems.map((item) => renderAuditCard(item))}
              {crossCharInfoHotkeys.length > 0 ? (
                <details className="audit-collapsible-group">
                  <summary className="audit-collapsible-summary">
                    {t('audit.crossCharGuardedGroup', { count: crossCharInfoHotkeys.length })}
                  </summary>
                  <div className="audit-collapsible-items">
                    {crossCharInfoHotkeys.map((item) => renderAuditCard(item))}
                  </div>
                </details>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  )
}
