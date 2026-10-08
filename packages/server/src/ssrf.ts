// SSRF 检查：默认拒绝拉取私有和保留地址。地址范围见 PLAN.md 5.5。

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

export interface FetchPolicy {
  /** ALLOW_PRIVATE_FETCH：关闭私有地址检查（协议检查仍然生效） */
  allowPrivate: boolean
  /** DNS 解析（仅 Node 提供）。没有时只检查 IP 字面量和 localhost。 */
  resolveHost?: ((host: string) => Promise<string[]>) | undefined
}

type Cidr = readonly [prefix: readonly number[], bits: number]

const PRIVATE_V4: readonly Cidr[] = [
  [[0], 8], // 本网络
  [[10], 8],
  [[100, 64], 10], // 运营商级 NAT
  [[127], 8],
  [[169, 254], 16], // 链路本地（含云厂商元数据服务）
  [[172, 16], 12],
  [[192, 0, 0], 24], // IETF 协议分配
  [[192, 0, 2], 24], // TEST-NET-1
  [[192, 168], 16],
  [[198, 18], 15], // 基准测试
  [[198, 51, 100], 24], // TEST-NET-2
  [[203, 0, 113], 24], // TEST-NET-3
  [[224], 4], // 组播
  [[240], 4], // 保留（含广播地址）
]

const PRIVATE_V6: readonly Cidr[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96], // ::/96，含 ::、::1 和已废弃的 IPv4 兼容地址
  [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48], // 64:ff9b:1::/48 本地 NAT64
  [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64], // 100::/64 丢弃前缀
  [[0x20, 0x01, 0x0d, 0xb8], 32], // 文档
  [[0xfc], 7], // 唯一本地地址
  [[0xfe, 0x80], 10], // 链路本地
  [[0xfe, 0xc0], 10], // 站点本地（已废弃）
  [[0xff], 8], // 组播
]

/** 内嵌 IPv4 的 IPv6 前缀：[前缀, 前缀位数, IPv4 起始字节] */
const EMBEDDED_V4: readonly (readonly [readonly number[], number, number])[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96, 12], // ::ffff:0:0/96 IPv4 映射
  [[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96, 12], // 64:ff9b::/96 NAT64
  [[0x20, 0x02], 16, 2], // 2002::/16 6to4
]

function inCidr(bytes: readonly number[], [prefix, bits]: Cidr): boolean {
  for (let i = 0; i < Math.ceil(bits / 8); i++) {
    const mask = bits - i * 8 >= 8 ? 0xff : (0xff << (8 - (bits - i * 8))) & 0xff
    if (((bytes[i] ?? 0) & mask) !== ((prefix[i] ?? 0) & mask)) return false
  }
  return true
}

export function parseIPv4(text: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return null
  const bytes = text.split('.').map(Number)
  return bytes.every((b) => b <= 255) ? bytes : null
}

export function parseIPv6(text: string): number[] | null {
  const addr = text.replace(/%.*$/, '') // 去掉 zone id，如 fe80::1%eth0
  if (!/^[0-9a-fA-F:.]+$/.test(addr)) return null

  // 末尾内嵌的 IPv4（如 ::ffff:127.0.0.1）
  let tail: number[] = []
  let head = addr
  const lastColon = addr.lastIndexOf(':')
  if (addr.includes('.')) {
    const v4 = parseIPv4(addr.slice(lastColon + 1))
    if (!v4) return null
    tail = v4
    head = `${addr.slice(0, lastColon + 1)}0:0` // 用两个占位组替换，最后再覆盖
  }

  const halves = head.split('::')
  if (halves.length > 2) return null
  const groups = (part: string | undefined) => (part ? part.split(':') : [])
  const left = groups(halves[0])
  const right = groups(halves[1])
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const all = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right]
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null

  const bytes = all.flatMap((g) => {
    const n = Number.parseInt(g, 16)
    return [n >> 8, n & 0xff]
  })
  if (tail.length) bytes.splice(12, 4, ...tail)
  return bytes
}

/** 是否为私有或保留地址。无法解析的地址按私有处理（宁可拒绝）。 */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIPv4(ip)
  if (v4) return PRIVATE_V4.some((c) => inCidr(v4, c))
  const v6 = parseIPv6(ip)
  if (!v6) return true
  for (const [prefix, bits, offset] of EMBEDDED_V4) {
    if (inCidr(v6, [prefix, bits])) return isPrivateIp(v6.slice(offset, offset + 4).join('.'))
  }
  return PRIVATE_V6.some((c) => inCidr(v6, c))
}

/** 检查是否允许拉取该 URL，不允许时抛出 SsrfError。错误信息中不包含 URL。 */
export async function assertFetchAllowed(url: string | URL, policy: FetchPolicy): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SsrfError('invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError('only http and https URLs are allowed')
  }
  if (policy.allowPrivate) return

  let host = parsed.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    if (isPrivateIp(host.slice(1, -1)))
      throw new SsrfError('private or reserved address is not allowed')
    return
  }
  host = host.replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfError('private or reserved address is not allowed')
  }
  if (parseIPv4(host)) {
    if (isPrivateIp(host)) throw new SsrfError('private or reserved address is not allowed')
    return
  }
  if (!policy.resolveHost) return

  let addresses: string[]
  try {
    addresses = await policy.resolveHost(host)
  } catch {
    throw new SsrfError('DNS lookup failed')
  }
  if (addresses.length === 0) throw new SsrfError('DNS lookup returned no address')
  if (addresses.some(isPrivateIp)) {
    throw new SsrfError('host resolves to a private or reserved address')
  }
}
