import type {
  CharacterInfo,
  CharacterKind,
  GameId,
  RosterSyncResult,
  RosterSyncStatus
} from '../../shared/types'
import { GAMES, isGameId } from './games'
import { readJsonSafe, writeJsonAtomic } from './fsx'
import path from 'node:path'

export interface RosterEntry {
  zh: string
  en: string
  pinyin: string
  aliases?: string[]
  kind?: CharacterKind
}

export const DEFAULT_ROSTER_REMOTE_URL =
  'https://raw.githubusercontent.com/yuzhoujun/ModDeck/main/roster.json'
const ROSTER_CACHE_FILE = 'roster-cache.json'

interface RosterCachePayload {
  updatedAt?: string
  remoteUrl?: string
  games?: Partial<Record<GameId, RosterEntry[]>>
}

let cachedRemoteRoster: Partial<Record<GameId, RosterEntry[]>> = {}
let cachedRemoteUpdatedAt: string | undefined = undefined

export const BUILTIN_ROSTER: Record<GameId, RosterEntry[]> = {
  'wuthering-waves': [
    { zh: '男主', en: 'Rover', pinyin: 'nanzhu', aliases: ['RoverMale', '漂泊者', '男漂泊者', 'piaobozhe'] },
    { zh: '女主', en: 'RoverF', pinyin: 'nvzhu', aliases: ['RoverFemale', '女漂泊者'] },
    { zh: '今汐', en: 'Jinhsi', pinyin: 'jinxi', aliases: ['Jinxi'] },
    { zh: '长离', en: 'Changli', pinyin: 'changli' },
    { zh: '椿', en: 'Camellya', pinyin: 'chun' },
    { zh: '守岸人', en: 'Shorekeeper', pinyin: 'shouanren', aliases: ['The Shorekeeper'] },
    { zh: '珂莱塔', en: 'Carlotta', pinyin: 'kelaita' },
    { zh: '吟霖', en: 'Yinlin', pinyin: 'yinlin' },
    { zh: '折枝', en: 'Zhezhi', pinyin: 'zhezhi' },
    { zh: '相里要', en: 'Xiangli Yao', pinyin: 'xiangliyao', aliases: ['Xiangliyao'] },
    { zh: '忌炎', en: 'Jiyan', pinyin: 'jiyan' },
    { zh: '维里奈', en: 'Verina', pinyin: 'weilinai' },
    { zh: '安可', en: 'Encore', pinyin: 'anke' },
    { zh: '卡卡罗', en: 'Calcharo', pinyin: 'kakaluo' },
    { zh: '鉴心', en: 'Jianxin', pinyin: 'jianxin' },
    { zh: '凌阳', en: 'Lingyang', pinyin: 'lingyang' },
    { zh: '散华', en: 'Sanhua', pinyin: 'sanhua' },
    { zh: '白芷', en: 'Baizhi', pinyin: 'baizhi' },
    { zh: '秧秧', en: 'Yangyang', pinyin: 'yangyang' },
    { zh: '炽霞', en: 'Chixia', pinyin: 'chixia' },
    { zh: '丹瑾', en: 'Danjin', pinyin: 'danjin' },
    { zh: '桃祈', en: 'Taoqi', pinyin: 'taoqi' },
    { zh: '莫特斐', en: 'Mortefi', pinyin: 'motefei' },
    { zh: '渊武', en: 'Yuanwu', pinyin: 'yuanwu' },
    { zh: '秋水', en: 'Aalto', pinyin: 'qiushui' },
    { zh: '釉瑚', en: 'Youhu', pinyin: 'youhu' },
    { zh: '灯灯', en: 'Lumi', pinyin: 'dengdeng' },
    { zh: '洛可可', en: 'Roccia', pinyin: 'luokeke' },
    { zh: '布兰特', en: 'Brant', pinyin: 'bulante' },
    { zh: '菲比', en: 'Phoebe', pinyin: 'feibi' },
    { zh: '坎特蕾拉', en: 'Cantarella', pinyin: 'kanteleila' },
    { zh: '赞妮', en: 'Zani', pinyin: 'zanni' },
    { zh: '夏空', en: 'Ciaccona', pinyin: 'xiakong' },
    { zh: '卡提希娅', en: 'Cartethyia', pinyin: 'katixiya' },
    { zh: '露帕', en: 'Lupa', pinyin: 'lupa' },
    { zh: '弗洛洛', en: 'Phrolova', pinyin: 'fuluoluo' },
    { zh: '奥古斯塔', en: 'Augusta', pinyin: 'aogusita' },
    { zh: '尤诺', en: 'Iuno', pinyin: 'younuo' },
    { zh: '嘉贝莉娜', en: 'Galbrena', pinyin: 'jiabeilina' },
    { zh: '仇远', en: 'Qiuyuan', pinyin: 'qiuyuan' },
    { zh: '千咲', en: 'Chisa', pinyin: 'qianxiao' },
    { zh: '卜灵', en: 'Buling', pinyin: 'buling' },
    { zh: '爱弥斯', en: 'Aemeath', pinyin: 'aimisi' },
    { zh: '绯雪', en: 'Hiyuki', pinyin: 'feixue', aliases: ['Feixue'] },
    { zh: '洛瑟菈', en: 'Lucilla', pinyin: 'luosela', aliases: ['露琪拉', '露西拉'] },
    { zh: '陆·赫斯', en: 'Luuk Herssen', pinyin: 'luhesi', aliases: ['Luuk'] },
    { zh: '琳奈', en: 'Lynae', pinyin: 'linnai' },
    { zh: '莫宁', en: 'Mornye', pinyin: 'moning' },
    { zh: '希格莉卡', en: 'Sigrika', pinyin: 'xigelika', aliases: ['希格丽卡'] },
    { zh: '达妮娅', en: 'Denia', pinyin: 'daniya', aliases: ['达尼娅'] },
    { zh: '丽贝卡', en: 'Rebecca', pinyin: 'libeika' },
    { zh: '露西', en: 'Lucy', pinyin: 'luxi' },
    { zh: '穗穗', en: 'Suisui', pinyin: 'suisui', aliases: ['穂穂'] },
    { zh: '秧秧·玄翎', en: 'Yangyang: Xuanling', pinyin: 'yangyangxuanling', aliases: ['YangyangXuanling', '秧秧・玄翎'] },
    { zh: '武器', en: 'Weapons', pinyin: 'wuqi', aliases: ['Weapon'], kind: 'utility' },
    { zh: '滑翔翼', en: 'Gliders', pinyin: 'huaxiangyi', aliases: ['Glider'], kind: 'utility' },
    { zh: '载具', en: 'Vehicles', pinyin: 'zaiju', aliases: ['Vehicle'], kind: 'utility' },
    { zh: 'UI', en: 'UI', pinyin: 'ui', kind: 'utility' },
    { zh: '功能', en: 'Function', pinyin: 'gongneng', aliases: ['Functions', 'Tools'], kind: 'utility' },
    { zh: '大世界', en: 'OpenWorld', pinyin: 'dashijie', aliases: ['Open World'], kind: 'utility' },
    { zh: 'NPC', en: 'NPC', pinyin: 'npc', kind: 'utility' },
    { zh: '其他', en: 'Others', pinyin: 'qita', aliases: ['Other'], kind: 'utility' }
  ],
  'honkai-star-rail': [
    { zh: '男主', en: 'Caelus', pinyin: 'nanzhu', aliases: ['穹', 'qiong', 'TrailblazerMale'] },
    { zh: '女主', en: 'Stelle', pinyin: 'nvzhu', aliases: ['星', 'xing', 'Trailblazer', '开拓者'] },
    { zh: '流萤', en: 'Firefly', pinyin: 'liuying', aliases: ['萨姆', 'Sam'] },
    { zh: '黄泉', en: 'Acheron', pinyin: 'huangquan' },
    { zh: '飞霄', en: 'Feixiao', pinyin: 'feixiao' },
    { zh: '知更鸟', en: 'Robin', pinyin: 'zhigengniao' },
    { zh: '阮梅', en: 'Ruan Mei', pinyin: 'ruanmei', aliases: ['RuanMei'] },
    { zh: '花火', en: 'Sparkle', pinyin: 'huahuo' },
    { zh: '黑天鹅', en: 'Black Swan', pinyin: 'heitiane', aliases: ['BlackSwan'] },
    { zh: '卡芙卡', en: 'Kafka', pinyin: 'kafuka' },
    { zh: '镜流', en: 'Jingliu', pinyin: 'jingliu' },
    { zh: '丹恒-饮月', en: 'Dan Heng - Imbibitor Lunae', pinyin: 'danhengyinyue', aliases: ['饮月', 'DHIL', 'Imbibitor Lunae'] },
    { zh: '丹恒-腾荒', en: 'Dan Heng - Permansor Terrae', pinyin: 'danhengtenghuang', aliases: ['DHPT', 'Permansor Terrae'] },
    { zh: '丹恒', en: 'Dan Heng', pinyin: 'danheng', aliases: ['DanHeng'] },
    { zh: '三月七-存护', en: 'March 7th', pinyin: 'sanyueqi', aliases: ['三月七', 'March7', 'March 7'] },
    { zh: '三月七-巡猎', en: 'March 7th: The Hunt', pinyin: 'sanyueqixunlie' },
    { zh: '符玄', en: 'Fu Xuan', pinyin: 'fuxuan', aliases: ['FuXuan'] },
    { zh: '银狼', en: 'Silver Wolf', pinyin: 'yinlang', aliases: ['SilverWolf'] },
    { zh: '银狼LV.999', en: 'Silver Wolf LV.999', pinyin: 'yinlanglv999' },
    { zh: '希儿', en: 'Seele', pinyin: 'xier' },
    { zh: '布洛妮娅', en: 'Bronya', pinyin: 'buluoniya' },
    { zh: '姬子', en: 'Himeko', pinyin: 'jizi' },
    { zh: '瓦尔特', en: 'Welt', pinyin: 'waerte' },
    { zh: '景元', en: 'Jing Yuan', pinyin: 'jingyuan', aliases: ['JingYuan'] },
    { zh: '刃', en: 'Blade', pinyin: 'ren' },
    { zh: '刃-千治', en: 'Mortenax Blade', pinyin: 'renqianzhi' },
    { zh: '罗刹', en: 'Luocha', pinyin: 'luocha' },
    { zh: '托帕&账账', en: 'Topaz & Numby', pinyin: 'tuopa', aliases: ['托帕', 'Topaz', 'Numby'] },
    { zh: '藿藿', en: 'Huohuo', pinyin: 'huohuo' },
    { zh: '银枝', en: 'Argenti', pinyin: 'yinzhi' },
    { zh: '真理医生', en: 'Dr. Ratio', pinyin: 'zhenliyisheng', aliases: ['DrRatio', 'Ratio'] },
    { zh: '砂金', en: 'Aventurine', pinyin: 'shajin' },
    { zh: '波提欧', en: 'Boothill', pinyin: 'botiou' },
    { zh: '翡翠', en: 'Jade', pinyin: 'feicui' },
    { zh: '云璃', en: 'Yunli', pinyin: 'yunli' },
    { zh: '椒丘', en: 'Jiaoqiu', pinyin: 'jiaoqiu' },
    { zh: '灵砂', en: 'Lingsha', pinyin: 'lingsha' },
    { zh: '乱破', en: 'Rappa', pinyin: 'luanpo' },
    { zh: '星期日', en: 'Sunday', pinyin: 'xingqiri' },
    { zh: '忘归人', en: 'Fugue', pinyin: 'wangguiren', aliases: ['Tingyun5S'] },
    { zh: '大黑塔', en: 'The Herta', pinyin: 'daheita', aliases: ['Herta5S'] },
    { zh: '阿格莱雅', en: 'Aglaea', pinyin: 'agelaiya' },
    { zh: '缇宝', en: 'Tribbie', pinyin: 'tibao' },
    { zh: '万敌', en: 'Mydei', pinyin: 'wandi' },
    { zh: '遐蝶', en: 'Castorice', pinyin: 'xiadie' },
    { zh: '那刻夏', en: 'Anaxa', pinyin: 'nakexia' },
    { zh: '风堇', en: 'Hyacine', pinyin: 'fengjin' },
    { zh: '赛飞儿', en: 'Cipher', pinyin: 'saifeier' },
    { zh: '白厄', en: 'Phainon', pinyin: 'baie' },
    { zh: 'Saber', en: 'Saber', pinyin: 'saber' },
    { zh: 'Archer', en: 'Archer', pinyin: 'archer' },
    { zh: '海瑟音', en: 'Hysilens', pinyin: 'haiseyin' },
    { zh: '刻律德菈', en: 'Cerydra', pinyin: 'kelvdela' },
    { zh: '长夜月', en: 'Evernight', pinyin: 'changyeyue' },
    { zh: '昔涟', en: 'Cyrene', pinyin: 'xilian' },
    { zh: '大丽花', en: 'The Dahlia', pinyin: 'dalihua', aliases: ['Dahlia'] },
    { zh: '爻光', en: 'Yao Guang', pinyin: 'yaoguang', aliases: ['Yaoguang'] },
    { zh: '火花', en: 'Sparxie', pinyin: 'huohua' },
    { zh: '不死途', en: 'Ashveil', pinyin: 'busitu' },
    { zh: '绯英', en: 'Evanescia', pinyin: 'feiying' },
    { zh: '白露', en: 'Bailu', pinyin: 'bailu' },
    { zh: '克拉拉', en: 'Clara', pinyin: 'kelala' },
    { zh: '杰帕德', en: 'Gepard', pinyin: 'jiepade' },
    { zh: '彦卿', en: 'Yanqing', pinyin: 'yanqing' },
    { zh: '黑塔', en: 'Herta', pinyin: 'heita' },
    { zh: '停云', en: 'Tingyun', pinyin: 'tingyun' },
    { zh: '青雀', en: 'Qingque', pinyin: 'qingque' },
    { zh: '佩拉', en: 'Pela', pinyin: 'peila' },
    { zh: '艾丝妲', en: 'Asta', pinyin: 'aisida' },
    { zh: '娜塔莎', en: 'Natasha', pinyin: 'natasha' },
    { zh: '素裳', en: 'Sushang', pinyin: 'sushang' },
    { zh: '希露瓦', en: 'Serval', pinyin: 'xiluwa' },
    { zh: '桑博', en: 'Sampo', pinyin: 'sangbo' },
    { zh: '虎克', en: 'Hook', pinyin: 'huke' },
    { zh: '阿兰', en: 'Arlan', pinyin: 'alan' },
    { zh: '驭空', en: 'Yukong', pinyin: 'yukong' },
    { zh: '卢卡', en: 'Luka', pinyin: 'luka' },
    { zh: '玲可', en: 'Lynx', pinyin: 'lingke' },
    { zh: '桂乃芬', en: 'Guinaifen', pinyin: 'guinaifen' },
    { zh: '寒鸦', en: 'Hanya', pinyin: 'hanya' },
    { zh: '雪衣', en: 'Xueyi', pinyin: 'xueyi' },
    { zh: '米沙', en: 'Misha', pinyin: 'misha' },
    { zh: '加拉赫', en: 'Gallagher', pinyin: 'jialahe' },
    { zh: '貊泽', en: 'Moze', pinyin: 'moze' },
    { zh: '光锥', en: 'Light Cone', pinyin: 'guangzhui', aliases: ['Weapons', 'Weapon', 'LightCone', '光椎'], kind: 'utility' },
    { zh: 'UI', en: 'UI', pinyin: 'ui', kind: 'utility' },
    { zh: '功能', en: 'Function', pinyin: 'gongneng', aliases: ['Functions', 'Tools'], kind: 'utility' },
    { zh: '大世界', en: 'OpenWorld', pinyin: 'dashijie', aliases: ['Open World'], kind: 'utility' },
    { zh: 'NPC', en: 'NPC', pinyin: 'npc', kind: 'utility' },
    { zh: '其他', en: 'Others', pinyin: 'qita', aliases: ['Other'], kind: 'utility' }
  ],
  zzz: [
    { zh: '男主', en: 'Wise', pinyin: 'nanzhu', aliases: ['哲', 'zhe'] },
    { zh: '女主', en: 'Belle', pinyin: 'nvzhu', aliases: ['铃', '玲', 'ling'] },
    { zh: '雅', en: 'Miyabi', pinyin: 'ya', aliases: ['星见雅', 'Hoshimi Miyabi', 'xingjianya'] },
    { zh: '艾莲', en: 'Ellen', pinyin: 'ailian', aliases: ['Ellen Joe', '艾莲乔'] },
    { zh: '朱鸢', en: 'Zhu Yuan', pinyin: 'zhuyuan', aliases: ['ZhuYuan'] },
    { zh: '青衣', en: 'Qingyi', pinyin: 'qingyi' },
    { zh: '简', en: 'Jane', pinyin: 'jian', aliases: ['Jane Doe', '简杜'] },
    { zh: '凯撒', en: 'Caesar', pinyin: 'kaisa', aliases: ['Caesar King'] },
    { zh: '柏妮思', en: 'Burnice', pinyin: 'bainisi', aliases: ['Burnice White'] },
    { zh: '柳', en: 'Yanagi', pinyin: 'liu', aliases: ['月城柳', 'Tsukishiro Yanagi', 'yuechengliu'] },
    { zh: '莱特', en: 'Lighter', pinyin: 'laite' },
    { zh: '悠真', en: 'Harumasa', pinyin: 'youzhen', aliases: ['浅羽悠真', 'Asaba Harumasa'] },
    { zh: '耀嘉音', en: 'Astra', pinyin: 'yaojiayin', aliases: ['Astra Yao'] },
    { zh: '伊芙琳', en: 'Evelyn', pinyin: 'yifulin', aliases: ['Evelyn Chevalier'] },
    { zh: '零号·安比', en: 'SSAnby', pinyin: 'linghaoanbi', aliases: ['Soldier 0 - Anby', '大安比'] },
    { zh: '扳机', en: 'Trigger', pinyin: 'banji', aliases: ['「扳机」'] },
    { zh: '薇薇安', en: 'Vivian', pinyin: 'weiweian', aliases: ['Vivian Banshee'] },
    { zh: '雨果', en: 'Hugo', pinyin: 'yuguo' },
    { zh: '仪玄', en: 'Yixuan', pinyin: 'yixuan' },
    { zh: '橘福福', en: 'Ju Fufu', pinyin: 'jufufu', aliases: ['JuFufu'] },
    { zh: '柚叶', en: 'Ukinami Yuzuha', pinyin: 'youye', aliases: ['UkinamiYuzuha', 'Yuzuha'] },
    { zh: '爱丽丝', en: 'Alice Thymefield', pinyin: 'ailisi', aliases: ['AliceThymefield', 'Alice'] },
    { zh: '席德', en: 'Seed', pinyin: 'xide', aliases: ['「席德」'] },
    { zh: '奥菲丝&鬼火', en: 'OrphieMagnusson', pinyin: 'aofeisi', aliases: ['Orphie Magnusson & Magus', '奥菲丝'] },
    { zh: '卢西娅', en: 'Lucia', pinyin: 'luxiya', aliases: ['Lucia Elowen'] },
    { zh: '伊德海莉', en: 'Yidhari', pinyin: 'yidehaili', aliases: ['Yidhari Murphy'] },
    { zh: '琉音', en: 'Dialyn', pinyin: 'liuyin' },
    { zh: '般岳', en: 'Banyue', pinyin: 'banyue' },
    { zh: '叶瞬光', en: 'Ye Shunguang', pinyin: 'yeshunguang', aliases: ['YeShunguang'] },
    { zh: '照', en: 'Zhao', pinyin: 'zhao' },
    { zh: '千夏', en: 'Sunna', pinyin: 'qianxia' },
    { zh: '爱芮', en: 'Aria', pinyin: 'airui' },
    { zh: '南宫羽', en: 'Nangong Yu', pinyin: 'nangongyu', aliases: ['NangongYu', '南宫玉'] },
    { zh: '希希芙', en: 'Cissia', pinyin: 'xixifu', aliases: ['茜茜娅'] },
    { zh: '普罗米娅', en: 'Promeia', pinyin: 'puluomiya' },
    { zh: '维琳娜', en: 'Velina', pinyin: 'weilinna' },
    { zh: '诺姆', en: 'Norma', pinyin: 'nuomu' },
    { zh: '佩洛伊斯', en: 'Pyrois', pinyin: 'peiluoyisi' },
    { zh: '安比', en: 'Anby', pinyin: 'anbi', aliases: ['Anby Demara'] },
    { zh: '妮可', en: 'Nicole', pinyin: 'nike', aliases: ['Nicole Demara'] },
    { zh: '比利', en: 'Billy', pinyin: 'bili', aliases: ['Billy Kid'] },
    { zh: '猫又', en: 'Nekomata', pinyin: 'maoyou', aliases: ['Nekomiya Mana'] },
    { zh: '11号', en: 'Soldier11', pinyin: '11hao', aliases: ['Soldier 11', '「11号」'] },
    { zh: '珂蕾妲', en: 'Koleda', pinyin: 'keleida', aliases: ['Koleda Belobog'] },
    { zh: '格莉丝', en: 'Grace', pinyin: 'gelisi', aliases: ['Grace Howard'] },
    { zh: '安东', en: 'Anton', pinyin: 'andong', aliases: ['Anton Ivanov'] },
    { zh: '本', en: 'Ben', pinyin: 'ben', aliases: ['Ben Bigger'] },
    { zh: '莱卡恩', en: 'Lycaon', pinyin: 'laikaen', aliases: ['Von Lycaon'] },
    { zh: '丽娜', en: 'Rina', pinyin: 'lina', aliases: ['Alexandrina Sebastian'] },
    { zh: '可琳', en: 'Corin', pinyin: 'kelin', aliases: ['Corin Wickes'] },
    { zh: '苍角', en: 'Soukaku', pinyin: 'cangjiao' },
    { zh: '露西', en: 'Lucy', pinyin: 'luxi' },
    { zh: '派派', en: 'Piper', pinyin: 'paipai', aliases: ['Piper Wheel'] },
    { zh: '赛斯', en: 'Seth', pinyin: 'saisi', aliases: ['Seth Lowell'] },
    { zh: '波可娜', en: 'Pulchra', pinyin: 'bokena', aliases: ['Pulchra Fellini'] },
    { zh: '潘引壶', en: 'Pan Yinhu', pinyin: 'panyinhu', aliases: ['PanYinhu'] },
    { zh: '真斗', en: 'Komano Manato', pinyin: 'zhendou', aliases: ['KomanoManato', 'Manato'] },
    { zh: '武器', en: 'Weapons', pinyin: 'wuqi', aliases: ['Weapon'], kind: 'utility' },
    { zh: 'UI', en: 'UI', pinyin: 'ui', kind: 'utility' },
    { zh: '功能', en: 'Function', pinyin: 'gongneng', aliases: ['Functions', 'Tools'], kind: 'utility' },
    { zh: '大世界', en: 'OpenWorld', pinyin: 'dashijie', aliases: ['Open World'], kind: 'utility' },
    { zh: 'NPC', en: 'NPC', pinyin: 'npc', kind: 'utility' },
    { zh: '其他', en: 'Others', pinyin: 'qita', aliases: ['Other', 'Character_Others'], kind: 'utility' }
  ],
  endfield: [
    { zh: '男主', en: 'EndministratorMale', pinyin: 'nanzhu', aliases: ['Endministrator', '管理员'] },
    { zh: '女主', en: 'EndministratorFemale', pinyin: 'nvzhu', aliases: ['EndministratorF'] },
    { zh: '佩丽卡', en: 'Perlica', pinyin: 'peilika' },
    { zh: '陈千语', en: 'ChenQianyu', pinyin: 'chenqianyu', aliases: ['Chen Qianyu', 'Chen', '陈'] },
    { zh: '莱万汀', en: 'Laevatain', pinyin: 'laiwanting' },
    { zh: '伊冯', en: 'Yvonne', pinyin: 'yifeng' },
    { zh: '洁尔佩塔', en: 'Gilberta', pinyin: 'jieerpeita' },
    { zh: '艾尔黛拉', en: 'Ardelia', pinyin: 'aierdaila' },
    { zh: '余烬', en: 'Ember', pinyin: 'yujin' },
    { zh: '别礼', en: 'LastRite', pinyin: 'bieli', aliases: ['Last Rite'] },
    { zh: '黎风', en: 'Lifeng', pinyin: 'lifeng' },
    { zh: '骏卫', en: 'Pogranichnik', pinyin: 'junwei' },
    { zh: '阿列什', en: 'Alesh', pinyin: 'alieshi' },
    { zh: '弧光', en: 'Arclight', pinyin: 'huguang' },
    { zh: '艾维文娜', en: 'Avywenna', pinyin: 'aiweiwenna' },
    { zh: '大潘', en: 'DaPan', pinyin: 'dapan', aliases: ['Da Pan'] },
    { zh: '昼雪', en: 'Snowshine', pinyin: 'zhouxue' },
    { zh: '狼卫', en: 'Wulfgard', pinyin: 'langwei' },
    { zh: '赛希', en: 'Xaihi', pinyin: 'saixi' },
    { zh: '秋栗', en: 'Akekuri', pinyin: 'qiuli' },
    { zh: '安塔尔', en: 'Antal', pinyin: 'antaer' },
    { zh: '卡契尔', en: 'Catcher', pinyin: 'kaqier' },
    { zh: '埃特拉', en: 'Estella', pinyin: 'aitela' },
    { zh: '萤石', en: 'Fluorite', pinyin: 'yingshi' },
    { zh: '汤汤', en: 'Tangtang', pinyin: 'tangtang' },
    { zh: '洛茜', en: 'Rossi', pinyin: 'luoxi' },
    { zh: '庄方宜', en: 'ZhuangFangyi', pinyin: 'zhuangfangyi', aliases: ['Zhuang Fangyi', 'fangyi', 'zhuangfy'] },
    { zh: '弭弗', en: 'MiFu', pinyin: 'mifu', aliases: ['Mi Fu'] },
    { zh: '卡繆', en: 'Camille', pinyin: 'kamiu', aliases: ['卡缪'] },
    { zh: '诀', en: 'Arcane', pinyin: 'jue', aliases: ['オクギ'] },
    { zh: '梨诺', en: 'Liino', pinyin: 'linuo', aliases: ['リーノ'] },
    { zh: '祀', en: 'Si', pinyin: 'si' },
    { zh: '提弗洛斯', en: 'Tiphlos', pinyin: 'tifuluosi' },
    { zh: '武器', en: 'Weapons', pinyin: 'wuqi', aliases: ['Weapon'], kind: 'utility' },
    { zh: 'UI', en: 'UI', pinyin: 'ui', kind: 'utility' },
    { zh: '功能', en: 'Function', pinyin: 'gongneng', aliases: ['Functions', 'Tools'], kind: 'utility' },
    { zh: '大世界', en: 'OpenWorld', pinyin: 'dashijie', aliases: ['Open World'], kind: 'utility' },
    { zh: 'NPC', en: 'NPC', pinyin: 'npc', kind: 'utility' },
    { zh: '其他', en: 'Others', pinyin: 'qita', aliases: ['Other'], kind: 'utility' }
  ],
  'neverness-to-everness': [
    { zh: '男主', en: 'Zero (Male)', pinyin: 'nanzhu', aliases: ['zero-male', 'ZeroMale'] },
    { zh: '女主', en: 'Zero (Female)', pinyin: 'nvzhu', aliases: ['zero-female', 'ZeroFemale'] },
    { zh: '薄荷', en: 'Mint', pinyin: 'bohe' },
    { zh: '早雾', en: 'Sayuri', pinyin: 'zaowu' },
    { zh: '娜娜莉', en: 'Nanally', pinyin: 'nanali' },
    { zh: '浔', en: 'Xun', pinyin: 'xun' },
    { zh: '法蒂亚', en: 'Fadia', pinyin: 'fadiya' },
    { zh: '阿德勒', en: 'Adler', pinyin: 'adele' },
    { zh: '翳', en: 'Skia', pinyin: 'yi' },
    { zh: '安魂曲', en: 'Requiem', pinyin: 'anhunqu', aliases: ['Lacrimosa'] },
    { zh: '九原', en: 'Jiuyuan', pinyin: 'jiuyuan' },
    { zh: '伊洛伊', en: 'Iroi', pinyin: 'yiluoyi' },
    { zh: '凛子', en: 'Lingko', pinyin: 'linzi' },
    { zh: '哈尼娅', en: 'Haniel', pinyin: 'haniya', aliases: ['哈尼尔'] },
    { zh: '哈索尔', en: 'Hathor', pinyin: 'hasuoer' },
    { zh: '埃德加', en: 'Edgar', pinyin: 'aidejia' },
    { zh: '小吱', en: 'Xiaozhi', pinyin: 'xiaozhi', aliases: ['Chiz'] },
    { zh: '尼察', en: 'Nitsa', pinyin: 'nicha' },
    { zh: '真红', en: 'Shinku', pinyin: 'zhenhong', aliases: ['沁红', 'qinhong', 'Qin Hong'] },
    { zh: '海月', en: 'Mitsuki', pinyin: 'haiyue' },
    { zh: '白藏', en: 'Baicang', pinyin: 'baicang' },
    { zh: '赤音', en: 'Akane', pinyin: 'chiyin' },
    { zh: '达芙迪尔', en: 'Daffodil', pinyin: 'dafudier' },
    { zh: '阿尔法德', en: 'Alphard', pinyin: 'aerfade' },
    { zh: '黑鸟', en: 'Black Bird', pinyin: 'heiniao', aliases: ['black-bird'] },
    { zh: '卡厄斯', en: 'Chaos', pinyin: 'kaesi' },
    { zh: '武器', en: 'Weapons', pinyin: 'wuqi', aliases: ['Weapon'], kind: 'utility' },
    { zh: '载具', en: 'Vehicles', pinyin: 'zaiju', aliases: ['Vehicle'], kind: 'utility' },
    { zh: 'UI', en: 'UI', pinyin: 'ui', kind: 'utility' },
    { zh: '功能', en: 'Function', pinyin: 'gongneng', aliases: ['Functions', 'Tools'], kind: 'utility' },
    { zh: '大世界', en: 'OpenWorld', pinyin: 'dashijie', aliases: ['Open World'], kind: 'utility' },
    { zh: 'NPC', en: 'NPC', pinyin: 'npc', kind: 'utility' },
    { zh: '其他', en: 'Others', pinyin: 'qita', aliases: ['Other'], kind: 'utility' }
  ]
}

