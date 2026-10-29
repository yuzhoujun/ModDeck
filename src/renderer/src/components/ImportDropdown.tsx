import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

interface ImportDropdownProps {
  label?: string
  onImport: () => void
  onImportFolder: () => void
  className?: string
}

export function ImportDropdown({
  label = '导入 Mod',
  onImport,
  onImportFolder,
  className = ''
}: ImportDropdownProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

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
        title="导入 Mod 压缩包（.zip / .7z / .rar）"
      >
        <Icon name="upload" size={15} />
        <span>{label}</span>
      </button>

      <button
        type="button"
        className={`btn primary import-caret-btn${open ? ' is-active' : ''}`}
        onClick={() => setOpen(!open)}
        title="选择导入方式（压缩包 / 文件夹）"
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
            <span>导入压缩包 (.zip / .7z / .rar)</span>
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
            <span>导入 Mod 文件夹</span>
          </button>
        </div>
      )}
    </div>
  )
}
