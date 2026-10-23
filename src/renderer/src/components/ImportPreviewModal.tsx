import { useMemo, useState } from 'react'
import type {
  CharacterInfo,
  GameDef,
  ImportCommitItem,
  ImportParseResult
} from '../../../shared/types'
import { Icon } from './Icon'
import { Modal } from './Modal'

const BUILTIN_ROSTER_NAMES: Record<string, string[]> = {
  'wuthering-waves': [
    '其他',
    '男主',
    '女主',
    '今汐',
    '长离',
    '椿',
    '守岸人',
    '珂莱塔',
    '吟霖',
    '折枝',
    '相里要',
    '忌炎',
    '维里奈',
    '安可',
    '卡卡罗',
    '鉴心',
    '凌阳',
    '散华',
    '白芷',
    '秧秧',
    '炽霞',
    '丹瑾',
    '桃祈',
    '莫特斐',
    '渊武',
    '秋水',
    '釉瑚',
    '灯灯',
    '洛可可',
    '布兰特',
    '菲比',
    '坎特蕾拉',
    '赞妮',
    '夏空',
    '卡提希娅',
    '露帕',
    '弗洛洛',
    '奥古斯塔',
    '尤诺',
    '嘉贝莉娜',
    '仇远',
    '千咲',
    '卜灵',
    '爱弥斯',
    '绯雪',
    '洛瑟菈',
    '陆·赫斯',
    '琳奈',
    '莫宁',
    '希格莉卡',
    '达妮娅',
    '丽贝卡',
    '露西',
    '穗穗',
    '秧秧·玄翎',
    '武器',
    '滑翔翼',
    '载具',
    'UI',
    '功能',
    '大世界',
    'NPC'
  ],
  'honkai-star-rail': [
    '其他',
    '男主',
    '女主',
    '流萤',
    '黄泉',
    '飞霄',
    '知更鸟',
    '阮梅',
    '花火',
    '黑天鹅',
    '卡芙卡',
    '镜流',
    '丹恒-饮月',
    '丹恒-腾荒',
    '丹恒',
    '三月七-存护',
    '三月七-巡猎',
    '符玄',
    '银狼',
    '银狼LV.999',
    '希儿',
    '布洛妮娅',
    '姬子',
    '瓦尔特',
    '景元',
    '刃',
    '刃-千治',
    '罗刹',
    '托帕&账账',
    '藿藿',
    '银枝',
    '真理医生',
    '砂金',
    '波提欧',
    '翡翠',
    '云璃',
    '椒丘',
    '灵砂',
    '乱破',
    '星期日',
    '忘归人',
    '大黑塔',
    '阿格莱雅',
    '缇宝',
    '万敌',
    '遐蝶',
    '那刻夏',
    '风堇',
    '赛飞儿',
    '白厄',
    'Saber',
    'Archer',
    '海瑟音',
    '刻律德菈',
    '长夜月',
    '昔涟',
    '大丽花',
    '爻光',
    '火花',
    '不死途',
    '绯英',
    '白露',
    '克拉拉',
    '杰帕德',
    '彦卿',
    '黑塔',
    '停云',
    '青雀',
    '佩拉',
    '艾丝妲',
    '娜塔莎',
    '素裳',
    '希露瓦',
    '桑博',
    '虎克',
    '阿兰',
    '驭空',
    '卢卡',
    '玲可',
    '桂乃芬',
    '寒鸦',
    '雪衣',
    '米沙',
    '加拉赫',
    '貊泽',
    '光锥',
    'UI',
    '功能',
    '大世界',
    'NPC'
  ],
  zzz: [
    '其他',
    '男主',
    '女主',
    '雅',
    '艾莲',
    '朱鸢',
    '青衣',
    '简',
    '凯撒',
    '柏妮思',
    '柳',
    '莱特',
    '悠真',
    '耀嘉音',
    '伊芙琳',
    '零号·安比',
    '扳机',
    '薇薇安',
    '雨果',
    '仪玄',
    '橘福福',
    '柚叶',
    '爱丽丝',
    '席德',
    '奥菲丝&鬼火',
    '卢西娅',
    '伊德海莉',
    '琉音',
    '般岳',
    '叶瞬光',
    '照',
    '千夏',
    '爱芮',
    '南宫羽',
    '希希芙',
    '普罗米娅',
    '维琳娜',
    '诺姆',
    '佩洛伊斯',
    '安比',
    '妮可',
    '比利',
    '猫又',
    '11号',
    '珂蕾妲',
    '格莉丝',
    '安东',
    '本',
    '莱卡恩',
    '丽娜',
    '可琳',
    '苍角',
    '露西',
    '派派',
    '赛斯',
    '波可娜',
    '潘引壶',
    '真斗',
    '武器',
    'UI',
    '功能',
    '大世界',
    'NPC'
  ],
  endfield: [
    '其他',
    '男主',
    '女主',
    '佩丽卡',
    '陈千语',
    '莱万汀',
    '伊冯',
    '洁尔佩塔',
    '艾尔黛拉',
    '余烬',
    '别礼',
    '黎风',
    '骏卫',
    '阿列什',
    '弧光',
    '艾维文娜',
    '大潘',
    '昼雪',
    '狼卫',
    '赛希',
    '秋栗',
    '安塔尔',
    '卡契尔',
    '埃特拉',
    '萤石',
    '汤汤',
    '洛茜',
    '庄方宜',
    '弭弗',
    '卡繆',
    '诀',
    '梨诺',
    '祀',
    '提弗洛斯',
    '武器',
    'UI',
    '功能',
    '大世界',
    'NPC'
  ],
  'neverness-to-everness': [
    '其他',
    '男主',
    '女主',
    '薄荷',
    '早雾',
    '娜娜莉',
    '浔',
    '法蒂亚',
    '阿德勒',
    '翳',
    '安魂曲',
    '九原',
    '伊洛伊',
    '凛子',
    '哈尼娅',
    '哈索尔',
    '埃德加',
    '小吱',
    '尼察',
    '真红',
    '海月',
    '白藏',
    '赤音',
    '达芙迪尔',
    '阿尔法德',
    '黑鸟',
    '卡厄斯',
    '武器',
    '载具',
    'UI',
    '功能',
    '大世界',
    'NPC'
  ]
}

