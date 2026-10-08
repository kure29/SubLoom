import { afterEach, describe, expect, it, vi } from 'vitest'
import upstreamHeaders from '../../core/test/fixtures/import/subscription-headers.json' with {
  type: 'json',
}
import b64Subscription from '../../core/test/fixtures/import/uri-mixed-b64/input.txt?raw'
import { DEFAULT_USER_AGENT, FetchError, fetchSubscription } from '../src/fetch.js'
import { SsrfError } from '../src/ssrf.js'

/** fixtures 中的上游响应头（去掉说明字段） */
const { _comment, ...UPSTREAM_HEADERS } = upstreamHeaders

const URL_WITH_TOKEN = 'https://sub.example.com/api/v1/client/subscribe?token=SECRET'
const publicDns = async (_host: string) => ['93.184.215.14']
const base = { userAgent: DEFAULT_USER_AGENT, allowPrivate: false, resolveHost: publicDns }

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (...[input, init]: FetchArgs) => impl(String(input), init ?? {}))
  vi.stubGlobal('fetch', fn)
  return fn
}

async function failure(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).not.toContain('SECRET')
  return err as Error
}

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchSubscription', () => {
  it('返回内容和解析后的 subscription-userinfo，并发送指定的 User-Agent', async () => {
    const fetch = mockFetch(() => new Response(b64Subscription, { headers: UPSTREAM_HEADERS }))
    const res = await fetchSubscription(URL_WITH_TOKEN, base)
    expect(res.text).toBe(b64Subscription)
    expect(res.bytes).toBe(new TextEncoder().encode(b64Subscription).length)
    expect(res.userinfo).toEqual({
      upload: 1073741824,
      download: 10737418240,
      total: 107374182400,
      expire: 1798732800,
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(String(url)).toBe(URL_WITH_TOKEN)
    expect(new Headers(init?.headers).get('user-agent')).toBe(DEFAULT_USER_AGENT)
    expect(init?.redirect).toBe('manual')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('默认 User-Agent 为 mihomo 风格', () => {
    expect(DEFAULT_USER_AGENT).toBe('clash.meta')
  })

  it('使用自定义 User-Agent', async () => {
    const fetch = mockFetch(() => new Response('ok'))
    await fetchSubscription(URL_WITH_TOKEN, { ...base, userAgent: 'Surge iOS/3000' })
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('user-agent')).toBe('Surge iOS/3000')
  })

  it('没有 subscription-userinfo 时 userinfo 为 null', async () => {
    mockFetch(() => new Response('ok'))
    expect((await fetchSubscription(URL_WITH_TOKEN, base)).userinfo).toBeNull()
  })

  it('按 UTF-8 解码', async () => {
    const text = 'proxies:\n  - name: 🇭🇰 香港\n'
    mockFetch(() => new Response(new TextEncoder().encode(text)))
    expect((await fetchSubscription(URL_WITH_TOKEN, base)).text).toBe(text)
  })

  it('非 2xx 时失败，错误中带状态码但不带 URL', async () => {
    mockFetch(() => new Response('denied', { status: 403 }))
    const err = await failure(fetchSubscription(URL_WITH_TOKEN, base))
    expect(err).toBeInstanceOf(FetchError)
    expect(err.message).toContain('403')
    expect(err.message).not.toContain('sub.example.com/api')
  })

  it('网络错误时失败', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    const err = await failure(fetchSubscription(URL_WITH_TOKEN, base))
    expect(err).toBeInstanceOf(FetchError)
  })

  it('超时后中断请求', async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const err = await failure(fetchSubscription(URL_WITH_TOKEN, { ...base, timeoutMs: 20 }))
    expect(err).toBeInstanceOf(FetchError)
    expect(err.message).toMatch(/timed? ?out/i)
  })

  it('读取响应体时超时同样中断', async () => {
    let cancelled = false
    mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    const err = await failure(fetchSubscription(URL_WITH_TOKEN, { ...base, timeoutMs: 20 }))
    expect(err.message).toMatch(/timed? ?out/i)
    expect(cancelled).toBe(true)
  })

  it('Content-Length 超过上限时不读取响应体', async () => {
    let pulled = false
    mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulled = true
                controller.close()
              },
            },
            // highWaterMark 为 0：只有真正读取时才会调用 pull
            { highWaterMark: 0 },
          ),
          { headers: { 'content-length': '2000' } },
        ),
    )
    const err = await failure(fetchSubscription(URL_WITH_TOKEN, { ...base, maxBytes: 1000 }))
    expect(err.message).toMatch(/too large/i)
    expect(pulled).toBe(false)
  })

  it('没有 Content-Length 时读取过程中超过上限即中断', async () => {
    let cancelled = false
    const chunk = new Uint8Array(400).fill(0x61)
    mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk)
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    const err = await failure(fetchSubscription(URL_WITH_TOKEN, { ...base, maxBytes: 1000 }))
    expect(err.message).toMatch(/too large/i)
    expect(cancelled).toBe(true)
  })

  it('默认超时 15 秒、上限 10 MB', async () => {
    const { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES } = await import('../src/fetch.js')
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000)
    expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it('SSRF 检查不通过时不发请求', async () => {
    const fetch = mockFetch(() => new Response('ok'))
    const err = await failure(fetchSubscription('http://127.0.0.1/sub?token=SECRET', base))
    expect(err).toBeInstanceOf(SsrfError)
    const err2 = await failure(
      fetchSubscription(URL_WITH_TOKEN, { ...base, resolveHost: async () => ['10.0.0.1'] }),
    )
    expect(err2).toBeInstanceOf(SsrfError)
    expect(fetch).not.toHaveBeenCalled()
  })

  describe('重定向', () => {
    it('跟随重定向（含相对地址），每一跳都检查', async () => {
      const resolveHost = vi.fn(publicDns)
      const fetch = mockFetch((url) => {
        if (url === URL_WITH_TOKEN)
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.net/a' },
          })
        if (url === 'https://cdn.example.net/a')
          return new Response(null, { status: 301, headers: { location: '/b?x=1' } })
        if (url === 'https://cdn.example.net/b?x=1')
          return new Response(b64Subscription, { headers: UPSTREAM_HEADERS })
        return new Response('unexpected', { status: 500 })
      })
      const res = await fetchSubscription(URL_WITH_TOKEN, { ...base, resolveHost })
      expect(res.text).toBe(b64Subscription)
      expect(res.userinfo?.total).toBe(107374182400)
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(resolveHost.mock.calls.map((c) => c[0])).toEqual([
        'sub.example.com',
        'cdn.example.net',
        'cdn.example.net',
      ])
    })

    it('重定向到内网地址时拒绝', async () => {
      const fetch = mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          }),
      )
      expect(await failure(fetchSubscription(URL_WITH_TOKEN, base))).toBeInstanceOf(SsrfError)
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('重定向到解析后落在内网的域名时拒绝', async () => {
      mockFetch(
        () =>
          new Response(null, { status: 307, headers: { location: 'https://evil.example.org/' } }),
      )
      const resolveHost = async (host: string) =>
        host === 'evil.example.org' ? ['192.168.0.10'] : ['93.184.215.14']
      expect(
        await failure(fetchSubscription(URL_WITH_TOKEN, { ...base, resolveHost })),
      ).toBeInstanceOf(SsrfError)
    })

    it('超过 5 次重定向时失败', async () => {
      let n = 0
      const fetch = mockFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: `https://sub.example.com/r${++n}` },
          }),
      )
      const err = await failure(fetchSubscription(URL_WITH_TOKEN, base))
      expect(err.message).toMatch(/redirect/i)
      expect(fetch).toHaveBeenCalledTimes(6)
    })

    it('3xx 没有 Location 时失败', async () => {
      mockFetch(() => new Response(null, { status: 302 }))
      expect(await failure(fetchSubscription(URL_WITH_TOKEN, base))).toBeInstanceOf(FetchError)
    })
  })
})
