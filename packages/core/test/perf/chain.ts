import { stringify } from 'yaml'
import {
  createTemplate,
  type Exporter,
  importSubscription,
  type PipelineOp,
  runPipeline,
} from '../../src/index.js'

/** 性能基准的节点数（PLAN.md 5.6、第 8 节） */
export const NODE_COUNT = 500

const REGIONS = ['🇭🇰 香港', '🇯🇵 日本', '🇺🇸 美国', '🇸🇬 新加坡', '🇹🇼 台湾', '🇰🇷 韩国', '🇬🇧 英国']

/** 确定性生成的 mihomo 节点：常见协议轮流出现，名称带地区，像典型的机场订阅 */
function mihomoProxy(i: number): Record<string, unknown> {
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
        uuid: '00000000-0000-4000-8000-000000000000',
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
        uuid: '00000000-0000-4000-8000-000000000000',
        flow: 'xtls-rprx-vision',
        tls: true,
        servername: 'www.example.com',
        'client-fingerprint': 'chrome',
        'reality-opts': { 'public-key': 'K'.repeat(43), 'short-id': '01' },
      }
  }
}

/** 500 个节点的 mihomo YAML 订阅 */
export const SUBSCRIPTION = stringify({
  proxies: Array.from({ length: NODE_COUNT }, (_, i) => mihomoProxy(i)),
})

/** 典型的流水线：去掉信息节点、改名、按地区排序、去重、加前缀 */
export const PIPELINE: PipelineOp[] = [
  { op: 'filter-regex', pattern: '剩余流量|套餐到期|官网', mode: 'drop' },
  { op: 'rename-regex', pattern: '\\s+', replace: ' ' },
  { op: 'add-flag' },
  { op: 'sort', by: 'region', order: 'asc' },
  { op: 'dedupe', by: 'server' },
  { op: 'prefix', text: '[A] ' },
]

/** 完整链路：解析 → 流水线 → 常用分流模板 → 导出 */
export function runChain(exporter: Exporter, text = SUBSCRIPTION) {
  const imported = importSubscription(text)
  const { nodes } = runPipeline(imported.proxies, PIPELINE)
  return exporter.export(createTemplate('common'), nodes)
}
