/**
 * 内置地区表：ISO 3166-1 alpha-2 代码 → 节点名中常见的写法。
 * 表的顺序即 sort by region 的顺序（机场常见地区在前）。
 */
interface Region {
  code: string
  /** 中文名称与城市，按子串匹配 */
  zh: string[]
  /** 英文名称与城市，忽略大小写，按单词边界匹配 */
  en: string[]
  /**
   * 大写代码，区分大小写，按单词边界匹配。
   * 容易误判的代码不放在这里，如 GB（流量单位）、ID、IN（常见英文单词）。
   */
  codes: string[]
}

const r = (code: string, zh: string[], en: string[], codes: string[] = [code]): Region => ({
  code,
  zh,
  en,
  codes,
})

export const REGIONS: readonly Region[] = [
  r('HK', ['香港', '港'], ['Hong Kong', 'HongKong'], ['HK', 'HKG']),
  r('TW', ['台湾', '臺灣', '台北', '新北', '高雄'], ['Taiwan', 'Taipei'], ['TW', 'TWN']),
  r('JP', ['日本', '东京', '東京', '大阪'], ['Japan', 'Tokyo', 'Osaka'], ['JP', 'JPN']),
  r('KR', ['韩国', '韓國', '首尔', '首爾', '春川'], ['Korea', 'Seoul'], ['KR', 'KOR']),
  r('SG', ['新加坡', '狮城', '獅城'], ['Singapore'], ['SG', 'SGP']),
  r(
    'US',
    ['美国', '美國', '洛杉矶', '圣何塞', '西雅图', '纽约', '芝加哥', '达拉斯', '硅谷', '凤凰城'],
    [
      'United States',
      'America',
      'Los Angeles',
      'San Jose',
      'Seattle',
      'New York',
      'Chicago',
      'Dallas',
      'Silicon Valley',
    ],
    ['US', 'USA'],
  ),
  r(
    'GB',
    ['英国', '英國', '伦敦', '倫敦'],
    ['United Kingdom', 'Britain', 'England', 'London'],
    ['UK', 'GBR'],
  ),
  r('DE', ['德国', '德國', '法兰克福'], ['Germany', 'Frankfurt'], ['DE', 'DEU']),
  r('FR', ['法国', '法國', '巴黎'], ['France', 'Paris'], ['FR', 'FRA']),
  r('NL', ['荷兰', '荷蘭', '阿姆斯特丹'], ['Netherlands', 'Amsterdam'], ['NL', 'NLD']),
  r('RU', ['俄罗斯', '俄羅斯', '莫斯科'], ['Russia', 'Moscow'], ['RU', 'RUS']),
  r('CA', ['加拿大', '多伦多', '温哥华'], ['Canada', 'Toronto', 'Vancouver'], ['CA', 'CAN']),
  r(
    'AU',
    ['澳大利亚', '澳洲', '悉尼', '墨尔本'],
    ['Australia', 'Sydney', 'Melbourne'],
    ['AU', 'AUS'],
  ),
  r('IN', ['印度', '孟买'], ['India', 'Mumbai'], ['IND']),
  r('ID', ['印度尼西亚', '印尼', '雅加达'], ['Indonesia', 'Jakarta'], ['IDN']),
  r('MY', ['马来西亚', '吉隆坡'], ['Malaysia', 'Kuala Lumpur'], ['MY', 'MYS']),
  r('TH', ['泰国', '曼谷'], ['Thailand', 'Bangkok'], ['TH', 'THA']),
  r('VN', ['越南', '胡志明'], ['Vietnam'], ['VN', 'VNM']),
  r('PH', ['菲律宾', '马尼拉'], ['Philippines', 'Manila'], ['PH', 'PHL']),
  r('TR', ['土耳其', '伊斯坦布尔'], ['Turkey', 'Türkiye', 'Istanbul'], ['TR', 'TUR']),
  r('AR', ['阿根廷'], ['Argentina'], ['AR', 'ARG']),
  r('BR', ['巴西'], ['Brazil', 'Sao Paulo', 'São Paulo'], ['BR', 'BRA']),
  r('MO', ['澳门', '澳門'], ['Macau', 'Macao'], ['MO', 'MAC']),
  r('AE', ['阿联酋', '迪拜'], ['Dubai', 'UAE'], ['AE']),
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** ASCII 关键词前后不能紧挨字母，避免 US 误中 PLUS */
const word = (s: string) => `(?<![A-Za-z])${escapeRe(s)}(?![A-Za-z])`

/**
 * 关键词按长度降序排列，同一位置优先匹配更长的写法（印度尼西亚 优先于 印度）。
 * 位置靠前的关键词优先。
 */
function compile(entries: Array<[string, string]>, flags: string, wrap: (s: string) => string) {
  const sorted = [...entries].sort((a, b) => b[0].length - a[0].length)
  const lookup = new Map(
    sorted.map(([kw, code]) => [flags.includes('i') ? kw.toLowerCase() : kw, code]),
  )
  const re = new RegExp(sorted.map(([kw]) => wrap(kw)).join('|'), flags)
  return (name: string) => {
    const m = re.exec(name)
    if (!m) return undefined
    return lookup.get(flags.includes('i') ? m[0].toLowerCase() : m[0])
  }
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)

const matchName = compile(
  REGIONS.flatMap((g) => [...g.zh, ...g.en].map((kw): [string, string] => [kw, g.code])),
  'iu',
  (kw) => (isAscii(kw) ? word(kw) : escapeRe(kw)),
)
const matchCode = compile(
  REGIONS.flatMap((g) => g.codes.map((c): [string, string] => [c, g.code])),
  'u',
  word,
)

/** 国旗 emoji 由两个区域指示符组成 */
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u
const INDICATOR_A = 0x1f1e6

export const startsWithFlag = (name: string) => FLAG_RE.exec(name)?.index === 0

/** 由地区代码生成国旗 emoji，如 HK → 🇭🇰 */
export function flagOf(code: string): string {
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => INDICATOR_A + c.charCodeAt(0) - 65),
  )
}

function flagToCode(flag: string): string {
  return String.fromCharCode(...[...flag].map((c) => (c.codePointAt(0) ?? 0) - INDICATOR_A + 65))
}

/** 由节点名识别地区：优先看国旗，其次是中英文名称和城市，最后是大写代码 */
export function detectRegion(name: string): string | undefined {
  const flag = FLAG_RE.exec(name)
  if (flag) return flagToCode(flag[0])
  return matchName(name) ?? matchCode(name)
}

const ORDER = new Map(REGIONS.map((g, i) => [g.code, i]))

/** sort by region 的排序键：地区表中的按表顺序，其余已知地区按代码排在其后 */
export function regionRank(code: string): [number, string] {
  return [ORDER.get(code) ?? REGIONS.length, code]
}
