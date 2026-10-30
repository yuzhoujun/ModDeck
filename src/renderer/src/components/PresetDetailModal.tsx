import { ScrollTitle } from './ScrollTitle'
import type { ModVariantPreset } from '../../../shared/types'
import { Modal } from './Modal'
import { useI18n } from '../i18n'

export function PresetDetailModal({
  preset,
  onClose
}: {
  preset: ModVariantPreset
  onClose: () => void
}) {
  const { t } = useI18n()
  const vars = preset.variables ? Object.entries(preset.variables) : []

  return (
    <Modal
      title={t('preset.detailTitle', { name: preset.name })}
      onClose={onClose}
      width={520}
      footer={
        <div className="actions right">
          <button className="btn primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      }
    >
      <div className="preset-detail-dialog">
        <div className="preset-detail-summary">
          <div>
            <span className="muted small">{t('preset.belongsToMod')}</span>
            <div style={{ marginTop: 2, fontWeight: 600 }}><ScrollTitle text={preset.modName} /></div>
          </div>
          <div>
            <span className="muted small">{t('preset.presetType')}</span>
            <span className="chip ok">{preset.id === '__default__' ? t('preset.typeDefault') : t('preset.typeCustom')}</span>
          </div>
        </div>

        <div className="detail-section" style={{ marginTop: '12px' }}>
          <div className="detail-section-title">
            {t('preset.varSnapshotTitle', { count: vars.length })}
          </div>
          {vars.length === 0 ? (
            <div className="muted small" style={{ padding: '8px 0' }}>
              {t('preset.noVarsNotice')}
            </div>
          ) : (
            <div className="preset-vars-table">
              <div className="preset-var-row head">
                <span>{t('preset.varKeyLabel')}</span>
                <span>{t('preset.varValLabel')}</span>
              </div>
              {vars.map(([k, v]) => {
                // 美化展示：提取末级变量名
                const parts = k.split('\\')
                const shortName = parts[parts.length - 1] || k
                return (
                  <div key={k} className="preset-var-row" title={k}>
                    <div className="var-col-key">
                      <code>${shortName}</code>
                      <span className="muted small">{k}</span>
                    </div>
                    <div className="var-col-val">
                      <span className="chip">{v}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="detail-section" style={{ marginTop: '14px' }}>
          <div className="detail-section-title">
            {t('preset.activeIniTitle', { count: preset.activeIniFiles.length })}
          </div>
          <div className="detail-ini" style={{ maxHeight: '100px' }}>
            {preset.activeIniFiles.map((file) => (
              <code key={file}>{file}</code>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