export function ImportPreviewModal({
  game,
  parsed,
  characters,
  rosterNames,
  targetCharacter,
  onCancel,
  onCommit
}: {
  game: GameDef
  parsed: ImportParseResult
  characters: CharacterInfo[]
  rosterNames?: string[]
  targetCharacter?: string
  onCancel: () => void
  onCommit: (items: ImportCommitItem[]) => Promise<void>
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(parsed.candidates.map((c) => c.id))
  )
  const [charAssignments, setCharAssignments] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    for (const candidate of parsed.candidates) {
      map[candidate.id] = targetCharacter || candidate.suggestedCharacter || '其他'
    }
    return map
  })
  const [submitting, setSubmitting] = useState(false)

  const characterOptions = useMemo(() => {
    const options = new Map<string, { folder: string; label: string; isExisting: boolean }>()
    // 1. Existing folders in Mods directory
    for (const char of characters) {
      options.set(char.folder, {
        folder: char.folder,
        label:
          char.displayName !== char.folder
            ? `${char.displayName} (${char.folder})`
            : char.displayName,
        isExisting: true
      })
    }
    // 2. Ensure "其他" is always available
    if (!options.has('其他')) {
      options.set('其他', { folder: '其他', label: '其他（新建目录）', isExisting: false })
    }
    // 3. Ensure any suggested characters from parser are in the list
    for (const candidate of parsed.candidates) {
      const folder = candidate.suggestedCharacter || '其他'
      if (!options.has(folder)) {
        options.set(folder, {
          folder,
          label: `${folder}（新建目录）`,
          isExisting: false
        })
      }
    }
    // 4. Built-in + remote merged roster names for this game so new users without folders can pick directly
    const namesForGame =
      rosterNames && rosterNames.length > 0 ? rosterNames : (BUILTIN_ROSTER_NAMES[game.id] ?? [])
    for (const name of namesForGame) {
      if (!options.has(name)) {
        options.set(name, {
          folder: name,
          label: `${name}（新建目录）`,
          isExisting: false
        })
      }
    }
    return Array.from(options.values())
  }, [characters, game.id, parsed.candidates, rosterNames])

  const existingOptions = characterOptions.filter((opt) => opt.isExisting)
  const newOptions = characterOptions.filter((opt) => !opt.isExisting)

  const allChecked =
    parsed.candidates.length > 0 && selectedIds.size === parsed.candidates.length

  function toggleAll() {
    if (allChecked) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(parsed.candidates.map((c) => c.id)))
    }
  }

  function toggleOne(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setAllCharacter(folder: string) {
    if (!folder) return
    setCharAssignments((current) => {
      const next = { ...current }
      for (const candidate of parsed.candidates) {
        if (selectedIds.has(candidate.id)) {
          next[candidate.id] = folder
        }
      }
      return next
    })
  }

  async function handleConfirm() {
    if (selectedIds.size === 0) return
    setSubmitting(true)
    try {
      const items: ImportCommitItem[] = parsed.candidates
        .filter((candidate) => selectedIds.has(candidate.id))
        .map((candidate) => ({
          id: candidate.id,
          characterFolder: charAssignments[candidate.id] || '其他',
          modName: candidate.modName
        }))
      await onCommit(items)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={targetCharacter ? `导入 Mod 到「${targetCharacter}」` : `导入解析 · ${game.shortName}`}
      onClose={() => {
        if (!submitting) onCancel()
      }}
      width={680}
      footer={
        <>
          <span className="muted small">
            已选 {selectedIds.size} / {parsed.candidates.length} 个 Mod
          </span>
          <div className="grow" />
          <button className="btn ghost" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => void handleConfirm()}
            disabled={submitting || selectedIds.size === 0}
          >
            <Icon name="check" size={15} />
            {submitting ? '正在导入…' : `导入 (${selectedIds.size})`}
          </button>
        </>
      }
    >
      <div className="import-parse-head">
        <label className="check-row" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
            disabled={parsed.candidates.length === 0 || submitting}
          />
          <span>全选</span>
        </label>
        <div className="grow" />
        {parsed.candidates.length > 1 ? (
          <div className="row" style={{ gap: 6 }}>
            <span className="muted small">批量设为：</span>
            <select
              className="select compact-select"
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) {
                  setAllCharacter(event.target.value)
                  event.target.value = ''
                }
              }}
              disabled={submitting}
            >
              <option value="">选择目标角色…</option>
              {existingOptions.length > 0 ? (
                <optgroup label="已有角色目录">
                  {existingOptions.map((opt) => (
                    <option key={opt.folder} value={opt.folder}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {newOptions.length > 0 ? (
                <optgroup label="自动新建角色目录">
                  {newOptions.map((opt) => (
                    <option key={opt.folder} value={opt.folder}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
        ) : null}
      </div>

      {parsed.errors.length > 0 ? (
        <div className="import-parse-errors">
          {parsed.errors.map((err, idx) => (
            <div key={idx} className="error-text">
              {err.source}：{err.message}
            </div>
          ))}
        </div>
      ) : null}

      {parsed.candidates.length === 0 ? (
        <div className="empty-panel" style={{ marginTop: 12, padding: '28px 16px' }}>
          <p className="muted">没有解析出可导入的 Mod</p>
        </div>
      ) : (
        <div className="import-candidate-list">
          {parsed.candidates.map((candidate) => {
            const checked = selectedIds.has(candidate.id)
            const assigned = charAssignments[candidate.id] || '其他'
            return (
              <div
                key={candidate.id}
                className={`import-candidate-row${checked ? ' is-checked' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mod-check"
                  checked={checked}
                  onChange={() => toggleOne(candidate.id)}
                  disabled={submitting}
                />
                <div
                  className="import-candidate-main"
                  onClick={() => {
                    if (!submitting) toggleOne(candidate.id)
                  }}
                >
                  <div className="import-candidate-title">
                    <strong>{candidate.modName}</strong>
                    {!candidate.hasIni ? (
                      <span className="tag warn" title="未检测到 .ini 文件">
                        无 INI
                      </span>
                    ) : null}
                  </div>
                  <div className="import-candidate-sub">
                    <span>来源：{candidate.sourceName}</span>
                    {candidate.matchReason ? <span> · {candidate.matchReason}</span> : null}
                  </div>
                </div>
                <select
                  className="select compact-select import-char-select"
                  value={assigned}
                  onChange={(event) =>
                    setCharAssignments((current) => ({
                      ...current,
                      [candidate.id]: event.target.value
                    }))
                  }
                  disabled={submitting}
                  title="选择要导入到的角色目录"
                >
                  {existingOptions.length > 0 ? (
                    <optgroup label="已有角色目录">
                      {existingOptions.map((opt) => (
                        <option key={opt.folder} value={opt.folder}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {newOptions.length > 0 ? (
                    <optgroup label="自动新建角色目录">
                      {newOptions.map((opt) => (
                        <option key={opt.folder} value={opt.folder}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
