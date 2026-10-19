import { useState } from 'react'
import type { CharacterInfo } from '../../../shared/types'
import { Modal } from './Modal'

export function EditCharacterModal({
  character,
  onClose,
  onSave,
  onReset
}: {
  character: CharacterInfo
  onClose: () => void
  onSave: (patch: { displayName?: string; aliases?: string[]; order?: number }) => Promise<void>
  onReset: () => Promise<void>
}) {
  const [name, setName] = useState(character.displayName)
  const [aliases, setAliases] = useState(character.aliases.join('，'))
  const [order, setOrder] = useState(
    character.order === Number.MAX_SAFE_INTEGER ? '' : String(character.order)
  )
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await onSave({
        displayName: name.trim() || character.folder,
        aliases: aliases
          .split(/[,，;；\n]/)
          .map((item) => item.trim())
          .filter(Boolean),
        order: order.trim() ? Number(order) : undefined
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="编辑角色"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onReset} disabled={saving}>
            恢复默认
          </button>
          <div className="grow" />
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            保存
          </button>
        </>
      }
    >
      <label className="field">
        <span>显示名称</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={character.folder}
        />
      </label>
      <label className="field">
        <span>别名（用逗号分隔，用于搜索和合并中英日名）</span>
        <input
          className="input"
          value={aliases}
          onChange={(event) => setAliases(event.target.value)}
          placeholder="例如 Aemeath，爱弥斯"
        />
      </label>
      <label className="field">
        <span>排序权重（越小越靠前，可留空）</span>
        <input
          className="input"
          value={order}
          onChange={(event) => setOrder(event.target.value)}
          inputMode="numeric"
        />
      </label>
      <p className="muted small">
        目录名 <code>{character.folder}</code> 不会改变，只影响显示和搜索。
      </p>
    </Modal>
  )
}
