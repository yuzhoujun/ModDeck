import { ScrollTitle } from './ScrollTitle'
import type { ModVariantPreset } from '../../../shared/types'
import { Modal } from './Modal'

export function PresetDetailModal({
  preset,
  onClose
}: {
  preset: ModVariantPreset
  onClose: () => void
}) {
  const vars = preset.variables ? Object.entries(preset.variables) : []

  return (
    <Modal
      title={`预设详情 · ${preset.name}`}
      onClose={onClose}
      width={520}
      footer={
        <div className="actions right">
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      <div className="preset-detail-dialog">
        <div className="preset-detail-summary">
          <div>
            <span className="muted small">所属 Mod</span>
            <div style={{ marginTop: 2, fontWeight: 600 }}><ScrollTitle text={preset.modName} /></div>
          </div>
          <div>
            <span className="muted small">预设类型</span>
            <span className="chip ok">{preset.id === '__default__' ? '出厂默认' : '自定义快照'}</span>
          </div>
        </div>

        <div className="detail-section" style={{ marginTop: '12px' }}>
          <div className="detail-section-title">
            3DMigoto / XXMI 变量快照 ({vars.length})
          </div>
          {vars.length === 0 ? (
            <div className="muted small" style={{ padding: '8px 0' }}>
              此 Mod 未声明运行时 persist 变量，仅包含实体 ini 文件切换。
            </div>
          ) : (
            <div className="preset-vars-table">
              <div className="preset-var-row head">
                <span>变量名 (Key)</span>
                <span>设定值 (Value)</span>
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
            激活的 INI 文件 ({preset.activeIniFiles.length})
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
