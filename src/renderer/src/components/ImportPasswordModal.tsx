import { useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { useI18n } from '../i18n'

export interface PasswordPromptItem {
  source: string
  sourcePath: string
  wrongPassword: boolean
}

export function ImportPasswordModal({
  items,
  submitting,
  canSkip,
  onCancel,
  onSkipAll,
  onSubmit
}: {
  items: PasswordPromptItem[]
  submitting: boolean
  canSkip: boolean
  onCancel: () => void
  onSkipAll: () => void
  onSubmit: (passwords: Record<string, string>) => Promise<void>
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const allFilled =
    items.length > 0 && items.every((item) => (values[item.sourcePath] || '').length > 0)

  async function handleSubmit() {
    if (!allFilled || submitting) return
    await onSubmit(values)
  }

  return (
    <Modal
      title={t('importModal.passwordTitle')}
      onClose={() => {
        if (!submitting) onCancel()
      }}
      width={500}
      footer={
        <>
          {canSkip ? (
            <button className="btn ghost" onClick={onSkipAll} disabled={submitting}>
              {t('importModal.skipEncrypted')}
            </button>
          ) : null}
          <div className="grow" />
          <button className="btn ghost" onClick={onCancel} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            onClick={() => void handleSubmit()}
            disabled={submitting || !allFilled}
          >
            <Icon name="check" size={15} />
            {t('importModal.retryExtract')}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('importModal.passwordDesc')}
      </p>
      <div className="import-password-list">
        {items.map((item, idx) => {
          const show = Boolean(revealed[item.sourcePath])
          return (
            <div key={item.sourcePath} className="import-password-item">
              <div className="import-password-name" title={item.sourcePath}>
                <strong>{item.source}</strong>
                {item.wrongPassword ? (
                  <span className="tag warn">{t('importModal.wrongPasswordHint')}</span>
                ) : null}
              </div>
              <div className="import-password-input-row">
                <input
                  className="input"
                  type={show ? 'text' : 'password'}
                  placeholder={t('importModal.passwordPlaceholder')}
                  value={values[item.sourcePath] || ''}
                  onChange={(e) => {
                    const v = e.target.value
                    setValues((prev) => ({ ...prev, [item.sourcePath]: v }))
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSubmit()
                  }}
                  disabled={submitting}
                  autoFocus={idx === 0}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() =>
                    setRevealed((prev) => ({ ...prev, [item.sourcePath]: !prev[item.sourcePath] }))
                  }
                  title={show ? t('importModal.hidePassword') : t('importModal.showPassword')}
                  tabIndex={-1}
                >
                  <Icon name={show ? 'eyeOff' : 'eye'} size={15} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
