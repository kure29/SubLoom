import { describe, expect, it, vi } from 'vitest'
import { assertFetchAllowed, isPrivateIp, SsrfError } from '../src/ssrf.js'

describe('isPrivateIp：IPv4', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254', // 云厂商元数据服务
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.5',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
  ])('%s 为私有或保留地址', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.1',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.0.1',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
  ])('%s 为公网地址', (ip) => {
    expect(isPrivateIp(ip)).toBe(false)
  })
})

describe('isPrivateIp：IPv6', () => {
  it.each([
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::7f00:1', // IPv4 兼容地址（已废弃）
    '::ffff:127.0.0.1', // IPv4 映射地址
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '::ffff:192.168.0.1',
    '64:ff9b::a00:1', // NAT64 → 10.0.0.1
    '64:ff9b::127.0.0.1',
    '2002:7f00:1::', // 6to4 → 127.0.0.1
    '2002:c0a8:101::1', // 6to4 → 192.168.1.1
    '100::1',
    '2001:db8::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    'fec0::1',
    'ff02::1',
  ])('%s 为私有或保留地址', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808', // NAT64 → 8.8.8.8
    '2002:808:808::1', // 6to4 → 8.8.8.8
    '2400:cb00::1',
  ])('%s 为公网地址', (ip) => {
    expect(isPrivateIp(ip)).toBe(false)
  })

  it('无法解析的地址按私有处理（宁可拒绝）', () => {
    for (const bad of [
      '',
      'example.com',
      '1.2.3',
      '256.0.0.1',
      '1::2::3',
      'gggg::1',
      '::ffff:1.2.3.4.5',
    ]) {
      expect(isPrivateIp(bad)).toBe(true)
    }
  })
})

describe('assertFetchAllowed', () => {
  const allow = { allowPrivate: false }

  async function blocked(url: string, opts: Parameters<typeof assertFetchAllowed>[1] = allow) {
    const err = await assertFetchAllowed(url, opts).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err, url).toBeInstanceOf(SsrfError)
    return err as SsrfError
  }

  it('只允许 http 和 https', async () => {
    for (const url of [
      'ftp://example.com/sub',
      'file:///etc/passwd',
      'data:text/plain,abc',
      'javascript:alert(1)',
    ]) {
      await blocked(url)
    }
    await expect(assertFetchAllowed('not a url', allow)).rejects.toBeInstanceOf(SsrfError)
  })

  it('拒绝私有和保留的 IPv4 字面量，包括各种非常规写法', async () => {
    for (const url of [
      'http://127.0.0.1/sub',
      'http://127.1/sub',
      'http://2130706433/sub', // 十进制
      'http://0x7f000001/sub', // 十六进制
      'http://0177.0.0.1/sub', // 八进制
      'https://10.0.0.8:8443/sub',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
      'http://0.0.0.0:3000/',
    ]) {
      await blocked(url)
    }
  })

  it('拒绝私有和保留的 IPv6 字面量', async () => {
    for (const url of [
      'http://[::1]/sub',
      'http://[::]/sub',
      'http://[::ffff:127.0.0.1]/sub',
      'http://[::ffff:a00:1]/sub',
      'http://[fd00::1]:8080/sub',
      'http://[fe80::1]/sub',
      'http://[64:ff9b::7f00:1]/sub',
    ]) {
      await blocked(url)
    }
  })

  it('拒绝 localhost 及其子域名（含末尾的点）', async () => {
    for (const url of [
      'http://localhost/sub',
      'http://LOCALHOST:3000/sub',
      'http://localhost./sub',
      'http://api.localhost/sub',
    ]) {
      await blocked(url)
    }
  })

  it('允许公网 IP 字面量，不做 DNS 解析', async () => {
    const resolveHost = vi.fn(async () => ['10.0.0.1'])
    await assertFetchAllowed('https://1.1.1.1/sub', { allowPrivate: false, resolveHost })
    await assertFetchAllowed('https://[2606:4700:4700::1111]/sub', {
      allowPrivate: false,
      resolveHost,
    })
    expect(resolveHost).not.toHaveBeenCalled()
  })

  it('域名解析后落到内网时拒绝（任一地址为私有即拒绝）', async () => {
    const records: Record<string, string[]> = {
      'internal.example.com': ['10.0.0.5'],
      'mixed.example.com': ['93.184.215.14', '192.168.1.10'],
      'v6.example.com': ['fd00::5'],
      'mapped.example.com': ['::ffff:127.0.0.1'],
      'metadata.example.com': ['169.254.169.254'],
    }
    const resolveHost = vi.fn(async (host: string) => records[host] ?? [])
    for (const host of Object.keys(records)) {
      const err = await blocked(`https://${host}/sub?token=SECRET`, {
        allowPrivate: false,
        resolveHost,
      })
      expect(err.message).not.toContain('SECRET')
    }
    expect(resolveHost).toHaveBeenCalledWith('internal.example.com')
  })

  it('域名解析到公网地址时允许', async () => {
    const resolveHost = vi.fn(async () => [
      '93.184.215.14',
      '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
    ])
    await assertFetchAllowed('https://sub.example.com/api?token=x', {
      allowPrivate: false,
      resolveHost,
    })
    expect(resolveHost).toHaveBeenCalledWith('sub.example.com')
  })

  it('DNS 解析失败或没有结果时拒绝', async () => {
    await blocked('https://nx.example.com/', {
      allowPrivate: false,
      resolveHost: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    await blocked('https://empty.example.com/', {
      allowPrivate: false,
      resolveHost: async () => [],
    })
  })

  it('没有 resolveHost（Workers）时只检查字面量', async () => {
    await assertFetchAllowed('https://sub.example.com/', { allowPrivate: false })
    await blocked('http://127.0.0.1/', { allowPrivate: false })
  })

  it('ALLOW_PRIVATE_FETCH 开启后私有地址和内网域名都放行，且不再解析 DNS', async () => {
    const resolveHost = vi.fn(async () => ['10.0.0.5'])
    const opts = { allowPrivate: true, resolveHost }
    for (const url of [
      'http://127.0.0.1/sub',
      'http://[::1]/sub',
      'http://localhost:8080/sub',
      'http://192.168.1.2/sub',
      'https://internal.example.com/sub',
    ]) {
      await expect(assertFetchAllowed(url, opts)).resolves.toBeUndefined()
    }
    expect(resolveHost).not.toHaveBeenCalled()
  })

  it('ALLOW_PRIVATE_FETCH 开启后仍只允许 http 和 https', async () => {
    await blocked('file:///etc/passwd', { allowPrivate: true })
  })

  it('错误信息中不包含完整 URL', async () => {
    const err = await blocked('http://127.0.0.1/sub?token=SECRET')
    expect(err.message).not.toContain('SECRET')
    expect(err.message).not.toContain('/sub')
  })
})
