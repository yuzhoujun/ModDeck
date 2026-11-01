import { useState } from 'react'
import type { RosterSchemeImportInspection } from '../../../shared/types'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ScrollTitle } from './ScrollTitle'
import { useI18n } from '../i18n'

export function ImportSchemeModal({
  inspection,
  onConfirm,
  onClose,
  loading = false
}: {
  inspection: RosterSchemeImportInspection
  onConfirm: (customName: string) => Promise<void>
  onClose: () => void
  loading?: boolean
}) {
  const { t } = useI18n()
  const [schemeName, setSchemeName] = useState(inspection.schemeName || '')
  const [activeTab, setActiveTab] = useState<'matched' | 'missing'>('matched')

  const isCrossGame = inspection.sourceGameId && inspection.targetGameId && inspection.sourceGameId !== inspection.targetGameId
  const matchRate = inspection.totalMods > 0
    ? Math.round((inspection.matchedMods / inspection.totalMods) * 100)
    : 100

  return (
    <Modal
      title={t('preset.importSchemeModalTitle')}
      onClose={onClose}
      width={680}
      footer={
        <div className="modal-foot-between">
          <div className="muted small">
            {t('preset.importMatchSummary', {
              matched: inspection.matchedMods,
              total: inspection.totalMods,
              rate: matchRate
            })}
          </div>
          <div className="actions" style={{ gap: '8px' }}>
            <button className="btn ghost" onClick={onClose} disabled={loading}>
              {t('common.cancel')}
            </button>
            <button
              className="btn primary"
              onClick={() => void onConfirm(schemeName.trim())}
              disabled={loading || !schemeName.trim()}
            >
              <Icon name="check" size={14} />
              {loading ? t('common.importing') : t('preset.confirmImportScheme')}
            </button>
          </div>
        </div>
      }
    >
      <div className="import-scheme-modal-body">
        {/* 方案名称编辑 */}
        <div className="setting-group-box" style={{ marginBottom: '14px', padding: '12px 14px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9', marginBottom: '6px' }}>
            {t('preset.schemeNameLabel')}
          </div>
          <input
            className="input"
            value={schemeName}
            onChange={(e) => setSchemeName(e.target.value)}
            placeholder={t('preset.schemeNamePlaceholder')}
            autoFocus
          />
        </div>

        {/* 跨游戏导入警示 */}
        {isCrossGame ? (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              background: 'rgba(234, 179, 8, 0.12)',
              border: '1px solid rgba(234, 179, 8, 0.35)',
              color: '#fef08a',
              fontSize: '12px',
              marginBottom: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <span style={{ fontSize: '15px' }}>⚠️</span>
            <span>
              {t('preset.crossGameWarning', {
                source: inspection.sourceGameId?.toUpperCase() || '',
                target: inspection.targetGameId?.toUpperCase() || ''
              })}
            </span>
          </div>
        ) : null}

        {/* 统计卡片网格 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: '10px',
            marginBottom: '14px'
          }}
        >
          <div className="import-scheme-stat-card">
            <div className="stat-label">{t('preset.statCharacters')}</div>
            <div className="stat-value">
              {inspection.matchedCharacters}
              <span className="stat-sub"> / {inspection.totalCharacters}</span>
            </div>
          </div>
          <div className="import-scheme-stat-card">
            <div className="stat-label">{t('preset.statMods')}</div>
            <div className="stat-value">
              {inspection.matchedMods}
              <span className="stat-sub"> / {inspection.totalMods}</span>
            </div>
          </div>
          <div className="import-scheme-stat-card">
            <div className="stat-label">{t('preset.statMatchRate')}</div>
            <div
              className="stat-value"
              style={{ color: matchRate >= 80 ? '#34d399' : matchRate >= 50 ? '#fbbf24' : '#f87171' }}
            >
              {matchRate}%
            </div>
          </div>
        </div>

        {/* 选项卡切换 */}
        <div className="tab-group" style={{ marginBottom: '10px' }}>
          <button
            className={`tab-btn${activeTab === 'matched' ? ' active' : ''}`}
            onClick={() => setActiveTab('matched')}
          >
            {t('preset.tabMatchedMods')} ({inspection.matchedItems.length})
          </button>
          <button
            className={`tab-btn${activeTab === 'missing' ? ' active' : ''}`}
            onClick={() => setActiveTab('missing')}
          >
            {t('preset.tabMissingMods')} ({inspection.missingMods.length})
          </button>
        </div>

        {/* 内容展示区 */}
        <div className="import-scheme-list-box">
          {activeTab === 'matched' ? (
            inspection.matchedItems.length === 0 ? (
              <div className="muted small center" style={{ padding: '24px' }}>
                {t('preset.noMatchedMods')}
              </div>
            ) : (
              <div className="import-scheme-items-grid">
                {inspection.matchedItems.map((item, idx) => (
                  <div key={`${item.characterFolder}-${item.modName}-${idx}`} className="import-scheme-item-row is-matched">
                    <span className="item-char-badge">{item.characterFolder}</span>
                    <span className="item-mod-name" title={item.modName}>
                      <ScrollTitle text={item.modName} />
                    </span>
                    {item.presetName ? (
                      <span className="item-preset-badge" title={item.presetName}>
                        🎯 {item.presetName}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : inspection.missingMods.length === 0 ? (
            <div className="muted small center" style={{ padding: '24px', color: '#34d399' }}>
              ✓ {t('preset.allModsMatched')}
            </div>
          ) : (
            <div className="import-scheme-items-grid">
              {inspection.missingMods.map((item, idx) => (
                <div key={`${item.characterFolder}-${item.modName}-${idx}`} className="import-scheme-item-row is-missing">
                  <span className="item-char-badge missing">{item.characterFolder}</span>
                  <span className="item-mod-name missing" title={item.modName}>
                    <ScrollTitle text={item.modName} />
                  </span>
                  <span className="item-status-tag">{t('preset.modNotInstalled')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
