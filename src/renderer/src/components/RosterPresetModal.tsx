import { useEffect, useState } from 'react'
import type {
  CharacterInfo,
  GameDef,
  GameSnapshot,
  ModInfo,
  RosterPreset
} from '../../../shared/types'
import { Icon } from './Icon'
import { Modal } from './Modal'

export function RosterPresetModal({
  game,
  snapshot,
  onClose,
  onNotify
}: {
  game: GameDef
  snapshot: GameSnapshot
  onClose: () => void
  onNotify?: (text: string, kind?: 'ok' | 'err' | 'info') => void
}) {
  const [presets, setPresets] = useState<RosterPreset[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [characterModsMap, setCharacterModsMap] = useState<Record<string, ModInfo[]>>({})
  const [selectedAssignments, setSelectedAssignments] = useState<
    Record<string, { modName: string }>
  >({})
  const [charFilter, setCharFilter] = useState('')
  const [activePresetId, setActivePresetId] = useState<string | null>(null)

  // 1. 加载已有方案列表
  const fetchPresets = async () => {
    try {
      setLoading(true)
      const list = await window.moddeck.getRosterPresets(game.id)
      setPresets(list)
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setLoading(false)
    }
  }

  // 2. 加载各角色的 Mod 列表以供配置选择
  const fetchCharacterMods = async () => {
    const map: Record<string, ModInfo[]> = {}
    const currentAssignments: Record<string, { modName: string }> = {}

    for (const char of snapshot.characters) {
      if (char.modCount === 0) continue
      try {
        const list = await window.moddeck.getMods(game.id, char.folder)
        map[char.folder] = list
        // 自动提取当前正激活的 Mod（若有）
        const enabledMod = list.find((m) => m.enabled)
        if (enabledMod) {
          currentAssignments[char.folder] = { modName: enabledMod.name }
        }
      } catch {
        // ignore
      }
    }
    setCharacterModsMap(map)
    setSelectedAssignments(currentAssignments)
  }

  useEffect(() => {
    void fetchPresets()
    void fetchCharacterMods()
  }, [game.id])

  // 保存新方案
  const handleSavePreset = async () => {
    const name = presetName.trim()
    if (!name) {
      onNotify?.('请输入预设方案名称', 'err')
      return
    }
    try {
      setSaving(true)
      const res = await window.moddeck.saveRosterPreset(game.id, {
        name,
        assignments: selectedAssignments
      })
      if (res.ok) {
        onNotify?.(`已保存预设方案「${name}」`, 'ok')
        setPresetName('')
        setShowCreateForm(false)
        await fetchPresets()
      } else {
        onNotify?.(res.error || '保存失败', 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setSaving(false)
    }
  }

  // 应用方案
  const handleApplyPreset = async (preset: RosterPreset) => {
    try {
      const res = await window.moddeck.applyRosterPreset(game.id, preset.id)
      if (res.ok) {
        setActivePresetId(preset.id)
        onNotify?.(`已切换至预设方案「${preset.name}」`, 'ok')
      } else {
        onNotify?.(res.error || '切换方案失败', 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  // 删除方案
  const handleDeletePreset = async (preset: RosterPreset) => {
    try {
      const res = await window.moddeck.deleteRosterPreset(game.id, preset.id)
      if (res.ok) {
        onNotify?.(`已删除预设方案「${preset.name}」`, 'info')
        if (activePresetId === preset.id) setActivePresetId(null)
        await fetchPresets()
      } else {
        onNotify?.(res.error || '删除方案失败', 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  const validCharacters = snapshot.characters.filter((c) => {
    if (c.modCount === 0) return false
    if (!charFilter) return true
    const q = charFilter.toLowerCase()
    return (
      c.displayName.toLowerCase().includes(q) ||
      c.folder.toLowerCase().includes(q) ||
      (c.aliases && c.aliases.some((a) => a.toLowerCase().includes(q)))
    )
  })

  return (
    <Modal
      title={`角色池预设方案管理 · ${game.shortName}`}
      onClose={onClose}
      width={780}
      footer={
        <div className="modal-foot-between">
          <div className="muted small">
            预设只记录各角色激活配置，毫秒级快速切换，绝不复制实体文件。
          </div>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      <div className="roster-preset-modal-content">
        {/* 顶部方案栏 */}
        <div className="roster-presets-bar">
          <div className="roster-presets-bar-head">
            <strong>已存方案 ({presets.length})</strong>
            <button
              className="btn small-btn primary"
              onClick={() => setShowCreateForm(!showCreateForm)}
            >
              <Icon name="plus" size={14} />
              {showCreateForm ? '取消' : '存为新方案'}
            </button>
          </div>

          {showCreateForm ? (
            <div className="roster-save-box">
              <input
                className="input"
                placeholder="输入方案名称（如：深渊作战组、清凉夏日等）"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSavePreset()
                }}
                autoFocus
              />
              <button
                className="btn primary small-btn"
                disabled={saving}
                onClick={() => void handleSavePreset()}
              >
                {saving ? '保存中…' : '保存当前配置'}
              </button>
            </div>
          ) : null}

          <div className="roster-presets-chips">
            {loading ? (
              <span className="muted small">加载预设中…</span>
            ) : presets.length === 0 ? (
              <span className="muted small">暂无方案，请先勾选下方角色 Mod 后点击右上角存为新方案</span>
            ) : (
              presets.map((p) => {
                const isActive = activePresetId === p.id
                return (
                  <div
                    key={p.id}
                    className={`roster-preset-chip${isActive ? ' is-active' : ''}`}
                  >
                    <button
                      className="roster-preset-chip-btn"
                      onClick={() => void handleApplyPreset(p)}
                      title={`一键应用「${p.name}」并刷新`}
                    >
                      <span className="preset-dot" />
                      <span>{p.name}</span>
                      <span className="muted small">
                        ({Object.keys(p.assignments).length} 人)
                      </span>
                    </button>
                    <button
                      className="icon-btn danger preset-del-btn"
                      onClick={() => void handleDeletePreset(p)}
                      title="删除该方案"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* 角色与 Mod 互斥单选区域 */}
        <div className="roster-config-section">
          <div className="roster-config-head">
            <strong>角色 Mod 方案配置（单选互斥保护）</strong>
            <input
              className="input roster-search-input"
              placeholder="快速过滤角色…"
              value={charFilter}
              onChange={(e) => setCharFilter(e.target.value)}
            />
          </div>

          <div className="roster-characters-grid">
            {validCharacters.map((char) => {
              const charMods = characterModsMap[char.folder] || []
              const currentChoice = selectedAssignments[char.folder]?.modName

              return (
                <div key={char.folder} className="roster-char-card">
                  <div className="roster-char-head">
                    <span className="roster-char-name">{char.displayName}</span>
                    <span className="muted small">({charMods.length} 个 Mod)</span>
                  </div>

                  <div className="roster-char-mods">
                    <label className="roster-mod-radio">
                      <input
                        type="radio"
                        name={`roster_${char.folder}`}
                        checked={!currentChoice}
                        onChange={() => {
                          setSelectedAssignments((prev) => {
                            const next = { ...prev }
                            delete next[char.folder]
                            return next
                          })
                        }}
                      />
                      <span className="muted">不启用任何 Mod（保持原生）</span>
                    </label>

                    {charMods.map((mod) => {
                      const isChecked = currentChoice === mod.name
                      return (
                        <label
                          key={mod.folderName}
                          className={`roster-mod-radio${isChecked ? ' is-checked' : ''}`}
                        >
                          <input
                            type="radio"
                            name={`roster_${char.folder}`}
                            checked={isChecked}
                            onChange={() => {
                              setSelectedAssignments((prev) => ({
                                ...prev,
                                [char.folder]: { modName: mod.name }
                              }))
                            }}
                          />
                          <span className="roster-mod-name-label">{mod.name}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}
