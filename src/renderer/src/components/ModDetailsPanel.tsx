import { useEffect, useState, type DragEvent } from 'react'
import type { GameId, ModDetails, ModVariantPreset } from '../../../shared/types'
import { formatDate } from '../utils'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PresetDetailModal } from './PresetDetailModal'
import { ScrollTitle } from './ScrollTitle'
import { useI18n } from '../i18n'

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

  useEffect(() => {
    if (!details) {
      setPresets([])
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

    const unsubscribe = window.moddeck.onStateChanged((event) => {
      if (cancelled) return
      if (!event.gameId || event.gameId === gameId) {
        window.moddeck
          .getModPresets(gameId, details.characterFolder, details.folderName)
          .then((res) => {
            if (!cancelled) setPresets(res)
          })
          .catch(() => undefined)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [gameId, details?.characterFolder, details?.folderName, details?.name])

  async function handleSavePreset() {
    if (!details) return
    const name = newPresetName.trim()
    if (!name) {
      onNotify?.('请输入预设名称', 'err')
      return
    }
    try {
      const res = await window.moddeck.saveModPreset(
        gameId,
        details.characterFolder,
        details.folderName,
        name
      )
      if (res.ok) {
        onNotify?.(`已保存预设「${name}」`, 'ok')
        setNewPresetName('')
        setShowSavePreset(false)
        const updated = await window.moddeck.getModPresets(
          gameId,
          details.characterFolder,
          details.folderName
        )
        setPresets(updated)
      } else {
        onNotify?.(res.error || '保存预设失败', 'err')
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
        onNotify?.(`已切换至预设「${preset.name}」`, 'ok')
        setConfirmPreset(null)
        onRefreshDetails?.()
        void refreshPresets()
      } else {
        onNotify?.(res.error || '切换预设失败', 'err')
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
        onNotify?.(`已删除预设「${preset.name}」`, 'info')
        setPresets((curr) => curr.filter((p) => p.id !== preset.id))
      } else {
        onNotify?.(res.error || '删除预设失败', 'err')
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
    }
  }

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <strong>{t('mod.detailsTitle')}</strong>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <Icon name="close" size={16} />
        </button>
      </div>

      {loading ? (
        <div className="detail-empty">
          <div className="spinner" />
          <span className="muted">读取目录…</span>
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
            title={onSetPreview ? '点击或拖入图片更换该 Mod 的预览图' : undefined}
          >
            {details.previewUrl ? (
              <img src={details.previewUrl} alt="" />
            ) : (
              <div className="detail-preview-empty">
                <Icon name="image" size={28} />
                <span>点击或拖入图片设置预览图</span>
              </div>
            )}
            {onSetPreview ? (
              <div className="detail-preview-hint">
                <Icon name="upload" size={15} />
                <span>{previewDrag ? '松开保存为 Mod 预览图' : '点击或拖入图片更换预览图'}</span>
              </div>
            ) : null}
          </div>

          <div className="detail-title">
            <ScrollTitle text={details.name} className="detail-title-text" />
            <span className={`chip ${details.enabled ? 'ok' : ''}`}>
              {details.enabled ? '已启用' : '已禁用'}
            </span>
          </div>
          <div className="detail-path" title={details.folderName}>
            .../{details.characterFolder}/{details.folderName}
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
          <div className="detail-section">
            <div className="detail-section-head">
              <span className="detail-section-title">{t('mod.presets')}</span>
              <button
                className="btn ghost small-btn"
                onClick={() => setShowSavePreset(!showSavePreset)}
                title="将当前配置保存为该 Mod 的独立预设"
              >
                <Icon name="plus" size={13} />
                {showSavePreset ? t('common.cancel') : t('mod.saveAsNew')}
              </button>
            </div>

            {showSavePreset ? (
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
                <button className="btn primary small-btn" onClick={() => void handleSavePreset()}>
                  {t('common.save')}
                </button>
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
                    title="检测到实机参数已发生自定义修改，未匹配任何已保存预设。点击右上角『存为预设』可将其持久化保存。"
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
                      title="双击查看预设参数详情"
                    >
                      <button
                        className="preset-apply-btn"
                        onClick={() => requestApplyPreset(preset)}
                        title={
                          pending
                            ? `「${preset.name}」已排队待生效，按 F10 立即刷新实机画面`
                            : active
                              ? `当前正处于「${preset.name}」（双击查看详情）`
                              : `点击应用「${preset.name}」（双击查看详情）`
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
                        title="查看预设详情"
                      >
                        <Icon name="info" size={12} />
                      </button>
                      {!isDefault ? (
                        <button
                          className="icon-btn danger preset-del-btn"
                          onClick={() => void handleDeletePreset(preset)}
                          title="删除该预设"
                        >
                          <Icon name="close" size={12} />
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="detail-section">
            <div className="detail-section-title">{t('mod.hotkeys')}</div>
            {details.hotkeys.length === 0 ? (
              <div className="muted small">{t('mod.noHotkeys')}</div>
            ) : (
              <div className="detail-hotkeys">
                {details.hotkeys.slice(0, 30).map((hotkey, index) => (
                  <div key={`${hotkey.section}-${index}`}>
                    <code>{hotkey.key}</code>
                    <span className="muted">{hotkey.section}</span>
                  </div>
                ))}
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

          <div className="detail-actions">
            <button className="btn primary" onClick={onToggle}>
              <Icon name="check" size={15} />
              {details.enabled ? t('common.disabled') : t('common.enabled')}
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

      {inspectingPreset ? (
        <PresetDetailModal
          preset={inspectingPreset}
          onClose={() => setInspectingPreset(null)}
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
              检测到当前变体状态已有<strong>未保存的改动</strong>。
            </p>
            <p className="muted small">
              如果继续切换至「{confirmPreset.name}」，当前未存为预设的 ini
              改动将被直接覆盖。是否确定继续？
            </p>
          </div>
        </Modal>
      ) : null}
    </aside>
  )
}
