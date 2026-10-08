import { PortsSchema, type ProxyOf } from '../../ir/index.js'
import { extraOf, invalid, safeDecodeURIComponent } from '../util.js'
import { nameOr, parseLink, requiredPort } from './link.js'

type Hysteria2 = ProxyOf<'hysteria2'>

function checkPorts(ports: string): string {
  if (!PortsSchema.safeParse(ports).success) throw invalid('invalid port range')
  return ports
}

/** hysteria2://auth@host:port[,port-port]/?sni=...&obfs=salamander&...#name（hy2:// 为别名） */
export function parseHysteria2(rest: string): Hysteria2 {
  const link = parseLink(rest)
  const password =
    link.userinfo === undefined ? undefined : safeDecodeURIComponent(link.userinfo) || undefined
  const p = link.params

  // 端口跳跃：host:20000-30000 或 host:443,20000-30000；也可能通过 mport 参数给出
  let port: number
  let ports: string | undefined
  const raw = link.portRaw
  if (raw !== undefined && /[-,]/.test(raw)) {
    ports = checkPorts(raw)
    port = Number(raw.split(/[-,]/, 1)[0])
  } else {
    port = requiredPort(raw)
  }
  const mport = p.str('mport')
  if (mport !== undefined) ports = checkPorts(mport)

  const obfsType = p.str('obfs')
  let obfs: Hysteria2['obfs']
  if (obfsType !== undefined) {
    if (obfsType !== 'salamander') throw invalid('"obfs" must be salamander')
    const obfsPassword = p.str('obfs-password')
    if (!obfsPassword) throw invalid('salamander requires "obfs-password"')
    obfs = { type: 'salamander', password: obfsPassword }
  }

  const upmbps = p.str('upmbps')
  const downmbps = p.str('downmbps')
  const up = p.str('up')
  const down = p.str('down')
  return {
    name: nameOr(link.name, link.host, port),
    type: 'hysteria2',
    server: link.host,
    port,
    password,
    ports,
    obfs,
    up: upmbps ?? up,
    down: downmbps ?? down,
    tls: {
      sni: p.str('sni'),
      alpn: p.list('alpn'),
      skipCertVerify: p.bool('insecure'),
      certFingerprint: p.str('pinSHA256'),
    },
    extra: extraOf('uri', p.rest()),
  }
}
