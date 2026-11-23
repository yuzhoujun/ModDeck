import { useEffect, useState, type DragEvent } from 'react'
import type {
  CharacterHashConflict,
  D3dxSyncStatus,
  GameId,
  ModDetails,
  ModStaticAnalysis,
  ModVariantPreset
} from '../../../shared/types'
import { formatDate, isReservedDefaultPresetName } from '../utils'
import { D3dxSyncBanner } from './D3dxSyncBanner'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PresetDetailModal } from './PresetDetailModal'
import { ScrollTitle } from './ScrollTitle'
import { useI18n } from '../i18n'
import { resolveDroppedFilePath } from '../tauri-bridge'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif|avif)$/i

export function ModDetailsPanel({
  gameId,
  details,
  loading,
  error,
  conflicts = [],
  onClose,
  onToggle,
  onOpen,
  onDelete,
  onSetPreview,
  onNotify,
  onRefreshDetails
}: {
  gameId: GameId
  details: ModDetails | null
  loading: boolean
  error: string | null
  conflicts?: CharacterHashConflict[]
  onClose: () => void
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
  onSetPreview?: (sourcePath?: string) => Promise<void> | void
  onNotify?: (text: string, kind?: 'ok' | 'err' | 'info') => void
  onRefreshDetails?: () => void
}) {
  const { t, effectiveLocale } = useI18n()
  const [previewDrag, setPreviewDrag] = useState(false)
  const [presets, setPresets] = useState<ModVariantPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [showSavePreset, setShowSavePreset] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)
  const [syncStatus, setSyncStatus] = useState<D3dxSyncStatus | null>(null)
  const [, setSyncClockTick] = useState(0)
  const [staticAnalysis, setStaticAnalysis] = useState<ModStaticAnalysis | null>(null)
  const [diagModalOpen, setDiagModalOpen] = useState(false)

  const [confirmPreset, setConfirmPreset] = useState<ModVariantPreset | null>(null)
  const [inspectingPreset, setInspectingPreset] = useState<ModVariantPreset | null>(null)

  const modKey = details ? `${gameId}:${details.characterFolder}:${details.name}` : ''

  // 判定当前 Mod 磁盘上处于激活状态的 ini
  const currentActiveInis = (details?.iniFiles || []).map((f) =>
    f.replace(/\\/g, '/').toLowerCase()
  )

  function isPresetActive(preset: ModVariantPreset): boolean {
    if (typeof preset.isActive === 'boolean') {
      return preset.isActive
    }
    const desired = new Set(preset.activeIniFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()))
    if (desired.size !== currentActiveInis.length) return false
    for (const item of currentActiveInis) {
      if (!desired.has(item)) return false
    }
    return true
  }

  // 检查当前变体是否已被更改且未保存
  function hasUnsavedChanges(): boolean {
    if (!details) return false
    // 如果当前状态与列表中的任意一个预设（包括默认预设）完全吻合，则视为未更改
    for (const preset of presets) {
      if (isPresetActive(preset)) return false
    }
    return true
  }

  const refreshPresets = async () => {
    if (!details) return
    try {
      setPresetsLoading(true)
      const res = await window.moddeck.getModPresets(gameId, details.characterFolder, details.folderName)
      setPresets(res)
    } catch {
      setPresets([])
    } finally {
      setPresetsLoading(false)
    }
  }

  const refreshStaticAnalysis = async () => {
    if (!details) return
    try {
      const analysis = await window.moddeck.analyzeModIni(
        gameId,
        details.characterFolder,
        details.folderName
      )
      setStaticAnalysis(analysis)
    } catch {
      setStaticAnalysis(null)
    }
  }

  const refreshSyncStatus = async () => {
    try {
      const status = await window.moddeck.getD3dxSyncStatus(gameId)
      setSyncStatus(status)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!details) {
      setPresets([])
      setStaticAnalysis(null)
      setDiagModalOpen(false)
      setShowSavePreset(false)
      setNewPresetName('')
      return
    }
    let cancelled = false
    setPresetsLoading(true)
    window.moddeck
      .getModPresets(gameId, details.characterFolder, details.folderName)
      .then((res) => {
        if (!cancelled) setPresets(res)
      })
      .catch(() => {
        if (!cancelled) setPresets([])
      })
      .finally(() => {
        if (!cancelled) setPresetsLoading(false)
      })

    window.moddeck
      .analyzeModIni(gameId, details.characterFolder, details.folderName)
      .then((res) => {
        if (!cancelled) setStaticAnalysis(res)
      })
      .catch(() => {
        if (!cancelled) setStaticAnalysis(null)
      })

    const unsubscribe = window.moddeck.onStateChanged((event) => {
      if (cancelled) return
      if (!event.gameId || event.gameId === gameId) {
        window.moddeck
          .getModPresets(gameId, details.characterFolder, details.folderName)
          .then((res) => {
            if (!cancelled) setPresets(res)
          })
          .catch(() => undefined)
        window.moddeck
          .analyzeModIni(gameId, details.characterFolder, details.folderName)
          .then((res) => {
            if (!cancelled) setStaticAnalysis(res)
          })
          .catch(() => undefined)
        void refreshSyncStatus()
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [gameId, details?.characterFolder, details?.folderName, details?.name])

  useEffect(() => {
    if (!showSavePreset) return
    void refreshSyncStatus()
    const timer = setInterval(() => {
      setSyncClockTick((tick) => tick + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [showSavePreset, gameId])

  async function handleSavePreset(syncF10?: boolean) {
    if (!details || savingPreset) return
    const name = newPresetName.trim()
    if (!name) {
      onNotify?.(t('preset.enterPresetNameErr'), 'err')
      return
    }
    if (isReservedDefaultPresetName(name)) {
      onNotify?.(t('preset.reservedDefaultNameErr'), 'err')
      return
    }
    setSavingPreset(true)
    try {
      const res = await window.moddeck.saveModPreset(
        gameId,
        details.characterFolder,
        details.folderName,
        name,
        syncF10 !== undefined ? { syncF10 } : undefined
      )
      if (res.ok) {
        onNotify?.(
          res.syncedF10
            ? t('preset.presetSyncedAndSaved', { name })
            : t('preset.presetSaved', { name }),
          'ok'
        )
        setNewPresetName('')
        setShowSavePreset(false)
        const updated = await window.moddeck.getModPresets(
          gameId,
          details.characterFolder,
          details.folderName
        )
        setPresets(updated)
      } else {
        const msg =
          res.duplicatePresetId === '__default__'
            ? t('preset.duplicateDefaultErr')
            : res.error || t('preset.presetSaveFailed')
        onNotify?.(msg, 'err')
      }
      void refreshSyncStatus()
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setSavingPreset(false)
    }
  }

  async function handleAddIgnoreRule(varName: string, scope: 'global' | 'local') {
    if (!details) return
    try {
      const res = await window.moddeck.addVariableIgnoreRule(
        varName,
        scope,
        scope === 'local'
          ? {
              gameId,
              characterFolder: details.characterFolder,
              modFolder: details.folderName
            }
          : undefined
      )
      if (res.ok) {
        onNotify?.(t('mod.diagIgnoreRuleAdded', { name: varName }), 'ok')
        await Promise.all([refreshPresets(), refreshStaticAnalysis()])
      } else if (res.error) {
        onNotify?.(res.error, 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  function requestApplyPreset(preset: ModVariantPreset) {
    if (isPresetActive(preset)) return
    if (hasUnsavedChanges()) {
      setConfirmPreset(preset)
      return
    }
    void handleApplyPreset(preset)
  }

  async function handleApplyPreset(preset: ModVariantPreset) {
    if (!details) return
    try {
      const res = await window.moddeck.applyModPreset(
        gameId,
        details.characterFolder,
        details.folderName,
        preset.id
      )
      if (res.ok) {
        onNotify?.(t('preset.presetSwitched', { name: preset.name }), 'ok')
        setConfirmPreset(null)
        onRefreshDetails?.()
        void refreshPresets()
      } else {
        onNotify?.(res.error || t('preset.presetSwitchFailed'), 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  async function handleDeletePreset(preset: ModVariantPreset) {
    if (!details) return
    try {
      const res = await window.moddeck.deleteModPreset(
        gameId,
        details.characterFolder,
        details.folderName,
        preset.id
      )
      if (res.ok) {
        onNotify?.(t('preset.presetDeleted', { name: preset.name }), 'info')
        setPresets((curr) => curr.filter((p) => p.id !== preset.id))
      } else {
        onNotify?.(res.error || t('preset.presetDeleteFailed'), 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  async function handleExportAllPresets() {
    if (!details) return
    try {
      const res = await window.moddeck.exportModPresets(
        gameId,
        details.characterFolder,
        details.folderName
      )
      if (res.ok) {
        onNotify?.(t('preset.exportModPresetSuccess', { path: res.filePath || '' }), 'ok')
      } else if (res.error && res.error !== t('dialog.canceled') && res.error !== '用户取消') {
        onNotify?.(res.error || t('preset.exportFailed'), 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  async function handleExportSinglePreset(preset: ModVariantPreset) {
    if (!details) return
    try {
      const res = await window.moddeck.exportModPresets(
        gameId,
        details.characterFolder,
        details.folderName,
        preset.id
      )
      if (res.ok) {
        onNotify?.(t('preset.exportModPresetSuccess', { path: res.filePath || '' }), 'ok')
      } else if (res.error && res.error !== t('dialog.canceled') && res.error !== '用户取消') {
        onNotify?.(res.error || t('preset.exportFailed'), 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  async function handleImportPreset() {
    if (!details) return
    try {
      const res = await window.moddeck.importModPresets(
        gameId,
        details.characterFolder,
        details.folderName
      )
      if (res.ok) {
        onNotify?.(
          t('preset.importModPresetSuccess', {
            count: res.count ?? 0,
            names: res.names?.join(', ') || ''
          }),
          'ok'
        )
        void refreshPresets()
      } else if (res.error && res.error !== t('dialog.canceled') && res.error !== '用户取消') {
        onNotify?.(res.error || t('preset.importModPresetFailed'), 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  async function handleDropImportPreset(filePath: string) {
    if (!details) return
    try {
      const res = await window.moddeck.importModPresetsFromPath(
        gameId,
        details.characterFolder,
        details.folderName,
        filePath
      )
      if (res.ok) {
        onNotify?.(
          t('preset.importModPresetSuccess', {
            count: res.count ?? 0,
            names: res.names?.join(', ') || ''
          }),
          'ok'
        )
        void refreshPresets()
      } else {
        onNotify?.(res.error || t('preset.importModPresetFailed'), 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  function handlePreviewDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onSetPreview) return
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (!previewDrag) setPreviewDrag(true)
  }

  function handlePreviewDragLeave(event: DragEvent<HTMLDivElement>) {
    event.stopPropagation()
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setPreviewDrag(false)
  }

  function handlePreviewDrop(event: DragEvent<HTMLDivElement>) {
    if (!onSetPreview) return
    event.preventDefault()
    event.stopPropagation()
    setPreviewDrag(false)
    const files = Array.from(event.dataTransfer.files)
    const imgFile = files.find((f) => IMAGE_FILE_PATTERN.test(f.name))
    const targetFile = imgFile ?? files[0]
    if (!targetFile) return
    const filePath = window.moddeck.getPathForFile(targetFile)
    if (filePath) {
      void onSetPreview(filePath)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) {
        void onSetPreview(reader.result)
      }
    }
    reader.readAsDataURL(targetFile)
  }

  function handlePanelDragOver(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'none'
  }

  function handlePanelDrop(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    setPreviewDrag(false)
  }

  return (
    <aside
      className="detail-panel"
      onDragOver={handlePanelDragOver}
      onDrop={handlePanelDrop}
    >
      <div className="detail-head">
        <strong>{t('mod.detailsTitle')}</strong>
        <button className="icon-btn" onClick={onClose} title={t('common.close')}>
          <Icon name="close" size={16} />
        </button>
      </div>

      {loading ? (
        <div className="detail-empty">
          <div className="spinner" />
          <span className="muted">{t('common.readingDirectory')}</span>
        </div>
      ) : error ? (
        <div className="detail-empty">
          <span className="error-text">{error}</span>
        </div>
      ) : details ? (
        <div className="detail-body">
          <div
            className={`detail-preview${onSetPreview ? ' is-interactive' : ''}${previewDrag ? ' is-drag-over' : ''}`}
            onClick={() => {
              if (onSetPreview) void onSetPreview()
            }}
            onDragOver={handlePreviewDragOver}
            onDragLeave={handlePreviewDragLeave}
            onDrop={handlePreviewDrop}
            title={onSetPreview ? t('preset.setModPreviewDrag') : undefined}
          >
            {details.previewUrl ? (
              <img src={details.previewUrl} alt="" />
            ) : (
              <div className="detail-preview-empty">
                <Icon name="image" size={28} />
                <span>{t('preset.setModPreviewDrop')}</span>
              </div>
            )}
            {onSetPreview ? (
              <div className="detail-preview-hint">
                <Icon name="upload" size={15} />
                <span>{previewDrag ? t('preset.setModPreviewDropActive') : t('preset.setModPreviewDrop')}</span>
              </div>
            ) : null}
          </div>

          <div className="detail-title" title={details.folderName}>
            <ScrollTitle text={details.name} className="detail-title-text" />
            <span className={`chip ${details.enabled ? 'ok' : ''}`}>
              {details.enabled ? t('mod.enabled') : t('mod.disabled')}
            </span>
          </div>

          <div className="detail-stats">
            <div>
              <span>{t('mod.files')}</span>
              <strong>{details.fileCount}</strong>
            </div>
            <div>
              <span>{t('mod.size')}</span>
              <strong>{formatBytes(details.sizeBytes)}</strong>
            </div>
            <div>
              <span>{t('mod.updated')}</span>
              <strong>{formatDate(details.updatedAt)}</strong>
            </div>
            <div>
              <span>{t('mod.ini')}</span>
              <strong>{details.iniFiles.length}</strong>
            </div>
          </div>

          {/* 2.2.1 Level 1: 单 Mod 专属预设与变体管理 */}
          <div
            className="detail-section"
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes('Files')) {
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'copy'
              }
            }}
            onDrop={async (e) => {
              if (!Array.from(e.dataTransfer.types).includes('Files')) return
              e.preventDefault()
              e.stopPropagation()
              const file = e.dataTransfer.files[0]
              const filePath = file ? await resolveDroppedFilePath(file) : ''
              if (filePath) {
                void handleDropImportPreset(filePath)
              }
            }}
          >
            <div className="detail-section-head">
              <span className="detail-section-title">{t('mod.presets')}</span>
              <div className="actions" style={{ gap: '6px' }}>
                <button
                  className="btn ghost small-btn"
                  onClick={() => void handleImportPreset()}
                  title={t('preset.importModPresetTooltip')}
                >
                  <Icon name="upload" size={13} />
                  {t('preset.importModPreset')}
                </button>
                <button
                  className="btn ghost small-btn"
                  onClick={() => setShowSavePreset(!showSavePreset)}
                  title={t('preset.saveAsModPresetTooltip')}
                >
                  <Icon name="plus" size={13} />
                  {showSavePreset ? t('common.cancel') : t('mod.saveAsNew')}
                </button>
              </div>
            </div>

            {showSavePreset ? (
              <div className="preset-save-wrap">
                <D3dxSyncBanner status={syncStatus} />
                <div className="preset-save-box">
                  <input
                    className="input preset-input"
                    placeholder={t('mod.presetNamePlaceholder')}
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
                    {savingPreset ? t('preset.syncAndSaveSaving') : t('common.save')}
                  </button>
                  <button
                    className="btn ghost small-btn"
                    disabled={savingPreset || !syncStatus?.gameRunning || (syncStatus?.pendingCount ?? 0) > 0}
                    onClick={() => void handleSavePreset(true)}
                    title={t('preset.syncAndSaveTooltip')}
                  >
                    {t('preset.syncAndSaveBtn')}
                  </button>
                </div>
              </div>
            ) : null}

            {presetsLoading ? (
              <div className="muted small">{t('common.loading')}</div>
            ) : presets.length === 0 ? (
              <div className="muted small">{t('mod.noPresets')}</div>
            ) : (
              <div className="detail-presets-list">
                {hasUnsavedChanges() ? (
                  <div
                    className="detail-preset-chip is-dirty"
                    title={t('preset.unsavedDirtyModTooltip')}
                  >
                    <div className="preset-apply-btn" style={{ cursor: 'default' }}>
                      <span className="preset-dot is-dirty" />
                      <span className="preset-name">{t('mod.unsavedInGame')}</span>
                    </div>
                  </div>
                ) : null}
                {presets.map((preset) => {
                  const active = isPresetActive(preset)
                  const pending = preset.isPending === true
                  const isDefault = preset.id === '__default__'
                  return (
                    <div
                      key={preset.id}
                      className={`detail-preset-chip${pending ? ' is-pending' : active ? ' is-active' : ''}${isDefault ? ' is-default' : ''}`}
                      onDoubleClick={() => setInspectingPreset(preset)}
                      title={t('preset.viewPresetDetailTooltip')}
                    >
                      <button
                        className="preset-apply-btn"
                        onClick={() => requestApplyPreset(preset)}
                        title={
                          pending
                            ? t('preset.presetQueuedF10', { name: preset.name })
                            : active
                              ? t('preset.presetCurrentActive', { name: preset.name })
                              : t('preset.presetClickToApply', { name: preset.name })
                        }
                      >
                        <span className="preset-dot" />
                        <span className="preset-name"><ScrollTitle text={(preset.id === '__default__' || preset.name === '默认' || preset.name === '默认 (初始)') ? t('preset.defaultPreset') : preset.name} /></span>
                      </button>
                      <button
                        className="icon-btn preset-info-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          setInspectingPreset(preset)
                        }}
                        title={t('preset.viewDetailsBtnTooltip')}
                      >
                        <Icon name="info" size={12} />
                      </button>
                      {!isDefault ? (
                        <>
                          <button
                            className="icon-btn preset-export-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleExportSinglePreset(preset)
                            }}
                            title={t('preset.exportSinglePresetTooltip')}
                          >
                            <Icon name="download" size={12} />
                          </button>
                          <button
                            className="icon-btn danger preset-del-btn"
                            onClick={() => void handleDeletePreset(preset)}
                            title={t('preset.deletePresetBtnTooltip')}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}

            {presets.filter((p) => p.id !== '__default__').length > 0 ? (
              <div className="detail-presets-footer">
                <button
                  className="btn ghost small-btn detail-export-all-btn"
                  onClick={() => void handleExportAllPresets()}
                  title={t('preset.exportModPresetTooltip')}
                >
                  <Icon name="download" size={12} />
                  {t('preset.exportAllModPresets')}
                </button>
              </div>
            ) : null}
          </div>

          <div className="detail-section">
            <div className="detail-section-title">{t('mod.hotkeys')}</div>
            {details.hotkeys.length === 0 ? (
              <div className="muted small">{t('mod.noHotkeys')}</div>
            ) : (
              <div className="detail-hotkeys">
                {details.hotkeys.slice(0, 100).map((hotkey, index) => {
                  const badge =
                    hotkey.hintKind === 'mouse'
                      ? t('mod.hotkeyMouseBadge')
                      : hotkey.hintKind
                        ? t('mod.hotkeyHoldBadge')
                        : null
                  const tip =
                    hotkey.hintKind === 'mouse'
                      ? `${hotkey.section} · ${t('mod.hotkeyMouseTip')}`
                      : hotkey.hintKind === 'modifier-hold'
                        ? `${hotkey.section} · ${t('mod.hotkeyModifierHoldTip')}`
                        : hotkey.hintKind === 'hold'
                          ? `${hotkey.section} · ${t('mod.hotkeyHoldTip')}`
                          : hotkey.section
                  return (
                    <div key={`${hotkey.section}-${index}`} title={tip}>
                      <div className="detail-hotkey-left">
                        <code>{hotkey.key}</code>
                        {badge ? <em className="hotkey-hint-badge">{badge}</em> : null}
                      </div>
                      <span className="muted">{hotkey.section}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="detail-section">
            <div className="detail-section-title">{t('mod.iniFiles')}</div>
            {details.iniFiles.length === 0 ? (
              <div className="muted small">{t('mod.noIni')}</div>
            ) : (
              <div className="detail-ini">
                {details.iniFiles.slice(0, 40).map((file) => (
                  <code key={file}>{file}</code>
                ))}
              </div>
            )}
          </div>

          {staticAnalysis ? (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">{t('mod.staticDiagTitle')}</span>
                <button
                  type="button"
                  className="btn ghost tiny-btn"
                  onClick={() => setDiagModalOpen(true)}
                >
                  <Icon name="info" size={12} />
                  {t('mod.diagViewDetails')}
                </button>
              </div>
              <div className="diag-summary-pills">
                <span className="chip">{t('mod.diagVarsCount', { count: staticAnalysis.variables.length })}</span>
                {staticAnalysis.variables.filter((v) => v.ignored).length > 0 ? (
                  <span className="chip">
                    {t('mod.diagIgnoredCount', {
                      count: staticAnalysis.variables.filter((v) => v.ignored).length
                    })}
                  </span>
                ) : null}
                <span className="chip">{t('mod.diagHashesCount', { count: staticAnalysis.hashes.length })}</span>
                {(() => {
                  const modHashSet = new Set(staticAnalysis.hashes.map((h) => h.hash))
                  const hitConflicts = conflicts.filter((c) => modHashSet.has(c.hash))
                  return hitConflicts.length > 0 ? (
                    <span className="tag warn">{t('character.hashConflictTag')} ({hitConflicts.length})</span>
                  ) : null
                })()}
              </div>

              {staticAnalysis.nonPersistControlVars.length > 0 ? (
                <div className="d3dx-sync-hint warn" style={{ marginTop: '8px' }}>
                  {t('mod.diagNonPersistWarn', {
                    count: staticAnalysis.nonPersistControlVars.length,
                    vars: staticAnalysis.nonPersistControlVars.slice(0, 4).map((v) => `$${v}`).join(', ')
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="detail-actions">
            <button
              className={`btn ${details.enabled ? 'ghost' : 'primary'}`}
              onClick={onToggle}
            >
              <Icon name={details.enabled ? 'close' : 'check'} size={details.enabled ? 14 : 15} />
              {details.enabled ? t('common.disable') : t('common.enable')}
            </button>
            <button className="btn ghost" onClick={onOpen}>
              <Icon name="folder" size={15} />
              {t('common.openFolder')}
            </button>
            <button className="btn ghost danger-text" onClick={onDelete}>
              <Icon name="trash" size={15} />
              {t('common.delete')}
            </button>
          </div>
        </div>
      ) : (
        <div className="detail-empty muted">{t('mod.selectToView')}</div>
      )}

      {diagModalOpen && staticAnalysis && details ? (
        <Modal
          title={`${t('mod.staticDiagTitle')} · ${details.name}`}
          onClose={() => setDiagModalOpen(false)}
          width={640}
          footer={
            <button className="btn primary" onClick={() => setDiagModalOpen(false)}>
              {t('common.close')}
            </button>
          }
        >
          <div className="diag-details-body diag-modal-body">
            <div className="diag-summary-pills" style={{ marginTop: 0 }}>
              <span className="chip">{t('mod.diagVarsCount', { count: staticAnalysis.variables.length })}</span>
              {staticAnalysis.variables.filter((v) => v.ignored).length > 0 ? (
                <span className="chip">
                  {t('mod.diagIgnoredCount', {
                    count: staticAnalysis.variables.filter((v) => v.ignored).length
                  })}
                </span>
              ) : null}
              <span className="chip">{t('mod.diagHashesCount', { count: staticAnalysis.hashes.length })}</span>
            </div>

            {staticAnalysis.hasLocalIgnoreFile ? (
              <div className="muted small">
                {t('mod.diagLocalIgnoreHint', { count: staticAnalysis.localIgnoreRules.length })}
              </div>
            ) : null}

            {staticAnalysis.variables.length > 0 ? (
              <div className="diag-subblock">
                <div className="muted small" style={{ fontWeight: 600 }}>
                  {t('mod.diagVarsTitle', { count: staticAnalysis.variables.length })}
                </div>
                <div className="diag-list diag-list-modal">
                  {staticAnalysis.variables.map((v) => (
                    <div key={v.key} className={`diag-item${v.ignored ? ' is-ignored' : ''}`}>
                      <div className="diag-item-main">
                        <code>${v.name}</code>
                        <span className={`tag ${v.persist ? 'ok' : 'warn'}`}>
                          {v.persist ? t('mod.diagPersistBadge') : t('mod.diagNonPersistBadge')}
                        </span>
                        {v.ignored ? (
                          <span className="tag">
                            {v.ignoreSource === 'local'
                              ? t('mod.diagSourceLocal')
                              : v.ignoreSource === 'global'
                                ? t('mod.diagSourceGlobal')
                                : t('mod.diagSourceBuiltin')}
                          </span>
                        ) : null}
                      </div>
                      <div className="diag-item-meta">
                        {v.drivenByKeys.length > 0 ? (
                          <span className="muted small">
                            {t('mod.diagDrivenBy', { keys: v.drivenByKeys.slice(0, 2).join(', ') })}
                          </span>
                        ) : null}
                        {v.linkedVars.length > 0 ? (
                          <span className="muted small">
                            {t('mod.diagLinkedWith', {
                              vars: v.linkedVars.slice(0, 3).map((x) => `$${x}`).join(', ')
                            })}
                          </span>
                        ) : null}
                        {!v.ignored ? (
                          <div className="diag-ignore-actions">
                            <button
                              type="button"
                              className="btn ghost tiny-btn"
                              onClick={() => void handleAddIgnoreRule(v.name, 'global')}
                            >
                              {t('mod.diagIgnoreGlobal')}
                            </button>
                            <button
                              type="button"
                              className="btn ghost tiny-btn"
                              onClick={() => void handleAddIgnoreRule(v.name, 'local')}
                            >
                              {t('mod.diagIgnoreLocal')}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {staticAnalysis.dependencies.length > 0 ? (
              <div className="diag-subblock">
                <div className="muted small" style={{ fontWeight: 600 }}>
                  {t('mod.diagDepsTitle', { count: staticAnalysis.dependencies.length })}
                </div>
                <div className="diag-list diag-list-modal">
                  {staticAnalysis.dependencies.map((dep, idx) => (
                    <div key={`${dep.triggerSection}-${dep.targetSection}-${idx}`} className="diag-dep-row">
                      <code>{dep.triggerSection}</code>
                      <span className="muted">→</span>
                      <code>{dep.targetSection}</code>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {staticAnalysis.hashes.length > 0 ? (
              <div className="diag-subblock">
                <div className="muted small" style={{ fontWeight: 600 }}>
                  {t('mod.diagHashesTitle', { count: staticAnalysis.hashes.length })}
                </div>
                <div className="diag-list diag-list-modal">
                  {staticAnalysis.hashes.map((item, idx) => {
                    const hit = conflicts.find((c) => c.hash === item.hash)
                    const others = hit
                      ? hit.mods.filter((m) => m.folderName !== details.folderName).map((m) => m.name)
                      : []
                    return (
                      <div key={`${item.hash}-${item.section}-${idx}`} className="diag-hash-row">
                        <code>{item.hash}</code>
                        <span className="tag">{item.kind}</span>
                        <span className="muted small">{item.section}</span>
                        {others.length > 0 ? (
                          <span className="tag warn">
                            {t('mod.diagOverlapWith', { mods: others.join(', ') })}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {inspectingPreset ? (
        <PresetDetailModal
          preset={inspectingPreset}
          onClose={() => setInspectingPreset(null)}
          onAddIgnoreRule={handleAddIgnoreRule}
        />
      ) : null}
      {confirmPreset ? (
        <Modal
          title={t('mod.overwriteConfirmTitle')}
          onClose={() => setConfirmPreset(null)}
          width={400}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmPreset(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn primary"
                onClick={() => void handleApplyPreset(confirmPreset)}
              >
                {t('common.confirm')}
              </button>
            </>
          }
        >
          <div className="danger-confirm-dialog">
            <p>
              {t('preset.dirtyConfirmDesc1')}
            </p>
            <p className="muted small">
              {t('preset.dirtyConfirmDesc2', { name: confirmPreset.name })}
            </p>
          </div>
        </Modal>
      ) : null}
    </aside>
  )
}
