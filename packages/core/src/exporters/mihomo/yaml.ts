/**
 * 生成 mihomo 配置用的 YAML。导出的数据只有映射、序列、字符串、数字、布尔值和 null，
 * 直接拼接字符串比通用 YAML 库快一个数量级（500 节点约 40ms → 2ms，见 PLAN.md 5.6）。
 * 输出风格与 `yaml` 库（lineWidth: 0）一致：块映射、缩进的块序列、能用普通标量时不加引号。
 */

/**
 * mihomo 用 go-yaml v3 读取配置：除 YAML 1.2 core schema 外，它还会把 0777、0b101、1_000
 * 这类写法读成数字，旧版 YAML 1.1 还会把 yes/no/on/off 读成布尔值。
 * 这些字符串一律加引号，保证读到的仍是字符串。
 */
const AMBIGUOUS =
  /^(?:[-+]?[0-9][0-9_]*|[-+]?0[xX][0-9a-fA-F_]+|[-+]?0[oO][0-7_]+|[-+]?0[bB][01_]+|[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?[eE][-+]?[0-9]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~|<<|=)$/

/** 不能写成普通标量的字符串（与 yaml 库的判断相同）：以指示符开头、含 ": " " #"、首尾空白等 */
const NOT_PLAIN =
  /^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$|^(?:---|\.\.\.)/

/** 换行、控制字符（制表符除外）和孤立代理项只能写在双引号中 */
function needsDouble(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 ? c !== 0x09 : c >= 0x7f && c <= 0x9f) return true
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1)
      if (c > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    }
  }
  return false
}

/** AMBIGUOUS 能匹配的字符串只可能以这些字符开头；其余跳过这个较慢的正则 */
const AMBIGUOUS_FIRST = new Set('0123456789+-.yYnNtTfFoO~<=')

function scalarString(s: string): string {
  const double = needsDouble(s)
  if (
    s !== '' &&
    !double &&
    !NOT_PLAIN.test(s) &&
    !(AMBIGUOUS_FIRST.has(s[0] as string) && AMBIGUOUS.test(s))
  ) {
    return s
  }
  // 只含双引号时用单引号，与 yaml 库一致；其余用双引号（JSON 字符串是合法的 YAML 双引号标量）
  if (!double && s.includes('"') && !s.includes("'")) {
    return `'${s.replace(/'/g, "''")}'`
  }
  return doubleQuoted(s)
}

/**
 * JSON 字符串是合法的 YAML 双引号标量；JSON.stringify 已转义 C0 控制字符和孤立代理项，
 * 这里再转义 DEL 和 C1 控制字符（go-yaml 把 U+0085 当作换行）。
 */
function doubleQuoted(s: string): string {
  const json = JSON.stringify(s)
  let out = ''
  let start = 0
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i)
    if (c >= 0x7f && c <= 0x9f) {
      out += `${json.slice(start, i)}\\u00${c.toString(16)}`
      start = i + 1
    }
  }
  return start ? out + json.slice(start) : json
}

function scalar(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return scalarString(v)
    case 'number':
      if (Number.isFinite(v)) return String(v)
      return Number.isNaN(v) ? '.nan' : v > 0 ? '.inf' : '-.inf'
    case 'boolean':
      return v ? 'true' : 'false'
    default:
      if (v === null || v === undefined) return 'null'
      throw new TypeError(`cannot write ${typeof v} to YAML`)
  }
}

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 映射的键大多重复出现（name、type、server……），缓存它们的写法 */
const keyCache = new Map<string, string>()

function keyString(k: string): string {
  let out = keyCache.get(k)
  if (out === undefined) {
    out = scalarString(k)
    if (keyCache.size < 1000) keyCache.set(k, out)
  }
  return out
}

/** 值不是 undefined 的键（与 yaml 库一样跳过 undefined） */
function definedKeys(v: Record<string, unknown>): string[] {
  const keys = Object.keys(v)
  for (const k of keys) if (v[k] === undefined) return keys.filter((x) => v[x] !== undefined)
  return keys
}

/** 写一个值：标量和空容器跟在 head 后面同一行，非空容器另起一行 */
function writeValue(out: string[], head: string, v: unknown, indent: string): void {
  if (Array.isArray(v)) {
    if (!v.length) out.push(`${head} []`)
    else {
      out.push(head)
      writeSeq(out, v, `${indent}  `)
    }
  } else if (isMap(v)) {
    const keys = definedKeys(v)
    if (!keys.length) out.push(`${head} {}`)
    else {
      out.push(head)
      writeMap(out, v, keys, `${indent}  `)
    }
  } else {
    out.push(`${head} ${scalar(v)}`)
  }
}

function writeMap(
  out: string[],
  map: Record<string, unknown>,
  keys: string[],
  indent: string,
): void {
  for (const k of keys) writeValue(out, `${indent}${keyString(k)}:`, map[k], indent)
}

/** 序列项：映射的第一个键和嵌套序列的第一项写在 "- " 同一行 */
function writeSeq(out: string[], items: unknown[], indent: string): void {
  for (const item of items) {
    const v = item === undefined ? null : item
    const start = out.length
    const keys = isMap(v) ? definedKeys(v) : undefined
    if (isMap(v) && keys?.length) {
      writeMap(out, v, keys, `${indent}  `)
    } else if (Array.isArray(v) && v.length) {
      writeSeq(out, v, `${indent}  `)
    } else {
      writeValue(out, `${indent}-`, v, indent)
      continue
    }
    out[start] = `${indent}- ${(out[start] as string).slice(indent.length + 2)}`
  }
}

/** 顶层必须是映射 */
export function stringifyYaml(doc: Record<string, unknown>): string {
  const out: string[] = []
  writeMap(out, doc, definedKeys(doc), '')
  return out.length ? `${out.join('\n')}\n` : '{}\n'
}
