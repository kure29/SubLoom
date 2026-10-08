#!/usr/bin/env node
// 在部署好的 SubLoom 实例上跑一遍 500 节点的完整链路，用于在 Cloudflare 控制台查看每次请求的 CPU 时间。
// Workers 运行时里的计时函数在同步执行期间不前进，代码中无法自己测量 CPU 时间，见 PLAN.md 第 9 节 M5 的验收步骤。
//
// 用法（先在仓库根目录执行 pnpm build）：
//   SUBLOOM_URL=https://subloom.<你的子域>.workers.dev SUBLOOM_ADMIN_TOKEN=<管理令牌> node scripts/workers-perf.mjs
// 可选：ROUNDS（每种请求的次数，默认 5）、KEEP=1（结束后保留创建的订阅、profile 和输出）。
//
// 依次请求：刷新本地订阅（解析 500 节点）、preview（流水线 + 导出 mihomo / Surge，不走缓存）、
// 输出链接（第一次生成，之后命中缓存）。脚本打印的是客户端看到的总耗时（含网络），不是 CPU 时间。
import { createTemplate, exportMihomo, importMihomoYaml } from '../packages/core/dist/index.js'

// 不经过 turbo 运行，环境变量不需要在 turbo.json 中声明
const { SUBLOOM_URL, SUBLOOM_ADMIN_TOKEN, ROUNDS, KEEP } = process.env
const base = SUBLOOM_URL?.replace(/\/+$/, '')
const token = SUBLOOM_ADMIN_TOKEN
const rounds = Number(ROUNDS ?? 5)
if (!base || !token || !Number.isInteger(rounds) || rounds < 1) {
  console.error(
    'usage: SUBLOOM_URL=... SUBLOOM_ADMIN_TOKEN=... [ROUNDS=5] node scripts/workers-perf.mjs',
  )
  process.exit(1)
}

// 与 packages/core/test/perf/chain.ts 相同的 500 个节点与流水线
const REGIONS = ['🇭🇰 香港', '🇯🇵 日本', '🇺🇸 美国', '🇸🇬 新加坡', '🇹🇼 台湾', '🇰🇷 韩国', '🇬🇧 英国']
const UUID = '00000000-0000-4000-8000-000000000000'
function mihomoProxy(i) {
  const name = `${REGIONS[i % REGIONS.length]} ${String(i + 1).padStart(3, '0')}`
  const server = `node${i}.example.com`
  switch (i % 5) {
    case 0:
      return {
        name,
        type: 'ss',
        server,
        port: 8388,
        cipher: 'aes-256-gcm',
        password: `p${i}`,
        udp: true,
      }
    case 1:
      return {
        name,
        type: 'vmess',
        server,
        port: 443,
        uuid: UUID,
        alterId: 0,
        cipher: 'auto',
        tls: true,
        servername: server,
        network: 'ws',
        'ws-opts': { path: '/ws', headers: { Host: server } },
      }
    case 2:
      return { name, type: 'trojan', server, port: 443, password: `p${i}`, sni: server, udp: true }
    case 3:
      return { name, type: 'hysteria2', server, port: 443, password: `p${i}`, sni: server }
    default:
      return {
        name,
        type: 'vless',
        server,
        port: 443,
        uuid: UUID,
        flow: 'xtls-rprx-vision',
        tls: true,
        servername: 'www.example.com',
        'client-fingerprint': 'chrome',
        'reality-opts': { 'public-key': 'K'.repeat(43), 'short-id': '01' },
      }
  }
}
const PIPELINE = [
  { op: 'filter-regex', pattern: '剩余流量|套餐到期|官网', mode: 'drop' },
  { op: 'rename-regex', pattern: '\\s+', replace: ' ' },
  { op: 'add-flag' },
  { op: 'sort', by: 'region', order: 'asc' },
  { op: 'dedupe', by: 'server' },
  { op: 'prefix', text: '[A] ' },
]

// JSON 也是合法的 YAML：先用 mihomo 导入器读成 IR，再导出成 mihomo YAML 作为订阅内容
const json = JSON.stringify({ proxies: Array.from({ length: 500 }, (_, i) => mihomoProxy(i)) })
const empty = { version: 1, name: 'perf', proxies: [], groups: [], rules: [], ruleSets: [] }
const subscription = exportMihomo(empty, importMihomoYaml(json).proxies).text

const timings = []
async function call(method, path, body, auth = true, label = undefined) {
  const started = performance.now()
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const shown = path
    .replace(/\/sub\/[^/?]+/, '/sub/<token>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')
  timings.push({
    request: `${method} ${shown}${label ? ` (${label})` : ''}`,
    ms: performance.now() - started,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text.startsWith('{') ? text : '{}') : {}
}

const startedAt = new Date()
const meta = await call('GET', '/api/meta')
console.log(`platform: ${meta.platform}, version: ${meta.version}`)

let sourceId
let profileId
try {
  sourceId = (
    await call('POST', '/api/sources', { name: 'perf-500', kind: 'local', content: subscription })
  ).source.id
  for (let i = 0; i < rounds; i++) {
    const r = await call('POST', `/api/sources/${sourceId}/refresh`)
    if (r.nodeCount !== 500) throw new Error(`expected 500 nodes, got ${r.nodeCount}`)
  }
  profileId = (
    await call('POST', '/api/profiles', {
      ir: createTemplate('common', { locale: 'zh-CN' }),
      pipeline: PIPELINE,
      sourceIds: [sourceId],
    })
  ).profile.id
  for (const target of ['mihomo', 'surge']) {
    for (let i = 0; i < rounds; i++)
      await call('POST', `/api/profiles/${profileId}/preview?target=${target}`)
  }
  for (const target of ['mihomo', 'surge']) {
    const output = (await call('POST', '/api/outputs', { profileId, target })).output
    for (let i = 0; i < rounds; i++) await call('GET', output.path, undefined, false, target)
  }
} finally {
  if (KEEP !== '1') {
    if (profileId) await call('DELETE', `/api/profiles/${profileId}`).catch(() => {})
    if (sourceId) await call('DELETE', `/api/sources/${sourceId}`).catch(() => {})
  }
}

const groups = new Map()
for (const t of timings) groups.set(t.request, [...(groups.get(t.request) ?? []), t.ms])
console.log('\nclient-side total time (including network, NOT CPU time):')
for (const [request, ms] of groups) {
  const sorted = ms.toSorted((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  console.log(
    `  ${request.padEnd(52)} n=${String(ms.length).padStart(2)}  median ${median.toFixed(0)} ms`,
  )
}
console.log(`
Requests were sent between ${startedAt.toISOString()} and ${new Date().toISOString()}.
Now open the Cloudflare dashboard → Workers & Pages → subloom:
  - Metrics: "CPU Time per execution" (percentiles over time)
  - Observability: the invocation log of each request shows its CPU Time and Wall Time;
    in the Query Builder, filter by the request path above and compute the median / P90 of CPU Time.
Requests that exceeded the CPU limit have the outcome "exceededCpu" (HTTP 503 / error 1102).`)
