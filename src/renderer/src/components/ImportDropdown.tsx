import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useI18n } from '../i18n'

interface ImportDropdownProps {
  label?: string
  onImport: () => void
  onImportFolder: () => void
  className?: string
}

export function ImportDropdown({
  label,
  onImport,
  onImportFolder,
  className = ''
}: ImportDropdownProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const displayLabel = label || t('library.importMod')

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
    return undefined
  }, [open])

  return (
    <div ref={containerRef} className={`import-split-group ${className}`}>
      <button
        type="button"
        className="btn primary import-main-btn"
        onClick={() => {
          setOpen(false)
          onImport()
        }}
        title={t('library.importArchive')}
      >
        <Icon name="upload" size={15} />
        <span>{displayLabel}</span>
      </button>

      <button
        type="button"
        className={`btn primary import-caret-btn${open ? ' is-active' : ''}`}
        onClick={() => setOpen(!open)}
        title={t('library.importMod')}
      >
        <span className="import-caret">▾</span>
      </button>

      {open && (
        <div className="import-menu-popover">
          <button
            type="button"
            className="import-menu-item"
            onClick={() => {
              setOpen(false)
              onImport()
            }}
          >
            <Icon name="upload" size={14} />
            <span>{t('library.importArchive')}</span>
          </button>
          <button
            type="button"
            className="import-menu-item"
            onClick={() => {
              setOpen(false)
              onImportFolder()
            }}
          >
            <Icon name="folder" size={14} />
            <span>{t('library.importFolder')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
