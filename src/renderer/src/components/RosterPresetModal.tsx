import { useEffect, useMemo, useState } from 'react'
import type {
  CharacterModAssignment,
  GameDef,
  GameSnapshot,
  ModAssignmentItem,
  ModInfo,
  ModVariantPreset,
  RosterPreset
} from '../../../shared/types'
import { getAssignmentModItems, isUtilityCategory } from '../../../shared/types'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { ScrollTitle } from './ScrollTitle'

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
    Record<string, CharacterModAssignment>
  >({})
  const [charModes, setCharModes] = useState<Record<string, 'single' | 'multi'>>({})
  const [modPresetsMap, setModPresetsMap] = useState<Record<string, ModVariantPreset[]>>({})
  const [loadingPresetsMap, setLoadingPresetsMap] = useState<Record<string, boolean>>({})
  const [charFilter, setCharFilter] = useState('')
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [activePoolTab, setActivePoolTab] = useState<'character' | 'utility' | 'all'>('character')
  const [showDirtyWarningModal, setShowDirtyWarningModal] = useState(false)
  const [dirtyWarningList, setDirtyWarningList] = useState<{ charName: string; modName: string }[]>([])

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

  // 2. 按需加载指定 Mod 的单 Mod 变体预设
  const loadModPresets = async (charFolder: string, mod: ModInfo): Promise<ModVariantPreset[]> => {
    const key = `${charFolder}::${mod.name}`
    if (modPresetsMap[key]) return modPresetsMap[key]
    setLoadingPresetsMap((prev) => ({ ...prev, [key]: true }))
    try {
      const list = await window.moddeck.getModPresets(game.id, charFolder, mod.folderName)
      setModPresetsMap((prev) => ({ ...prev, [key]: list }))
      return list
    } catch {
      setModPresetsMap((prev) => ({ ...prev, [key]: [] }))
      return []
    } finally {
      setLoadingPresetsMap((prev) => ({ ...prev, [key]: false }))
    }
  }

  // 3. 加载各角色的 Mod 列表以供配置选择
  const fetchCharacterMods = async () => {
    const map: Record<string, ModInfo[]> = {}
    const currentAssignments: Record<string, CharacterModAssignment> = {}
    const initialModes: Record<string, 'single' | 'multi'> = {}
    const modsToPreload: { charFolder: string; mod: ModInfo }[] = []

    for (const char of snapshot.characters) {
      if (char.modCount === 0) continue
      try {
        const list = await window.moddeck.getMods(game.id, char.folder)
        map[char.folder] = list

        const enabledMods = list.filter((m) => m.enabled)
        // 初始单多选规则：若当前启用的 Mod 数量 > 1，则初始为多选；否则为单选
        initialModes[char.folder] = enabledMods.length > 1 ? 'multi' : 'single'

        if (enabledMods.length > 0) {
          const items: ModAssignmentItem[] = enabledMods.map((m) => ({
            modName: m.name
          }))
          currentAssignments[char.folder] = {
            modName: items[0]?.modName,
            presetId: items[0]?.presetId,
            mods: items
          }
          for (const m of enabledMods) {
            modsToPreload.push({ charFolder: char.folder, mod: m })
          }
        } else {
          currentAssignments[char.folder] = { mods: [] }
        }
      } catch {
        // ignore
      }
    }
    setCharacterModsMap(map)
    setCharModes(initialModes)
    setSelectedAssignments(currentAssignments)

    // 异步预加载所有已启用 Mod 的预设，并绑定其当前实机活跃预设
    for (const { charFolder, mod } of modsToPreload) {
      void (async () => {
        try {
          const list = await window.moddeck.getModPresets(game.id, charFolder, mod.folderName)
          setModPresetsMap((prev) => ({ ...prev, [`${charFolder}::${mod.name}`]: list }))
          const activeP = list.find((p) => p.isActive)
          const targetPresetId = activeP ? activeP.id : (list.length > 0 ? '__dirty__' : '__default__')
          setSelectedAssignments((prev) => {
            const curr = prev[charFolder]
            const items = getAssignmentModItems(curr)
            const idx = items.findIndex((i) => i.modName.toLowerCase() === mod.name.toLowerCase())
            if (idx >= 0 && (!items[idx].presetId || items[idx].presetId === '__dirty__')) {
              const nextItems = [...items]
              nextItems[idx] = { ...nextItems[idx], presetId: targetPresetId }
              return {
                ...prev,
                [charFolder]: {
                  modName: nextItems[0]?.modName,
                  presetId: nextItems[0]?.presetId,
                  mods: nextItems
                }
              }
            }
            return prev
          })
        } catch {
          // ignore
        }
      })()
    }
  }

  useEffect(() => {
    void fetchPresets()
    void fetchCharacterMods()
  }, [game.id])

  // 单角色单多选模式切换
  const toggleCharMode = (charFolder: string, targetMode: 'single' | 'multi') => {
    setCharModes((prev) => ({ ...prev, [charFolder]: targetMode }))
    if (targetMode === 'single') {
      setSelectedAssignments((prev) => {
        const curr = prev[charFolder]
        const items = getAssignmentModItems(curr)
        if (items.length > 1) {
          const first = items[0]
          return {
            ...prev,
            [charFolder]: {
              modName: first.modName,
              presetId: first.presetId,
              mods: [first]
            }
          }
        }
        return prev
      })
    }
  }

  // 单选：选择原生（清空）
  const handleSelectNative = (charFolder: string) => {
    setSelectedAssignments((prev) => ({
      ...prev,
      [charFolder]: { mods: [] }
    }))
  }

  // 单选：选择某个 Mod
  const handleSelectSingleMod = (charFolder: string, mod: ModInfo) => {
    const key = `${charFolder}::${mod.name}`
    const cached = modPresetsMap[key]
    const defaultPId = cached?.find((p) => p.isActive)?.id || (cached && cached.length > 0 ? '__dirty__' : '__default__')
    setSelectedAssignments((prev) => ({
      ...prev,
      [charFolder]: {
        modName: mod.name,
        presetId: defaultPId,
        mods: [{ modName: mod.name, presetId: defaultPId }]
      }
    }))
    void loadModPresets(charFolder, mod)
  }

  // 多选：复选框勾选切换
  const handleToggleMultiMod = (charFolder: string, mod: ModInfo, checked: boolean) => {
    setSelectedAssignments((prev) => {
      const curr = prev[charFolder]
      const items = getAssignmentModItems(curr)
      let nextItems: ModAssignmentItem[]
      if (checked) {
        const key = `${charFolder}::${mod.name}`
        const cached = modPresetsMap[key]
        const defaultPId = cached?.find((p) => p.isActive)?.id || (cached && cached.length > 0 ? '__dirty__' : '__default__')
        nextItems = [
          ...items.filter((i) => i.modName.toLowerCase() !== mod.name.toLowerCase()),
          { modName: mod.name, presetId: defaultPId }
        ]
        void loadModPresets(charFolder, mod)
      } else {
        nextItems = items.filter((i) => i.modName.toLowerCase() !== mod.name.toLowerCase())
      }
      return {
        ...prev,
        [charFolder]: {
          modName: nextItems[0]?.modName,
          presetId: nextItems[0]?.presetId,
          mods: nextItems
        }
      }
    })
  }

  // 多选：全选
  const handleSelectAllMods = (charFolder: string, mods: ModInfo[]) => {
    const nextItems: ModAssignmentItem[] = mods.map((m) => {
      const key = `${charFolder}::${m.name}`
      const cached = modPresetsMap[key]
      const defaultPId = cached?.find((p) => p.isActive)?.id || cached?.[0]?.id || '__default__'
      void loadModPresets(charFolder, m)
      return { modName: m.name, presetId: defaultPId }
    })
    setSelectedAssignments((prev) => ({
      ...prev,
      [charFolder]: {
        modName: nextItems[0]?.modName,
        presetId: nextItems[0]?.presetId,
        mods: nextItems
      }
    }))
  }

  // 多选：全清
  const handleClearAllMods = (charFolder: string) => {
    setSelectedAssignments((prev) => ({
      ...prev,
      [charFolder]: { mods: [] }
    }))
  }

  // 变更 Mod 的专属预设
  const handleModPresetChange = (charFolder: string, modName: string, presetId: string) => {
    setSelectedAssignments((prev) => {
      const curr = prev[charFolder]
      const items = getAssignmentModItems(curr)
      const nextItems = items.map((i) =>
        i.modName.toLowerCase() === modName.toLowerCase() ? { ...i, presetId } : i
      )
      return {
        ...prev,
        [charFolder]: {
          modName: nextItems[0]?.modName,
          presetId: nextItems[0]?.presetId,
          mods: nextItems
        }
      }
    })
  }

  // 在游戏内立即切换该 Mod 预设（现场试穿）
  const handleApplySingleModPreset = async (
    charFolder: string,
    mod: ModInfo,
    presetId: string
  ) => {
    try {
      const res = await window.moddeck.applyModPreset(
        game.id,
        charFolder,
        mod.folderName,
        presetId
      )
      if (res.ok) {
        onNotify?.(`已在游戏内切换 ${mod.name} 预设`, 'ok')
        const list = await window.moddeck.getModPresets(game.id, charFolder, mod.folderName)
        setModPresetsMap((prev) => ({ ...prev, [`${charFolder}::${mod.name}`]: list }))
      } else {
        onNotify?.(res.error || '切换预设失败', 'err')
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err), 'err')
    }
  }

  // 计算当前工作台配置是否与已有的某个方案完全一致
  const matchingExistingPreset = useMemo(() => {
    const normalize = (assignments: Record<string, CharacterModAssignment>) => {
      const entries: Array<{ charFolder: string; modName: string; presetId: string }> = []
      for (const [charFolder, assign] of Object.entries(assignments)) {
        const items = getAssignmentModItems(assign)
        for (const item of items) {
          if (!item.modName) continue
          entries.push({
            charFolder,
            modName: item.modName.toLowerCase(),
            presetId: item.presetId || '__default__'
          })
        }
      }
      entries.sort((a, b) => (a.charFolder + a.modName).localeCompare(b.charFolder + b.modName))
      return JSON.stringify(entries)
    }

    const currentKey = normalize(selectedAssignments)
    if (currentKey === '[]') return null

    for (const p of presets) {
      if (normalize(p.assignments) === currentKey) {
        return p
      }
    }
    return null
  }, [selectedAssignments, presets])

  // 点击方案标签：载入方案至工作台查看并应用
  const handleInspectPreset = (preset: RosterPreset) => {
    setActivePresetId(preset.id)
    setPresetName(preset.name)
    setSelectedAssignments(preset.assignments)
    const nextModes: Record<string, 'single' | 'multi'> = {}
    for (const [charFolder, assign] of Object.entries(preset.assignments)) {
      const items = getAssignmentModItems(assign)
      nextModes[charFolder] = items.length > 1 ? 'multi' : 'single'
      const charMods = characterModsMap[charFolder] || []
      for (const item of items) {
        const m = charMods.find((x) => x.name.toLowerCase() === item.modName.toLowerCase())
        if (m) void loadModPresets(charFolder, m)
      }
    }
    setCharModes((prev) => ({ ...prev, ...nextModes }))
  }

  // 保存新方案（带未保存实机改动保护）
  const handleSavePreset = async (forceReplaceDirtyWithDefault = false) => {
    const name = presetName.trim()
    if (!name) {
      onNotify?.('请输入预设方案名称', 'err')
      return
    }

    // 检查是否存在未保存改动的实机脏状态
    const dirtyItems: { charName: string; modName: string }[] = []
    for (const [charFolder, assign] of Object.entries(selectedAssignments)) {
      const charInfo = snapshot.characters.find((c) => c.folder === charFolder)
      const items = getAssignmentModItems(assign)
      for (const item of items) {
        if (item.presetId === '__dirty__') {
          dirtyItems.push({
            charName: charInfo?.displayName || charFolder,
            modName: item.modName
          })
        }
      }
    }

    if (dirtyItems.length > 0 && !forceReplaceDirtyWithDefault) {
      setDirtyWarningList(dirtyItems)
      setShowDirtyWarningModal(true)
      return // 拦截保存，弹窗提示！
    }

    // 若用户确认替换或本身无脏状态，将 __dirty__ 转为 __default__
    const finalAssignments: Record<string, CharacterModAssignment> = {}
    for (const [charFolder, assign] of Object.entries(selectedAssignments)) {
      const items = getAssignmentModItems(assign)
      const cleanedItems = items.map((i) =>
        i.presetId === '__dirty__' ? { ...i, presetId: '__default__' } : i
      )
      finalAssignments[charFolder] = {
        modName: cleanedItems[0]?.modName,
        presetId: cleanedItems[0]?.presetId,
        mods: cleanedItems
      }
    }

    try {
      setSaving(true)
      const res = await window.moddeck.saveRosterPreset(game.id, {
        name,
        assignments: finalAssignments
      })
      if (res.ok) {
        onNotify?.(`已保存预设方案「${name}」`, 'ok')
        setSelectedAssignments(finalAssignments)
        setPresetName('')
        setShowCreateForm(false)
        setShowDirtyWarningModal(false)
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

  const { charPool, utilPool } = useMemo(() => {
    const chars: typeof validCharacters = []
    const utils: typeof validCharacters = []
    for (const c of validCharacters) {
      if (isUtilityCategory(c)) {
        utils.push(c)
      } else {
        chars.push(c)
      }
    }
    return { charPool: chars, utilPool: utils }
  }, [validCharacters])

  const displayedCharacters = useMemo(() => {
    if (activePoolTab === 'character') return charPool
    if (activePoolTab === 'utility') return utilPool
    return validCharacters
  }, [activePoolTab, charPool, utilPool, validCharacters])

  // 一键全部不启用（保持原生）
  const handleBatchSetNative = (targetChars: typeof validCharacters) => {
    setSelectedAssignments((prev) => {
      const next = { ...prev }
      for (const char of targetChars) {
        next[char.folder] = { mods: [] }
      }
      return next
    })
    const poolName = activePoolTab === 'character' ? '角色分池' : activePoolTab === 'utility' ? '其他/功能UI分池' : '全池'
    onNotify?.(`已将${poolName}（${targetChars.length} 项）设置为全部保持原生`, 'info')
  }

  // 一键选中当前实机使用中的预设
  const handleBatchSetCurrentActive = (targetChars: typeof validCharacters) => {
    setSelectedAssignments((prev) => {
      const next = { ...prev }
      for (const char of targetChars) {
        const charMods = characterModsMap[char.folder] || []
        const enabledMods = charMods.filter((m) => m.enabled)
        if (enabledMods.length === 0) {
          next[char.folder] = { mods: [] }
          continue
        }
        const items: ModAssignmentItem[] = enabledMods.map((m) => {
          const key = `${char.folder}::${m.name}`
          const cached = modPresetsMap[key]
          const activeP = cached?.find((p) => p.isActive)
          return {
            modName: m.name,
            presetId: activeP ? activeP.id : '__default__'
          }
        })
        next[char.folder] = {
          modName: items[0]?.modName,
          presetId: items[0]?.presetId,
          mods: items
        }
      }
      return next
    })
    setCharModes((prev) => {
      const next = { ...prev }
      for (const char of targetChars) {
        const charMods = characterModsMap[char.folder] || []
        const enabledCount = charMods.filter((m) => m.enabled).length
        next[char.folder] = enabledCount > 1 ? 'multi' : 'single'
      }
      return next
    })
    const poolName = activePoolTab === 'character' ? '角色分池' : activePoolTab === 'utility' ? '其他/功能UI分池' : '全池'
    onNotify?.(`已将${poolName}（${targetChars.length} 项）恢复为游戏当前实机配置`, 'ok')
  }

  // 快捷键监听：Alt+U 一键不启用，Alt+R 一键选中使用中
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        handleBatchSetNative(displayedCharacters)
      } else if (e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        handleBatchSetCurrentActive(displayedCharacters)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [displayedCharacters, characterModsMap, modPresetsMap, activePoolTab])

  return (
    <Modal
      title={`角色池预设方案管理 · ${game.shortName}`}
      onClose={onClose}
      width={840}
      footer={
        <div className="modal-foot-between">
          <div className="muted small">
            预设只记录各角色/Mod 激活与变体变量配置，毫秒级快速切换，绝不复制实体文件。
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
              disabled={!showCreateForm && Boolean(matchingExistingPreset)}
              onClick={() => setShowCreateForm(!showCreateForm)}
              title={
                matchingExistingPreset
                  ? `当前配置与方案「${matchingExistingPreset.name}」完全一致，无需重复保存`
                  : '将当前工作台配置保存为新方案'
              }
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
                disabled={saving || Boolean(matchingExistingPreset)}
                onClick={() => void handleSavePreset()}
                title={
                  matchingExistingPreset
                    ? `当前配置已与方案「${matchingExistingPreset.name}」完全一致`
                    : undefined
                }
              >
                {saving ? '保存中…' : '保存当前配置'}
              </button>
            </div>
          ) : null}

          <div className="roster-presets-chips">
            {loading ? (
              <span className="muted small">加载预设中…</span>
            ) : presets.length === 0 ? (
              <span className="muted small">暂无方案，请在下方配置各角色 Mod 与预设后点击右上角保存</span>
            ) : (
              presets.map((p) => {
                const isActive = activePresetId === p.id
                const charCount = Object.keys(p.assignments).length
                const totalModCount = Object.values(p.assignments).reduce((acc, a) => {
                  const items = getAssignmentModItems(a)
                  return acc + items.length
                }, 0)

                return (
                  <div
                    key={p.id}
                    className={`roster-preset-chip${isActive ? ' is-active' : ''}`}
                  >
                    <button
                      className="roster-preset-chip-btn"
                      onClick={() => {
                        handleInspectPreset(p)
                      }}
                      title={`在下方工作台查看/调校「${p.name}」配置`}
                    >
                      <span className="preset-dot" />
                      <span style={{ minWidth: 0, overflow: 'hidden' }}>
                        <ScrollTitle text={p.name} />
                      </span>
                      <span className="muted small">
                        ({charCount}人·{totalModCount}Mod)
                      </span>
                    </button>
                    <button
                      className="icon-btn danger preset-del-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDeletePreset(p)
                      }}
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

        {/* 角色与 Mod 方案配置区域 */}
        <div className="roster-config-section">
          <div className="roster-config-head">
            <strong>角色 Mod 与变体预设方案配置</strong>
            <input
              className="input roster-search-input"
              placeholder="快速过滤角色/分类…"
              value={charFilter}
              onChange={(e) => setCharFilter(e.target.value)}
            />
          </div>

          {/* 分池切换栏与快捷操作工具条 */}
          <div className="roster-pool-tabs-bar">
            <div className="roster-pool-tabs">
              <button
                type="button"
                className={`roster-pool-tab${activePoolTab === 'character' ? ' is-active' : ''}`}
                onClick={() => setActivePoolTab('character')}
              >
                🎭 角色预设 ({charPool.length})
              </button>
              <button
                type="button"
                className={`roster-pool-tab${activePoolTab === 'utility' ? ' is-active' : ''}`}
                onClick={() => setActivePoolTab('utility')}
              >
                🧩 功能/UI/其他 ({utilPool.length})
              </button>
              <button
                type="button"
                className={`roster-pool-tab${activePoolTab === 'all' ? ' is-active' : ''}`}
                onClick={() => setActivePoolTab('all')}
              >
                📋 全部 ({validCharacters.length})
              </button>
            </div>

            <div className="roster-pool-actions">
              <button
                type="button"
                className="roster-pool-btn"
                onClick={() => handleBatchSetNative(displayedCharacters)}
                title="将当前分池中全部项目设置为不启用任何 Mod（保持游戏原生）[快捷键 Alt+U]"
              >
                <Icon name="close" size={12} />
                <span>一键全部不启用</span>
                <kbd className="kbd-shortcut">Alt+U</kbd>
              </button>
              <button
                type="button"
                className="roster-pool-btn primary-ghost"
                onClick={() => handleBatchSetCurrentActive(displayedCharacters)}
                title="将当前分池中全部项目恢复为游戏实机当前正在使用的 Mod 与预设 [快捷键 Alt+R]"
              >
                <Icon name="refresh" size={12} />
                <span>一键选中当前使用中</span>
                <kbd className="kbd-shortcut">Alt+R</kbd>
              </button>
            </div>
          </div>

          <div className="roster-characters-grid">
            {displayedCharacters.length === 0 ? (
              <div
                style={{
                  gridColumn: '1 / -1',
                  textAlign: 'center',
                  padding: '36px 12px',
                  color: 'var(--text-muted)',
                  fontSize: '13px'
                }}
              >
                {charFilter
                  ? '未找到匹配的项目'
                  : activePoolTab === 'character'
                    ? '当前分池暂无角色类 Mod'
                    : '当前分池暂无功能/UI/其他类 Mod'}
              </div>
            ) : (
              displayedCharacters.map((char) => {
              const charMods = characterModsMap[char.folder] || []
              const mode = charModes[char.folder] || 'single'
              const assignedItems = getAssignmentModItems(selectedAssignments[char.folder])
              const assignedMap = new Map(assignedItems.map((i) => [i.modName.toLowerCase(), i]))

              return (
                <div key={char.folder} className="roster-char-card">
                  <div className="roster-char-head">
                    <div className="roster-char-title-wrap">
                      <span className="roster-char-name" title={char.displayName}>
                        {char.displayName}
                      </span>
                      <span className="muted small">({charMods.length})</span>
                    </div>

                    <div className="roster-mode-switch">
                      <button
                        type="button"
                        className={`roster-mode-btn${mode === 'single' ? ' is-active' : ''}`}
                        onClick={() => toggleCharMode(char.folder, 'single')}
                        title="单选模式（互斥保护，同时只生效一个 Mod）"
                      >
                        单选
                      </button>
                      <button
                        type="button"
                        className={`roster-mode-btn${mode === 'multi' ? ' is-active' : ''}`}
                        onClick={() => toggleCharMode(char.folder, 'multi')}
                        title="多选模式（共存允许，可同时勾选多个 Mod）"
                      >
                        多选
                      </button>
                    </div>
                  </div>

                  {mode === 'multi' && (
                    <div className="roster-multi-toolbar">
                      <div>
                        <button
                          type="button"
                          className="roster-mini-btn"
                          onClick={() => handleSelectAllMods(char.folder, charMods)}
                        >
                          全选
                        </button>
                        <button
                          type="button"
                          className="roster-mini-btn"
                          onClick={() => handleClearAllMods(char.folder)}
                        >
                          全清
                        </button>
                      </div>
                      <span className="muted small">
                        已选 {assignedItems.length} / {charMods.length}
                      </span>
                    </div>
                  )}

                  <div className="roster-char-mods">
                    {mode === 'single' && (
                      <label className="roster-mod-radio">
                        <input
                          type="radio"
                          name={`roster_${char.folder}`}
                          checked={assignedItems.length === 0}
                          onChange={() => handleSelectNative(char.folder)}
                        />
                        <span className="muted">不启用任何 Mod（保持原生）</span>
                      </label>
                    )}

                    {charMods.map((mod) => {
                      const isChecked = assignedMap.has(mod.name.toLowerCase())
                      const assignedItem = assignedMap.get(mod.name.toLowerCase())
                      const key = `${char.folder}::${mod.name}`
                      const presets = modPresetsMap[key] || []
                      const isLoadingPresets = Boolean(loadingPresetsMap[key])

                      return (
                        <div
                          key={mod.folderName}
                          className={`roster-mod-item${isChecked ? ' is-selected' : ''}`}
                        >
                          {mode === 'single' ? (
                            <label className={`roster-mod-radio${isChecked ? ' is-checked' : ''}`}>
                              <input
                                type="radio"
                                name={`roster_${char.folder}`}
                                checked={isChecked}
                                onChange={() => handleSelectSingleMod(char.folder, mod)}
                              />
                              <span
                                className="roster-mod-name-label"
                                style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}
                              >
                                <ScrollTitle text={mod.name} />
                              </span>
                            </label>
                          ) : (
                            <label className={`roster-mod-checkbox${isChecked ? ' is-checked' : ''}`}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) =>
                                  handleToggleMultiMod(char.folder, mod, e.target.checked)
                                }
                              />
                              <span
                                className="roster-mod-name-label"
                                style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}
                              >
                                <ScrollTitle text={mod.name} />
                              </span>
                            </label>
                          )}

                          {/* 变体预设选择行（当 Mod 选中时展开） */}
                          {isChecked && (
                            <div className="roster-mod-presets-row">
                              <span className="roster-mod-presets-label">
                                <Icon name="box" size={12} />
                                预设:
                              </span>
                              {isLoadingPresets && presets.length === 0 ? (
                                <span className="muted small">加载中…</span>
                              ) : presets.length === 0 ? (
                                <span className="muted small">默认初始</span>
                              ) : (
                                <>
                                  <select
                                    className={`roster-mod-preset-select${assignedItem?.presetId === '__dirty__' ? ' is-dirty' : ''}`}
                                    value={assignedItem?.presetId || (presets.some((p) => p.isActive) ? presets.find((p) => p.isActive)?.id : '__dirty__')}
                                    onChange={(e) =>
                                      handleModPresetChange(char.folder, mod.name, e.target.value)
                                    }
                                    title="选择该方案生效时此 Mod 所应用的变体预设"
                                  >
                                    {assignedItem?.presetId === '__dirty__' && (
                                      <option value="__dirty__">⚠️ 当前实机 (未保存改动)</option>
                                    )}
                                    {presets.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.id === '__default__' ? `默认 (${p.name})` : p.name}
                                        {p.isActive ? ' · 当前实机' : ''}
                                      </option>
                                    ))}
                                  </select>
                                  {assignedItem?.presetId === '__dirty__' && (
                                    <span className="roster-dirty-pill" title="当前实机造型有微调，尚未保存为独立单 Mod 预设">
                                      未保存
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    className="roster-preset-apply-btn"
                                    title="在游戏内立即切换至该预设并热重载（现场试穿）"
                                    onClick={() =>
                                      void handleApplySingleModPreset(
                                        char.folder,
                                        mod,
                                        assignedItem?.presetId || presets[0]?.id || '__default__'
                                      )
                                    }
                                  >
                                    <Icon name="refresh" size={11} />
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
            )}
          </div>
        </div>
      </div>

      {showDirtyWarningModal && (
        <Modal
          title="⚠️ 检测到未保存的实机改动"
          onClose={() => setShowDirtyWarningModal(false)}
          width={480}
        >
          <div className="roster-dirty-modal-body">
            <p>
              方案中有 <strong>{dirtyWarningList.length}</strong> 个 Mod 当前处于现场实机微调状态（尚未保存为独立单 Mod 预设）：
            </p>
            <ul className="roster-dirty-list">
              {dirtyWarningList.map((d, idx) => (
                <li key={idx}>
                  <span className="dirty-char-tag">{d.charName}</span>
                  <span className="dirty-mod-tag">{d.modName}</span>
                </li>
              ))}
            </ul>
            <p className="muted small">
              全角色方案仅记录固定的变体预设。若继续保存，这些未保存项将自动以「<strong>出厂默认</strong>」存入方案。
            </p>
            <div className="roster-dirty-modal-actions">
              <button className="btn" onClick={() => setShowDirtyWarningModal(false)}>
                取消并返回
              </button>
              <button
                className="btn primary"
                onClick={() => void handleSavePreset(true)}
              >
                替换为默认并继续保存
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  )
}
