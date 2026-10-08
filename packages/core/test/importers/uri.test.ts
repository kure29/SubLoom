import { describe, expect, it } from 'vitest'
import { type ProxyNode, ProxySchema, parseProxyUri } from '../../src/index.js'

/** 测试中直接访问各协议的字段 */
type AnyProxy = ProxyNode & Record<string, unknown>

function ok(uri: string): AnyProxy {
  const r = parseProxyUri(uri)
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  // 导入结果必须是规范的 IR
  expect(ProxySchema.parse(r.proxy)).toEqual(r.proxy)
  return r.proxy
}

function fail(uri: string) {
  const r = parseProxyUri(uri)
  if (r.ok) throw new Error(`expected failure, got ${JSON.stringify(r.proxy)}`)
  return r
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64url = (s: string) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const vmess = (o: Record<string, unknown>) => `vmess://${b64(JSON.stringify(o))}`

const VMESS_BASE = {
  v: '2',
  ps: 'vm',
  add: 'vm.example.com',
  port: '443',
  id: '00000000-0000-4000-8000-000000000001',
  aid: '0',
  scy: 'auto',
}

describe('common URI handling', () => {
  it('accepts upper-case schemes', () => {
    expect(ok('TROJAN://pw@t.example.com:443#t')).toMatchObject({ type: 'trojan', name: 't' })
  })

  it('falls back to host:port when the name is missing or empty', () => {
    expect(ok('trojan://pw@t.example.com:443').name).toBe('t.example.com:443')
    expect(ok('trojan://pw@t.example.com:443#').name).toBe('t.example.com:443')
    expect(ok('trojan://pw@[2001:db8::1]:443').name).toBe('[2001:db8::1]:443')
  })

  it('keeps a malformed percent-encoded name as-is', () => {
    expect(ok('trojan://pw@t.example.com:443#bad%E0%A4%A').name).toBe('bad%E0%A4%A')
  })

  it('strips brackets from IPv6 servers', () => {
    expect(ok('trojan://pw@[2001:db8::1]:443').server).toBe('2001:db8::1')
  })

  it('does not turn + into a space in query values', () => {
    const p = ok('hysteria2://pw@h.example.com:443?obfs=salamander&obfs-password=a+b')
    expect(p).toMatchObject({ obfs: { type: 'salamander', password: 'a+b' } })
  })

  it.each([
    ['missing port', 'trojan://pw@t.example.com#x'],
    ['non-numeric port', 'trojan://pw@t.example.com:abc#x'],
    ['port 0', 'trojan://pw@t.example.com:0#x'],
    ['port out of range', 'trojan://pw@t.example.com:70000#x'],
    ['missing host', 'trojan://pw@:443#x'],
    ['unterminated IPv6', 'trojan://pw@[2001:db8::1:443#x'],
  ])('rejects %s', (_, uri) => {
    expect(fail(uri)).toMatchObject({ code: 'INVALID_PROXY', protocol: 'trojan' })
  })

  it.each([
    ['tuic://u:p@t.example.com:443', 'tuic'],
    ['ssr://abc', 'ssr'],
    ['socks5://h.example.com:1080', 'socks5'],
    ['https://example.com/x', 'https'],
  ])('reports %s as unsupported', (uri, protocol) => {
    expect(fail(uri)).toMatchObject({ code: 'UNSUPPORTED_PROTOCOL', protocol })
  })

  it.each(['random garbage', 'ss:/broken', '://x'])('reports %j as an invalid URI', (uri) => {
    expect(fail(uri).code).toBe('INVALID_URI')
  })
})

describe('ss', () => {
  it('parses SIP002 with base64url userinfo without padding', () => {
    expect(ok(`ss://${b64url('aes-256-gcm:pass')}@s.example.com:8388#s`)).toEqual({
      name: 's',
      type: 'ss',
      server: 's.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'pass',
    })
  })

  it('parses SIP002 with standard base64 and percent-encoded padding', () => {
    const userinfo = encodeURIComponent(b64('chacha20-ietf-poly1305:p?w'))
    expect(ok(`ss://${userinfo}@s.example.com:8388`)).toMatchObject({
      cipher: 'chacha20-ietf-poly1305',
      password: 'p?w',
    })
  })

  it('parses SIP002 with plain percent-encoded userinfo (2022 ciphers)', () => {
    expect(ok('ss://2022-blake3-aes-256-gcm:a%2Bb%3D@s.example.com:8388')).toMatchObject({
      cipher: '2022-blake3-aes-256-gcm',
      password: 'a+b=',
    })
  })

  it('keeps colons inside the password', () => {
    expect(ok(`ss://${b64url('aes-128-gcm:a:b:c')}@s.example.com:1`).password).toBe('a:b:c')
  })

  it('parses the legacy whole-base64 format', () => {
    expect(ok(`ss://${b64('aes-128-gcm:p@ss@s.example.com:8388')}#legacy`)).toMatchObject({
      name: 'legacy',
      server: 's.example.com',
      port: 8388,
      cipher: 'aes-128-gcm',
      password: 'p@ss',
    })
  })

  it('maps obfs-local / simple-obfs plugins', () => {
    const base = `ss://${b64url('aes-128-gcm:p')}@s.example.com:8388/?plugin=`
    expect(
      ok(`${base}${encodeURIComponent('obfs-local;obfs=tls;obfs-host=a.example.com')}`),
    ).toMatchObject({
      plugin: { type: 'obfs', mode: 'tls', host: 'a.example.com' },
    })
    expect(ok(`${base}${encodeURIComponent('simple-obfs;obfs=http')}`).plugin).toEqual({
      type: 'obfs',
      mode: 'http',
    })
  })

  it('maps v2ray-plugin', () => {
    const plugin = encodeURIComponent('v2ray-plugin;mode=websocket;host=a.example.com;path=/ws;tls')
    expect(
      ok(`ss://${b64url('aes-128-gcm:p')}@s.example.com:443/?plugin=${plugin}`).plugin,
    ).toEqual({
      type: 'v2ray-plugin',
      mode: 'websocket',
      host: 'a.example.com',
      path: '/ws',
      tls: true,
    })
  })

  it('keeps unknown plugins and plugin options in extra', () => {
    const base = `ss://${b64url('aes-128-gcm:p')}@s.example.com:8388/?plugin=`
    const unknown = ok(`${base}${encodeURIComponent('kcptun;mode=fast')}`)
    expect(unknown.type === 'ss' && unknown.plugin).toBeFalsy()
    expect(unknown.extra).toEqual({ uri: { plugin: 'kcptun;mode=fast' } })

    const partial = ok(`${base}${encodeURIComponent('obfs-local;obfs=http;fast-open')}`)
    expect(partial).toMatchObject({ plugin: { type: 'obfs', mode: 'http' } })
    expect(partial.extra).toEqual({ uri: { 'plugin-opts': { 'fast-open': true } } })
  })

  it('keeps unknown query parameters in extra', () => {
    expect(ok(`ss://${b64url('aes-128-gcm:p')}@s.example.com:1/?group=g1`).extra).toEqual({
      uri: { group: 'g1' },
    })
  })

  it.each([
    ['userinfo that is neither base64 nor plain', 'ss://!!!@s.example.com:8388'],
    ['userinfo without password', `ss://${b64url('aes-128-gcm')}@s.example.com:8388`],
    ['empty cipher', `ss://${b64url(':pass')}@s.example.com:8388`],
    ['empty password', `ss://${b64url('aes-128-gcm:')}@s.example.com:8388`],
    ['legacy body that is not base64', 'ss://not-base64!!#x'],
    ['legacy body without port', `ss://${b64('aes-128-gcm:p@s.example.com')}`],
    [
      'obfs plugin with unknown mode',
      `ss://${b64url('a:b')}@s.example.com:1/?plugin=obfs-local%3Bobfs%3Dquic`,
    ],
  ])('rejects %s', (_, uri) => {
    expect(fail(uri)).toMatchObject({ code: 'INVALID_PROXY', protocol: 'ss' })
  })
})

describe('vmess', () => {
  it('parses ws + tls with alpn, fingerprint and allowInsecure', () => {
    const p = ok(
      vmess({
        ...VMESS_BASE,
        net: 'ws',
        type: 'none',
        host: 'cdn.example.com',
        path: '/ws',
        tls: 'tls',
        sni: 'sni.example.com',
        alpn: 'h2,http/1.1',
        fp: 'firefox',
        allowInsecure: '1',
      }),
    )
    expect(p).toEqual({
      name: 'vm',
      type: 'vmess',
      server: 'vm.example.com',
      port: 443,
      uuid: VMESS_BASE.id,
      alterId: 0,
      cipher: 'auto',
      tls: {
        sni: 'sni.example.com',
        alpn: ['h2', 'http/1.1'],
        skipCertVerify: true,
        clientFingerprint: 'firefox',
      },
      transport: { type: 'ws', path: '/ws', host: 'cdn.example.com' },
    })
  })

  it('defaults cipher to auto and alterId to 0', () => {
    const { scy: _scy, aid: _aid, ...rest } = VMESS_BASE
    expect(ok(vmess(rest))).toMatchObject({ alterId: 0, cipher: 'auto' })
  })

  it('accepts numeric port, aid and v', () => {
    expect(ok(vmess({ ...VMESS_BASE, v: 2, port: 8443, aid: 64 }))).toMatchObject({
      port: 8443,
      alterId: 64,
    })
  })

  it('maps grpc (path is the service name)', () => {
    expect(
      ok(vmess({ ...VMESS_BASE, net: 'grpc', type: 'gun', path: 'svc', tls: 'tls' })).transport,
    ).toEqual({ type: 'grpc', serviceName: 'svc' })
  })

  it('keeps grpc multi mode in extra', () => {
    const p = ok(vmess({ ...VMESS_BASE, net: 'grpc', type: 'multi', path: 'svc' }))
    expect(p.extra).toEqual({ uri: { type: 'multi' } })
  })

  it('maps h2 with multiple hosts', () => {
    expect(
      ok(
        vmess({
          ...VMESS_BASE,
          net: 'h2',
          host: 'a.example.com,b.example.com',
          path: '/h2',
          tls: 'tls',
        }),
      ).transport,
    ).toEqual({ type: 'h2', path: '/h2', host: ['a.example.com', 'b.example.com'] })
  })

  it('maps tcp with http header obfuscation', () => {
    expect(
      ok(vmess({ ...VMESS_BASE, net: 'tcp', type: 'http', host: 'a.example.com', path: '/x' }))
        .transport,
    ).toEqual({ type: 'http', path: ['/x'], host: ['a.example.com'] })
  })

  it('maps httpupgrade', () => {
    expect(
      ok(vmess({ ...VMESS_BASE, net: 'httpupgrade', host: 'a.example.com', path: '/up' }))
        .transport,
    ).toEqual({ type: 'httpupgrade', path: '/up', host: 'a.example.com' })
  })

  it('treats empty strings as absent and keeps unknown keys in extra', () => {
    const p = ok(
      vmess({
        ...VMESS_BASE,
        net: 'tcp',
        type: 'none',
        host: '',
        path: '',
        tls: '',
        alpn: '',
        foo: 'bar',
      }),
    )
    expect(p).not.toHaveProperty('tls')
    expect(p).not.toHaveProperty('transport')
    expect(p.extra).toEqual({ uri: { foo: 'bar' } })
  })

  it('keeps TLS-only keys in extra when TLS is off', () => {
    expect(ok(vmess({ ...VMESS_BASE, tls: '', sni: 's.example.com' })).extra).toEqual({
      uri: { sni: 's.example.com' },
    })
  })

  it('reports unsupported transports', () => {
    expect(fail(vmess({ ...VMESS_BASE, net: 'kcp' }))).toMatchObject({
      code: 'UNSUPPORTED_TRANSPORT',
      protocol: 'vmess',
    })
  })

  it.each([
    ['invalid base64', 'vmess://this-is-not-base64!!!'],
    ['base64 of non-JSON', `vmess://${b64('hello')}`],
    ['JSON that is not an object', `vmess://${b64('[1,2]')}`],
    ['invalid UTF-8', `vmess://${btoa('\xff\xfe')}`],
    ['missing server', vmess({ ...VMESS_BASE, add: '' })],
    ['missing uuid', vmess({ ...VMESS_BASE, id: undefined })],
    ['non-numeric port', vmess({ ...VMESS_BASE, port: 'abc' })],
    ['negative alterId', vmess({ ...VMESS_BASE, aid: '-1' })],
  ])('rejects %s', (_, uri) => {
    expect(fail(uri)).toMatchObject({ code: 'INVALID_PROXY', protocol: 'vmess' })
  })
})

describe('vless', () => {
  const U = '00000000-0000-4000-8000-000000000003'

  it('parses reality + tcp + vision', () => {
    expect(
      ok(
        `vless://${U}@203.0.113.10:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.com&fp=chrome&pbk=PUBKEY&sid=ab12&type=tcp&headerType=none#r`,
      ),
    ).toEqual({
      name: 'r',
      type: 'vless',
      server: '203.0.113.10',
      port: 443,
      uuid: U,
      flow: 'xtls-rprx-vision',
      tls: {
        sni: 'www.example.com',
        clientFingerprint: 'chrome',
        reality: { publicKey: 'PUBKEY', shortId: 'ab12' },
      },
    })
  })

  it('parses reality + grpc', () => {
    expect(
      ok(
        `vless://${U}@r.example.com:443?security=reality&pbk=PUBKEY&sni=www.example.com&type=grpc&serviceName=svc&mode=gun`,
      ),
    ).toMatchObject({
      tls: { sni: 'www.example.com', reality: { publicKey: 'PUBKEY' } },
      transport: { type: 'grpc', serviceName: 'svc' },
    })
  })

  it('parses ws + tls with an encoded early-data path', () => {
    expect(
      ok(
        `vless://${U}@w.example.com:443?security=tls&type=ws&host=cdn.example.com&path=%2Fws%3Fed%3D2048`,
      ).transport,
    ).toEqual({ type: 'ws', path: '/ws?ed=2048', host: 'cdn.example.com' })
  })

  it('maps type=http to h2 and type=httpupgrade', () => {
    expect(
      ok(`vless://${U}@h.example.com:443?security=tls&type=http&host=a.example.com&path=%2Fh2`)
        .transport,
    ).toEqual({
      type: 'h2',
      path: '/h2',
      host: ['a.example.com'],
    })
    expect(ok(`vless://${U}@h.example.com:443?type=httpupgrade&path=%2Fup`).transport).toEqual({
      type: 'httpupgrade',
      path: '/up',
    })
  })

  it('maps tcp with http header obfuscation', () => {
    expect(
      ok(`vless://${U}@h.example.com:80?type=tcp&headerType=http&host=a.example.com&path=%2F`)
        .transport,
    ).toEqual({
      type: 'http',
      path: ['/'],
      host: ['a.example.com'],
    })
  })

  it('maps alpn and allowInsecure', () => {
    expect(
      ok(`vless://${U}@h.example.com:443?security=tls&alpn=h2%2Chttp%2F1.1&allowInsecure=1`).tls,
    ).toEqual({
      alpn: ['h2', 'http/1.1'],
      skipCertVerify: true,
    })
  })

  it('keeps unmapped parameters in extra', () => {
    const p = ok(
      `vless://${U}@h.example.com:443?encryption=mlkem768x25519plus&security=reality&pbk=K&spx=%2F&packetEncoding=xudp`,
    )
    expect(p.extra).toEqual({
      uri: { encryption: 'mlkem768x25519plus', spx: '/', packetEncoding: 'xudp' },
    })
  })

  it('keeps TLS-only parameters in extra when security=none', () => {
    const p = ok(`vless://${U}@h.example.com:80?security=none&sni=s.example.com`)
    expect(p).not.toHaveProperty('tls')
    expect(p.extra).toEqual({ uri: { sni: 's.example.com' } })
  })

  it('reports unsupported transports', () => {
    expect(fail(`vless://${U}@h.example.com:443?type=xhttp`)).toMatchObject({
      code: 'UNSUPPORTED_TRANSPORT',
      protocol: 'vless',
    })
  })

  it.each([
    ['missing uuid', 'vless://h.example.com:443?security=tls'],
    [
      'reality without public key',
      `vless://${U}@h.example.com:443?security=reality&sni=a.example.com`,
    ],
    ['unknown security', `vless://${U}@h.example.com:443?security=xtls`],
  ])('rejects %s', (_, uri) => {
    expect(fail(uri)).toMatchObject({ code: 'INVALID_PROXY', protocol: 'vless' })
  })
})

describe('trojan', () => {
  it('always has TLS, even without parameters', () => {
    expect(ok('trojan://pw@t.example.com:443#t')).toEqual({
      name: 't',
      type: 'trojan',
      server: 't.example.com',
      port: 443,
      password: 'pw',
      tls: {},
    })
  })

  it('decodes the password and accepts peer as an alias of sni', () => {
    expect(
      ok('trojan://p%40ss%3Aword@t.example.com:443?peer=s.example.com&allowInsecure=1'),
    ).toMatchObject({
      password: 'p@ss:word',
      tls: { sni: 's.example.com', skipCertVerify: true },
    })
  })

  it('maps grpc and ws transports', () => {
    expect(ok('trojan://pw@t.example.com:443?type=grpc&serviceName=svc').transport).toEqual({
      type: 'grpc',
      serviceName: 'svc',
    })
    expect(
      ok('trojan://pw@t.example.com:443?type=ws&path=%2Fws&host=h.example.com').transport,
    ).toEqual({
      type: 'ws',
      path: '/ws',
      host: 'h.example.com',
    })
  })

  it('parses reality', () => {
    expect(ok('trojan://pw@t.example.com:443?security=reality&pbk=K&sid=01').tls).toEqual({
      reality: { publicKey: 'K', shortId: '01' },
    })
  })

  it.each([
    ['empty password', 'trojan://@t.example.com:443'],
    ['missing password', 'trojan://t.example.com:443'],
    ['security=none', 'trojan://pw@t.example.com:443?security=none'],
  ])('rejects %s', (_, uri) => {
    expect(fail(uri)).toMatchObject({ code: 'INVALID_PROXY', protocol: 'trojan' })
  })
})

describe('hysteria2', () => {
  it('parses obfs, alpn, pinSHA256 and bandwidth', () => {
    expect(
      ok(
        'hysteria2://pw@h.example.com:443/?sni=s.example.com&obfs=salamander&obfs-password=op&alpn=h3&pinSHA256=AB%3ACD&upmbps=50&downmbps=200&insecure=0#h',
      ),
    ).toEqual({
      name: 'h',
      type: 'hysteria2',
      server: 'h.example.com',
      port: 443,
      password: 'pw',
      obfs: { type: 'salamander', password: 'op' },
      up: '50',
      down: '200',
      tls: { sni: 's.example.com', alpn: ['h3'], certFingerprint: 'AB:CD' },
    })
  })

  it('accepts hy2:// and insecure=true', () => {
    expect(ok('hy2://pw@h.example.com:443?insecure=true')).toMatchObject({
      type: 'hysteria2',
      tls: { skipCertVerify: true },
    })
  })

  it('parses port lists and the mport parameter', () => {
    expect(ok('hysteria2://pw@h.example.com:443,20000-30000')).toMatchObject({
      port: 443,
      ports: '443,20000-30000',
    })
    expect(ok('hysteria2://pw@h.example.com:443?mport=20000-30000')).toMatchObject({
      port: 443,
      ports: '20000-30000',
    })
  })

  it('allows a missing password', () => {
    expect(ok('hysteria2://h.example.com:443')).not.toHaveProperty('password')
  })

  it.each([
    ['reversed port range', 'hysteria2://pw@h.example.com:30000-20000'],
    ['port range out of bounds', 'hysteria2://pw@h.example.com:60000-70000'],
    ['malformed port list', 'hysteria2://pw@h.example.com:443,,8443'],
    ['salamander without password', 'hysteria2://pw@h.example.com:443?obfs=salamander'],
    ['unknown obfs', 'hysteria2://pw@h.example.com:443?obfs=xor&obfs-password=x'],
  ])('rejects %s', (_, uri) => {
    expect(fail(uri)).toMatchObject({ code: 'INVALID_PROXY', protocol: 'hysteria2' })
  })
})
