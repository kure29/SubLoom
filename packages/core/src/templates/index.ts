import type { GroupMember, Profile, ProxyGroup, Rule, RuleSet } from '../ir/index.js'

export const TEMPLATE_IDS = ['minimal', 'common'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]
export type TemplateLocale = 'zh-CN' | 'en'

/** 模板中出现的名称；只有这些随语言变化 */
const NAMES = {
  'zh-CN': {
    minimal: '极简',
    common: '常用分流',
    proxy: '节点选择',
    auto: '自动选择',
    ai: 'AI 服务',
    youtube: 'YouTube',
    google: '谷歌服务',
    telegram: '电报消息',
    microsoft: '微软服务',
    final: '漏网之鱼',
  },
  en: {
    minimal: 'Minimal',
    common: 'Common Routing',
    proxy: 'Proxy',
    auto: 'Auto',
    ai: 'AI',
    youtube: 'YouTube',
    google: 'Google',
    telegram: 'Telegram',
    microsoft: 'Microsoft',
    final: 'Final',
  },
} satisfies Record<TemplateLocale, Record<string, string>>
type Names = (typeof NAMES)[TemplateLocale]

const TEST_URL = 'https://www.gstatic.com/generate_204'
const group = (name: string): GroupMember => ({ kind: 'group', name })
const DIRECT: GroupMember = { kind: 'builtin', name: 'DIRECT' }

function baseGroups(n: Names): ProxyGroup[] {
  return [
    { name: n.proxy, type: 'select', members: [group(n.auto), DIRECT], includeAllProxies: true },
    {
      name: n.auto,
      type: 'url-test',
      members: [],
      includeAllProxies: true,
      testUrl: TEST_URL,
      interval: 300,
      tolerance: 50,
    },
  ]
}

/** 局域网直连（内联，不依赖规则集） */
const LAN_RULES: Rule[] = [
  { type: 'DOMAIN-SUFFIX', value: 'local', target: 'DIRECT' },
  ...['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'].map(
    (value): Rule => ({ type: 'IP-CIDR', value, noResolve: true, target: 'DIRECT' }),
  ),
  ...['::1/128', 'fc00::/7', 'fe80::/10'].map(
    (value): Rule => ({ type: 'IP-CIDR6', value, noResolve: true, target: 'DIRECT' }),
  ),
]

const GEOIP_CN: Rule = { type: 'GEOIP', value: 'CN', target: 'DIRECT' }

function minimal(n: Names): Profile {
  return {
    version: 1,
    name: n.minimal,
    proxies: [],
    groups: baseGroups(n),
    rules: [...LAN_RULES, GEOIP_CN, { type: 'MATCH', target: n.proxy }],
    ruleSets: [],
  }
}

const RULES_BASE = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule'

/**
 * 引用 blackmatrix7/ios_rule_script 中可单独使用的规则文件（同名文件同时提供各客户端格式）。
 * 只引用 URL，不复制内容。
 */
function blackmatrix7(id: string, dir: string): RuleSet {
  const list = (client: string) => ({
    url: `${RULES_BASE}/${client}/${dir}/${dir}.list`,
    format: 'list' as const,
  })
  return {
    id,
    name: dir,
    behavior: 'classical',
    sources: {
      mihomo: { url: `${RULES_BASE}/Clash/${dir}/${dir}.yaml`, format: 'yaml' },
      surge: list('Surge'),
      shadowrocket: list('Shadowrocket'),
      loon: list('Loon'),
    },
    interval: 86400,
  }
}

function common(n: Names): Profile {
  const service = (name: string, members: GroupMember[]): ProxyGroup => ({
    name,
    type: 'select',
    members,
    includeAllProxies: true,
  })
  const proxied = [group(n.proxy), group(n.auto), DIRECT]
  const set = (id: string, target: string, noResolve?: true): Rule =>
    noResolve
      ? { type: 'RULE-SET', value: id, noResolve, target }
      : { type: 'RULE-SET', value: id, target }
  return {
    version: 1,
    name: n.common,
    proxies: [],
    groups: [
      ...baseGroups(n),
      service(n.ai, [group(n.proxy), group(n.auto)]),
      service(n.youtube, proxied),
      service(n.google, proxied),
      service(n.telegram, proxied),
      service(n.microsoft, [DIRECT, group(n.proxy), group(n.auto)]),
      { name: n.final, type: 'select', members: [group(n.proxy), DIRECT] },
    ],
    rules: [
      set('lan', 'DIRECT', true),
      set('openai', n.ai),
      set('claude', n.ai),
      set('gemini', n.ai),
      // YouTube 的域名也在 Google 规则中，需要排在前面
      set('youtube', n.youtube),
      set('google', n.google),
      set('telegram', n.telegram, true),
      set('microsoft', n.microsoft),
      GEOIP_CN,
      { type: 'MATCH', target: n.final },
    ],
    ruleSets: [
      blackmatrix7('lan', 'Lan'),
      blackmatrix7('openai', 'OpenAI'),
      blackmatrix7('claude', 'Claude'),
      blackmatrix7('gemini', 'Gemini'),
      blackmatrix7('youtube', 'YouTube'),
      blackmatrix7('google', 'Google'),
      blackmatrix7('telegram', 'Telegram'),
      blackmatrix7('microsoft', 'Microsoft'),
    ],
  }
}

const BUILDERS: Record<TemplateId, (n: Names) => Profile> = { minimal, common }

/** 预设模板：不含节点的 Profile，策略组通过 includeAllProxies 包含订阅节点 */
export function createTemplate(id: TemplateId, opts: { locale?: TemplateLocale } = {}): Profile {
  // 内部共用的规则对象不能泄露给调用方
  return structuredClone(BUILDERS[id](NAMES[opts.locale ?? 'zh-CN']))
}