function normalizeMatchText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/^disabled_/i, '')
    .replace(/[\s_\-·・&()（）【】[\]「」]/g, '')
}

function sanitizeRosterEntry(raw: unknown): RosterEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<RosterEntry>
  const zh = typeof item.zh === 'string' ? item.zh.trim() : ''
  if (!zh) return null
  const en = typeof item.en === 'string' ? item.en.trim() : ''
  const pinyin = typeof item.pinyin === 'string' ? item.pinyin.trim().toLowerCase() : ''
  const aliases = Array.isArray(item.aliases)
    ? Array.from(new Set(item.aliases.map((a) => String(a || '').trim()).filter(Boolean)))
    : undefined
  const kind: CharacterKind | undefined =
    item.kind === 'utility' ? 'utility' : item.kind === 'character' ? 'character' : undefined
  return { zh, en, pinyin, ...(aliases && aliases.length > 0 ? { aliases } : {}), ...(kind ? { kind } : {}) }
}

/**
 * 将内置词典与云端增量词典按 zh 合并（增量覆盖合并，绝不丢失内置保底词条）。
 */
export function getMergedRoster(gameId: GameId): RosterEntry[] {
  const builtin = BUILTIN_ROSTER[gameId] ?? []
  const remote = cachedRemoteRoster[gameId] ?? []
  if (remote.length === 0) return builtin

  const byKey = new Map<string, RosterEntry>()
  for (const item of builtin) {
    byKey.set(normalizeMatchText(item.zh), {
      ...item,
      aliases: item.aliases ? [...item.aliases] : undefined
    })
  }

  for (const rawRemote of remote) {
    const entry = sanitizeRosterEntry(rawRemote)
    if (!entry) continue
    const key = normalizeMatchText(entry.zh)
    const existing = byKey.get(key)
    if (existing) {
      const mergedAliases = Array.from(
        new Set([...(existing.aliases ?? []), ...(entry.aliases ?? [])])
      )
      byKey.set(key, {
        zh: existing.zh,
        en: entry.en || existing.en,
        pinyin: entry.pinyin || existing.pinyin,
        ...(mergedAliases.length > 0 ? { aliases: mergedAliases } : {}),
        kind: entry.kind ?? existing.kind
      })
    } else {
      byKey.set(key, entry)
    }
  }

  return Array.from(byKey.values())
}

