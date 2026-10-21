import { useState } from 'react'
import type { CharacterKind, CreateCharacterInput, GameDef } from '../../../shared/types'
import { Icon } from './Icon'
import { Modal } from './Modal'

function folderFromName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function CreateCharacterModal({
  game,
  existingFolders,
  onClose,
  onCreate
}: {
  game: GameDef
  existingFolders: string[]
  onClose: () => void
  onCreate: (input: CreateCharacterInput) => Promise<void>
}) {
  const [kind, setKind] = useState<CharacterKind>('character')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [folderTouched, setFolderTouched] = useState(false)
  const [aliases, setAliases] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function changeName(value: string) {
    setName(value)
    if (!folderTouched) setFolder(folderFromName(value))
  }

  async function create() {
    const finalFolder = folder.trim()
    if (!finalFolder) {
      setError('请填写目录名')
      return
    }
    if (finalFolder.startsWith('.') || finalFolder.startsWith('_')) {
      setError('目录名不能以 . 或 _ 开头')
      return
    }
    if (/[\\/:*?"<>|]/.test(finalFolder)) {
      setError('目录名不能包含 \\ / : * ? " < > |')
      return
    }
    if (
      existingFolders.some((item) => item.toLowerCase() === finalFolder.toLowerCase())
    ) {
      setError('同名目录已存在')
      return
    }

    setCreating(true)
    setError(null)
    try {
      await onCreate({
        folder: finalFolder,
        displayName: name.trim() || finalFolder,
        aliases: aliases
          .split(/[,，;；\n]/)
          .map((item) => item.trim())
          .filter(Boolean),
        kind
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      title="新增目录"
      onClose={onClose}
      footer={
        <>
          <div className="grow" />
          <button className="btn ghost" onClick={onClose} disabled={creating}>
            取消
          </button>
          <button className="btn primary" onClick={create} disabled={creating}>
            {creating ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <div className="segmented">
        <button
          className={kind === 'character' ? 'active' : ''}
          onClick={() => setKind('character')}
        >
          <Icon name="userPlus" size={15} />
          新角色
        </button>
        <button
          className={kind === 'utility' ? 'active' : ''}
          onClick={() => setKind('utility')}
        >
          <Icon name="box" size={15} />
          功能 Mod 目录
        </button>
      </div>
      <p className="muted small">
        {kind === 'character'
          ? `在 ${game.name} 的 Mods 下创建一个角色目录，之后再往里面放 Mod。`
          : '功能 Mod 目录用于存放不属于某个角色的通用 Mod；管理方式和角色一样。'}
      </p>

      <label className="field">
        <span>显示名称</span>
        <input
          className="input"
          value={name}
          onChange={(event) => changeName(event.target.value)}
          placeholder={kind === 'character' ? '例如 新角色' : '例如 通用功能'}
          autoFocus
        />
      </label>
      <label className="field">
        <span>目录名（会创建在 Mods 目录下）</span>
        <input
          className="input"
          value={folder}
          onChange={(event) => {
            setFolder(event.target.value)
            setFolderTouched(true)
          }}
          placeholder="例如 NewCharacter"
        />
      </label>
      <label className="field">
        <span>别名（可选，用逗号分隔）</span>
        <input
          className="input"
          value={aliases}
          onChange={(event) => setAliases(event.target.value)}
          placeholder="用于搜索"
        />
      </label>
      <p className="muted small">
        目录名创建后不会自动改名；封面可以在创建后点角色卡片的“编辑”里设置。
      </p>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  )
}
