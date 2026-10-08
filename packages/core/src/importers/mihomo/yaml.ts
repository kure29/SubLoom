import {
  boolCoreTag,
  defineScalarTag,
  FAILSAFE_SCHEMA,
  loadAll,
  mergeTag,
  NOT_RESOLVED,
  nullCoreTag,
} from 'js-yaml'

/**
 * 只把规范的十进制数解析为数字。01、12e4、0x1F、1.0、超出安全整数的值保留原文：
 * mihomo 把它们读进字符串字段（如 short-id、password）时看到的也是原文。
 */
const DIGITS = ['-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

const intTag = defineScalarTag('tag:yaml.org,2002:int', {
  implicit: true,
  implicitFirstChars: DIGITS,
  resolve: (s) =>
    /^-?(?:0|[1-9][0-9]*)$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : NOT_RESOLVED,
  identify: (v) => Number.isInteger(v),
})

const floatTag = defineScalarTag('tag:yaml.org,2002:float', {
  implicit: true,
  implicitFirstChars: DIGITS,
  // .inf / .nan、指数形式保留原文
  resolve: (s) => (/^-?(?:0|[1-9][0-9]*)\.[0-9]*[1-9]$/.test(s) ? Number(s) : NOT_RESOLVED),
  identify: (v) => typeof v === 'number' && !Number.isInteger(v),
})

/** YAML 1.2 core schema（null、布尔值同 core），数字按上面的规则，支持合并键 `<<` */
const SCHEMA = FAILSAFE_SCHEMA.withTags(nullCoreTag, boolCoreTag, intTag, floatTag, mergeTag)

/**
 * 解析 YAML；失败时只返回行号，不返回包含原文的错误信息。
 * 用 js-yaml 而不是 yaml 库：500 个节点的订阅约快 10 倍（见 PLAN.md 5.6）。
 */
export function parseYaml(
  text: string,
): { ok: true; value: unknown } | { ok: false; line?: number } {
  try {
    // load 不接受空文档，所以用 loadAll：没有文档时为 null，多个文档视为错误（与 yaml 库一致）
    const docs = loadAll(text, {
      schema: SCHEMA,
      // 重复的键以后出现的为准（与 mihomo 使用的 go-yaml 不同，后者报错；这里尽量导入）
      json: true,
      // 机场订阅常给每个节点合并同一组公共字段，默认上限 10000 不够用
      maxTotalMergeKeys: 1_000_000,
    })
    if (docs.length > 1) return { ok: false }
    return { ok: true, value: docs[0] ?? null }
  } catch (e) {
    const line = (e as { mark?: { line?: number } }).mark?.line
    return typeof line === 'number' ? { ok: false, line: line + 1 } : { ok: false }
  }
}
