import { importMihomoYaml } from './mihomo/index.js'
import type { ImportResult } from './types.js'
import { importUriList } from './uri/index.js'
import { decodeBase64 } from './util.js'

export { importMihomoYaml } from './mihomo/index.js'
export type * from './types.js'
export { importUriList, parseProxyUri, type UriParseResult } from './uri/index.js'

const unknown = (code: 'EMPTY_INPUT' | 'UNKNOWN_FORMAT', message: string): ImportResult => ({
  format: 'unknown',
  proxies: [],
  warnings: [{ level: 'error', code, message }],
})

/** 顶层出现这些键时按 mihomo YAML 处理 */
const YAML_KEY_RE = /^(?:proxies|proxy-groups|rules|rule-providers)[ \t]*:/m
/** 某一行以 scheme:// 开头 */
const LINK_RE = /^[ \t]*[a-zA-Z][a-zA-Z0-9+.-]*:\/\//m

/**
 * 导入订阅内容，自动识别格式：
 * mihomo YAML → 明文链接列表 → Base64（标准 / URL-safe、有无 padding、允许换行）编码的链接列表
 */
export function importSubscription(text: string): ImportResult {
  const input = text.replace(/^﻿/, '')
  if (!input.trim()) return unknown('EMPTY_INPUT', 'input is empty')
  if (YAML_KEY_RE.test(input)) return importMihomoYaml(input)
  if (LINK_RE.test(input)) return importUriList(input)
  const decoded = decodeBase64(input)
  if (decoded !== null && LINK_RE.test(decoded)) return importUriList(decoded, 'base64-uri-list')
  return unknown('UNKNOWN_FORMAT', 'input is neither mihomo YAML, a link list nor base64')
}