export function getRosterMap(): Record<GameId, string[]> {
  const map = {} as Record<GameId, string[]>
  for (const game of GAMES) {
    const merged = getMergedRoster(game.id)
    const names = ['其他', ...merged.map((item) => item.zh).filter((zh) => zh !== '其他')]
    map[game.id] = Array.from(new Set(names))
  }
  return map
}

export async function loadRosterCache(baseDir: string): Promise<void> {
  const raw = await readJsonSafe<RosterCachePayload | null>(
    path.join(baseDir, ROSTER_CACHE_FILE),
    null
  )
  if (!raw || typeof raw !== 'object' || !raw.games) return
  const next: Partial<Record<GameId, RosterEntry[]>> = {}
  for (const [key, list] of Object.entries(raw.games)) {
    if (!isGameId(key) || !Array.isArray(list)) continue
    const clean = list.map(sanitizeRosterEntry).filter((x): x is RosterEntry => Boolean(x))
    if (clean.length > 0) next[key] = clean
  }
  cachedRemoteRoster = next
  cachedRemoteUpdatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined
}

export function getRosterStatus(remoteUrl?: string): RosterSyncStatus {
  const gameCounts = {} as Record<GameId, number>
  for (const game of GAMES) {
    gameCounts[game.id] = getMergedRoster(game.id).length
  }
  return {
    remoteUrl: (remoteUrl || DEFAULT_ROSTER_REMOTE_URL).trim(),
    updatedAt: cachedRemoteUpdatedAt,
    gameCounts,
    hasRemoteCache: Object.keys(cachedRemoteRoster).length > 0
  }
}

