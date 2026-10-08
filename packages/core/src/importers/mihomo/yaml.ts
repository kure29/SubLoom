import { parse, type Tags } from 'yaml'

const INT = 'tag:yaml.org,2002:int'
const FLOAT = 'tag:yaml.org,2002:float'

/**
 * 只把规范的十进制数解析为数字。01、12e4、0x1F、1.0、超出安全整数的值保留原文：
 * mihomo 把它们读进字符串字段（如 short-id、password）时看到的也是原文。
 */
function customTags(tags: Tags): Tags {
  const out: Tags = []
  for (const t of tags) {
    if (typeof t !== 'object' || (t.tag !== INT && t.tag !== FLOAT)) {
      out.push(t)
      continue
    }
    if (t.format !== undefined || !('test' in t) || !t.test) continue
    if (t.tag === INT) {
      out.push({
        ...t,
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (s: string) => (Number.isSafeInteger(Number(s)) ? Number(s) : s),
      })
    } else if (String(t.test).includes('inf')) {
      // .inf / .nan 保留原文
    } else {
      out.push({
        ...t,
        test: /^-?(?:0|[1-9][0-9]*)\.[0-9]*[1-9]$/,
        resolve: (s: string) => Number(s),
      })
    }
  }
  return out
}

/** 解析 YAML；失败时只返回行号，不返回包含原文的错误信息 */
export function parseYaml(
  text: string,
): { ok: true; value: unknown } | { ok: false; line?: number } {
  try {
    return { ok: true, value: parse(text, { merge: true, uniqueKeys: false, customTags }) }
  } catch (e) {
    const line = (e as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line
    return line === undefined ? { ok: false } : { ok: false, line }
  }
}