export async function syncRemoteRoster(
  baseDir: string,
  remoteUrl: string,
  fetcher: (url: string) => Promise<Response>
): Promise<RosterSyncResult> {
  const targetUrl = (remoteUrl || DEFAULT_ROSTER_REMOTE_URL).trim()
  if (!/^https?:\/\//i.test(targetUrl)) {
    return { ok: false, error: '词库更新地址必须以 http:// 或 https:// 开头' }
  }
  try {
    const response = await fetcher(targetUrl)
    if (!response.ok) {
      return {
        ok: false,
        error: `拉取失败（HTTP ${response.status}），请检查网络或词库 URL 是否存在`
      }
    }
    const data = (await response.json()) as Record<string, unknown>
    if (!data || typeof data !== 'object') {
      return { ok: false, error: '远程 roster.json 格式不正确' }
    }
    const rawGames =
      data.games && typeof data.games === 'object'
        ? (data.games as Record<string, unknown>)
        : data

    const parsedGames: Partial<Record<GameId, RosterEntry[]>> = {}
    let totalEntries = 0
    for (const game of GAMES) {
      const arr = rawGames[game.id]
      if (!Array.isArray(arr)) continue
      const clean = arr.map(sanitizeRosterEntry).filter((x): x is RosterEntry => Boolean(x))
      if (clean.length > 0) {
        parsedGames[game.id] = clean
        totalEntries += clean.length
      }
    }

    if (totalEntries === 0) {
      return { ok: false, error: '远程 JSON 中没有找到有效游戏角色词条' }
    }

    const updatedAt = new Date().toISOString()
    cachedRemoteRoster = parsedGames
    cachedRemoteUpdatedAt = updatedAt
    await writeJsonAtomic(path.join(baseDir, ROSTER_CACHE_FILE), {
      updatedAt,
      remoteUrl: targetUrl,
      games: parsedGames
    })

    return {
      ok: true,
      updatedAt,
      addedOrUpdated: totalEntries,
      status: getRosterStatus(targetUrl)
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function containsToken(haystackRaw: string, tokenRaw: string): boolean {
  const token = tokenRaw.trim()
  if (!token) return false
  if (/^[a-z0-9\s_-]+$/i.test(token)) {
    const cleanToken = normalizeMatchText(token)
    if (!cleanToken) return false
    if (cleanToken.length <= 2) {
      // Short ASCII tokens like "ui", "si", "yi" require word boundaries
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i')
      return regex.test(haystackRaw)
    }
    return normalizeMatchText(haystackRaw).includes(cleanToken)
  }
  // CJK or mixed token
  return haystackRaw.toLowerCase().includes(token.toLowerCase()) ||
    normalizeMatchText(haystackRaw).includes(normalizeMatchText(token))
}

/**
 * 匹配候选 Mod 所属的角色目录名。
 * 优先级：
 * 1. 已有的本地角色目录（folder / displayName / aliases）与其对应的内置中英/拼音词条
 * 2. 内置官方词表中的角色（名称、英文名、拼音、别名）
 * 3. 未匹配上则默认归入 "其他"
 */
export function matchCharacterForMod(
  gameId: GameId,
  existingCharacters: CharacterInfo[],
  textsToMatch: string[]
): { folder: string; reason: string } {
  const combinedRaw = textsToMatch.filter(Boolean).join(' / ')
  if (!combinedRaw.trim()) {
    return { folder: '其他', reason: '未匹配（默认其他）' }
  }

  const roster = getMergedRoster(gameId)
  const existingByNorm = new Map<string, CharacterInfo>()
  for (const char of existingCharacters) {
    existingByNorm.set(normalizeMatchText(char.folder), char)
    existingByNorm.set(normalizeMatchText(char.displayName), char)
    for (const alias of char.aliases) {
      if (alias) existingByNorm.set(normalizeMatchText(alias), char)
    }
  }

  type CandidateScore = {
    folder: string
    reason: string
    score: number
  }
  let best: CandidateScore | null = null

  const consider = (folder: string, token: string, label: string, bonus = 0) => {
    if (!containsToken(combinedRaw, token)) return
    const normLen = normalizeMatchText(token).length
    const isCjk = /[\u4e00-\u9fa5]/.test(token)
    const score = (isCjk ? normLen * 12 : normLen * 6) + bonus
    if (!best || score > best.score) {
      best = { folder, reason: `匹配「${label}」`, score }
    }
  }

  // 1. Match against existing local characters first
  for (const char of existingCharacters) {
    if (char.folder === '其他') continue
    consider(char.folder, char.folder, char.displayName, 20)
    if (char.displayName !== char.folder) {
      consider(char.folder, char.displayName, char.displayName, 20)
    }
    for (const alias of char.aliases) {
      consider(char.folder, alias, `${char.displayName} (${alias})`, 15)
    }
  }

  // 2. Match against built-in roster (mapping to existing folder if present, else zh folder)
  for (const entry of roster) {
    if (entry.zh === '其他') continue
    const matchedExisting =
      existingByNorm.get(normalizeMatchText(entry.zh)) ||
      existingByNorm.get(normalizeMatchText(entry.en)) ||
      existingByNorm.get(normalizeMatchText(entry.pinyin))
    const targetFolder = matchedExisting ? matchedExisting.folder : entry.zh
    const bonus = matchedExisting ? 15 : 0

    consider(targetFolder, entry.zh, entry.zh, bonus + 10)
    if (entry.en) consider(targetFolder, entry.en, `${entry.zh} (${entry.en})`, bonus + 8)
    if (entry.pinyin && entry.pinyin.length >= 3) {
      consider(targetFolder, entry.pinyin, `${entry.zh} (${entry.pinyin})`, bonus + 5)
    }
    for (const alias of entry.aliases ?? []) {
      consider(targetFolder, alias, `${entry.zh} (${alias})`, bonus + 6)
    }
  }

  const matchedBest = best as CandidateScore | null
  if (matchedBest) {
    return { folder: matchedBest.folder, reason: matchedBest.reason }
  }

  const existingOther =
    existingByNorm.get(normalizeMatchText('其他')) ||
    existingByNorm.get(normalizeMatchText('others'))
  return {
    folder: existingOther ? existingOther.folder : '其他',
    reason: '未匹配（默认其他）'
  }
}
