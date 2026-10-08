// 与运行时无关的 API 集成测试。packages/* 的测试不能使用 Node API（拿不到 better-sqlite3），
// 因此这里只定义测试，由 apps/node/test（M5 起还有 apps/worker/test）传入各自的存储运行。见 PLAN.md 第 8 节。
import { fetchLogs, settings, sources } from '@subloom/db'
// 只引用类型：用包名而不是相对路径，apps/* 运行本套件时按构建产物（.d.ts）检查类型，
// 不会把 server 的源码按 Node 的类型环境再检查一遍（server 自己的 tsconfig.test.json 用 paths 指回 src）
import type * as Server from '@subloom/server'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import yamlSubscription from '../../../core/test/fixtures/import/mihomo-airport-full/input.yaml?raw'
import upstreamHeaders from '../../../core/test/fixtures/import/subscription-headers.json' with {
  type: 'json',
}
import uriSubscription from '../../../core/test/fixtures/import/uri-mixed/input.txt?raw'
import b64Subscription from '../../../core/test/fixtures/import/uri-mixed-b64/input.txt?raw'

export type ServerApi = Pick<typeof Server, 'createApp' | 'bootstrap' | 'runScheduledRefresh'>
/** 各运行时提供的存储；env 与 resolveHost 由测试自己设置 */
export type TestStorage = Pick<Server.Platform, 'db' | 'blobs' | 'waitUntil'>

const { _comment, ...UPSTREAM_HEADERS } = upstreamHeaders
const USERINFO = {
  upload: 1073741824,
  download: 10737418240,
  total: 107374182400,
  expire: 1798732800,
}

const ADMIN_TOKEN = 'test-admin-token'
const ENV: Server.PlatformEnv = {
  adminToken: ADMIN_TOKEN,
  secretKey: 'test-secret-key',
  corsOrigins: ['https://app.example.com'],
  allowPrivateFetch: false,
}
const SUB_URL = 'https://sub.example.com/api/v1/client/subscribe?token=CANARY'
/** uri-mixed 系列 fixtures 的节点数 */
const URI_NODES = 13

const publicDns = async (_host: string) => ['93.184.215.14']

/** 各接口响应体中可能出现的字段（测试中按需读取） */
interface Body {
  error: { code: string; message: string }
  source: Server.SourceDto
  sources: Server.SourceDto[]
  nodeCount: number
  warnings: unknown[]
  format: string
  fetchedAt: number
  proxies: Array<{ name: string; type: string }>
  logs: Server.FetchLogDto[]
}

export function describeApi(server: ServerApi, createStorage: () => Promise<TestStorage>) {
  let storage: TestStorage
  let platform: Server.Platform
  let app: ReturnType<ServerApi['createApp']>
  let consoleSpies: MockInstance[]

  function makePlatform(overrides: Partial<Server.Platform> = {}): Server.Platform {
    return { ...storage, env: ENV, resolveHost: vi.fn(publicDns), ...overrides }
  }

  beforeEach(async () => {
    storage = await createStorage()
    platform = makePlatform()
    app = server.createApp(platform)
    consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
  })

  afterEach(() => {
    // 日志脱敏：任何日志中都不能出现订阅 URL 中的 token（测试中为 CANARY）
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) expect(args.map(String).join(' ')).not.toContain('CANARY')
    }
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function printed(): string {
    return consoleSpies
      .flatMap((s) => s.mock.calls.map((args) => args.map(String).join(' ')))
      .join('\n')
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    opts: { token?: string | null; app?: typeof app; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; json: Body; headers: Headers }> {
    const token = opts.token === undefined ? ADMIN_TOKEN : opts.token
    const headers: Record<string, string> = { ...opts.headers }
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await (opts.app ?? app).request(path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await res.text()
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Body) : ({} as Body),
      headers: res.headers,
    }
  }

  /** mock 上游：每次请求调用 handler */
  function upstream(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init ?? {}),
    )
    vi.stubGlobal('fetch', fn)
    return fn
  }

  const okUpstream = (body = b64Subscription) =>
    upstream(() => new Response(body, { headers: UPSTREAM_HEADERS }))

  async function createRemote(extra: Record<string, unknown> = {}): Promise<Server.SourceDto> {
    const res = await call('POST', '/api/sources', {
      name: '机场 A',
      kind: 'remote',
      url: SUB_URL,
      ...extra,
    })
    expect(res.status).toBe(201)
    return res.json.source
  }

  async function dbSource(id: string) {
    const rows = await platform.db.select().from(sources).where(eq(sources.id, id))
    return rows[0]
  }

  async function setting(key: string) {
    const rows = await platform.db.select().from(settings).where(eq(settings.key, key))
    return rows[0]?.value
  }

  describe('认证', () => {
    it('管理接口需要 Bearer 令牌', async () => {
      expect((await call('GET', '/api/sources', undefined, { token: null })).status).toBe(401)
      const wrong = await call('GET', '/api/sources', undefined, { token: 'wrong' })
      expect(wrong.status).toBe(401)
      expect(wrong.json.error.code).toBe('UNAUTHORIZED')
      const res = await call('GET', '/api/sources', undefined, {
        token: null,
        headers: { authorization: `Basic ${ADMIN_TOKEN}` },
      })
      expect(res.status).toBe(401)
      expect((await call('GET', '/api/sources')).status).toBe(200)
    })

    it('未设置 ADMIN_TOKEN 时自动生成，明文只打印一次，数据库中只存哈希', async () => {
      const p1 = makePlatform({ env: { ...ENV, adminToken: undefined } })
      await server.bootstrap(p1)
      const token = /admin token[^\n]*?([A-Za-z0-9_-]{43})/i.exec(printed())?.[1]
      expect(token).toBeDefined()
      const hash = await setting('admin_token_hash')
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
      expect(hash).not.toContain(token)

      const app1 = server.createApp(p1)
      expect((await call('GET', '/api/sources', undefined, { app: app1, token })).status).toBe(200)
      expect((await call('GET', '/api/sources', undefined, { app: app1 })).status).toBe(401)

      // 重启（新的 platform 对象、同一份存储）后不再生成、不再打印，原令牌仍然有效
      const before = printed()
      const app2 = server.createApp(makePlatform({ env: { ...ENV, adminToken: undefined } }))
      expect((await call('GET', '/api/sources', undefined, { app: app2, token })).status).toBe(200)
      expect(printed().slice(before.length)).not.toContain(token)
      expect(printed().match(new RegExp(token ?? '-', 'g'))).toHaveLength(1)
    })

    it('并发初始化时只生成一个令牌', async () => {
      const env = { ...ENV, adminToken: undefined }
      await Promise.all([
        server.bootstrap(makePlatform({ env })),
        server.bootstrap(makePlatform({ env })),
        server.bootstrap(makePlatform({ env })),
      ])
      const tokens = [...printed().matchAll(/admin token[^\n]*?([A-Za-z0-9_-]{43})/gi)].map(
        (m) => m[1],
      )
      expect(tokens).toHaveLength(1)
      const app1 = server.createApp(makePlatform({ env }))
      expect(
        (await call('GET', '/api/sources', undefined, { app: app1, token: tokens[0] })).status,
      ).toBe(200)
    })

    it('设置了 ADMIN_TOKEN 时以它为准，不自动生成', async () => {
      await server.bootstrap(platform)
      expect(await setting('admin_token_hash')).toBeUndefined()
      expect(printed()).not.toMatch(/admin token/i)
    })
  })

  describe('CORS', () => {
    it('只允许 CORS_ORIGINS 中的来源', async () => {
      const preflight = (origin: string) =>
        app.request('/api/sources', {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization,content-type',
          },
        })
      const ok = await preflight('https://app.example.com')
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
      const bad = await preflight('https://evil.example.org')
      expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('订阅源增删改查', () => {
    it('新建远程订阅：返回明文 URL 和默认值，数据库中 URL 为密文', async () => {
      const source = await createRemote()
      expect(source).toMatchObject({
        name: '机场 A',
        kind: 'remote',
        url: SUB_URL,
        userAgent: null,
        ttlSec: 21600,
        lastFetchedAt: null,
        lastStatus: null,
        lastError: null,
        userinfo: null,
      })
      expect(source.id).toEqual(expect.any(String))
      expect(source.createdAt).toEqual(expect.any(Number))

      const row = await dbSource(source.id)
      expect(row?.urlEnc).toMatch(/^v1\./)
      expect(row?.urlEnc).not.toContain('example.com')
      expect(row?.urlEnc).not.toContain('CANARY')
      expect(row?.content).toBeNull()
    })

    it('新建远程订阅不会自动拉取', async () => {
      const fetch = okUpstream()
      await createRemote()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('列表与详情', async () => {
      const a = await createRemote({ userAgent: 'mihomo/1.19', ttlSec: 3600 })
      const b = await call('POST', '/api/sources', {
        name: '本地',
        kind: 'local',
        content: uriSubscription,
      })
      expect(b.status).toBe(201)

      const list = await call('GET', '/api/sources')
      expect(list.status).toBe(200)
      expect(list.json.sources.map((s) => s.id).sort()).toEqual([a.id, b.json.source.id].sort())
      const local = list.json.sources.find((s) => s.kind === 'local')
      expect(local).not.toHaveProperty('content')

      const one = await call('GET', `/api/sources/${a.id}`)
      expect(one.json.source).toMatchObject({
        id: a.id,
        url: SUB_URL,
        userAgent: 'mihomo/1.19',
        ttlSec: 3600,
      })
      const localOne = await call('GET', `/api/sources/${b.json.source.id}`)
      expect(localOne.json.source).toMatchObject({
        kind: 'local',
        url: null,
        content: uriSubscription,
      })
    })

    it('不存在的订阅返回 404', async () => {
      for (const [method, path] of [
        ['GET', '/api/sources/nope'],
        ['PATCH', '/api/sources/nope'],
        ['DELETE', '/api/sources/nope'],
        ['POST', '/api/sources/nope/refresh'],
        ['GET', '/api/sources/nope/nodes'],
        ['GET', '/api/sources/nope/logs'],
      ] as const) {
        const res = await call(method, path, method === 'PATCH' ? { name: 'x' } : undefined)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.json.error.code).toBe('NOT_FOUND')
      }
    })

    it('请求体不合法时返回 400', async () => {
      const bad = [
        '{not json',
        {},
        { name: '', kind: 'remote', url: SUB_URL },
        { name: 'x', kind: 'remote' },
        { name: 'x', kind: 'remote', url: 'not a url' },
        { name: 'x', kind: 'remote', url: 'ftp://sub.example.com/a' },
        { name: 'x', kind: 'remote', url: SUB_URL, ttlSec: 10 },
        { name: 'x', kind: 'remote', url: SUB_URL, ttlSec: 1.5 },
        { name: 'x', kind: 'local' },
        { name: 'x', kind: 'local', content: 'a', url: SUB_URL },
        { name: 'x', kind: 'other', url: SUB_URL },
      ]
      for (const body of bad) {
        const res = await call('POST', '/api/sources', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.json.error.code).toBe('INVALID_REQUEST')
      }
      expect((await call('GET', '/api/sources')).json.sources).toEqual([])
    })

    it('修改：名称、URL（重新加密）、UA、刷新间隔；kind 不可修改', async () => {
      const source = await createRemote()
      const before = await dbSource(source.id)
      const newUrl = 'https://sub2.example.com/link/CANARY2'
      const res = await call('PATCH', `/api/sources/${source.id}`, {
        name: '机场 B',
        url: newUrl,
        userAgent: 'Surge iOS/3000',
        ttlSec: 7200,
      })
      expect(res.status).toBe(200)
      expect(res.json.source).toMatchObject({
        name: '机场 B',
        url: newUrl,
        userAgent: 'Surge iOS/3000',
        ttlSec: 7200,
      })
      expect(res.json.source.updatedAt).toBeGreaterThanOrEqual(source.updatedAt)
      const after = await dbSource(source.id)
      expect(after?.urlEnc).not.toBe(before?.urlEnc)
      expect(after?.urlEnc).not.toContain('sub2')

      // userAgent 设为 null 恢复默认
      const reset = await call('PATCH', `/api/sources/${source.id}`, { userAgent: null })
      expect(reset.json.source.userAgent).toBeNull()

      for (const body of [
        { kind: 'local' },
        { content: 'x' },
        { url: 'file:///etc/passwd' },
        { name: '' },
      ]) {
        expect(
          (await call('PATCH', `/api/sources/${source.id}`, body)).status,
          JSON.stringify(body),
        ).toBe(400)
      }
    })

    it('删除：同时删除缓存和拉取日志', async () => {
      okUpstream()
      const source = await createRemote()
      expect((await call('POST', `/api/sources/${source.id}/refresh`)).status).toBe(200)
      expect(await platform.blobs.get(`src:${source.id}:nodes`)).not.toBeNull()

      const res = await call('DELETE', `/api/sources/${source.id}`)
      expect(res.status).toBe(204)
      expect((await call('GET', `/api/sources/${source.id}`)).status).toBe(404)
      expect(await platform.blobs.get(`src:${source.id}:nodes`)).toBeNull()
      expect(await platform.blobs.get(`src:${source.id}:raw`)).toBeNull()
      const logs = await platform.db
        .select()
        .from(fetchLogs)
        .where(eq(fetchLogs.sourceId, source.id))
      expect(logs).toEqual([])
    })
  })

  describe('拉取远程订阅', () => {
    it('成功：节点以 JSON 存入 src:<id>:nodes，原文存入 src:<id>:raw，保存 userinfo', async () => {
      const fetch = okUpstream()
      const source = await createRemote()
      const res = await call('POST', `/api/sources/${source.id}/refresh`)
      expect(res.status).toBe(200)
      expect(res.json.nodeCount).toBe(URI_NODES)
      expect(res.json.warnings).toEqual([])
      expect(res.json.source).toMatchObject({
        lastStatus: 'ok',
        lastError: null,
        userinfo: USERINFO,
      })
      expect(res.json.source.lastFetchedAt).toEqual(expect.any(Number))

      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, init] = fetch.mock.calls[0] ?? []
      expect(String(url)).toBe(SUB_URL)
      expect(new Headers(init?.headers).get('user-agent')).toBe('clash.meta')

      const stored = JSON.parse((await platform.blobs.get(`src:${source.id}:nodes`)) ?? 'null')
      expect(stored).toMatchObject({ format: 'base64-uri-list', warnings: [] })
      expect(stored.proxies).toHaveLength(URI_NODES)
      expect(stored.fetchedAt).toBe(res.json.source.lastFetchedAt)
      expect(await platform.blobs.get(`src:${source.id}:raw`)).toBe(b64Subscription)

      const row = await dbSource(source.id)
      expect(JSON.parse(row?.userinfoJson ?? 'null')).toEqual(USERINFO)
    })

    it('节点预览读取缓存，与直接导入的结果一致', async () => {
      okUpstream(yamlSubscription)
      const source = await createRemote()
      expect((await call('GET', `/api/sources/${source.id}/nodes`)).json.error.code).toBe(
        'NO_CACHE',
      )
      await call('POST', `/api/sources/${source.id}/refresh`)

      const nodes = await call('GET', `/api/sources/${source.id}/nodes`)
      expect(nodes.status).toBe(200)
      expect(nodes.json.format).toBe('mihomo-yaml')
      expect(nodes.json.proxies).toHaveLength(15)
      expect(nodes.json.proxies[2]).toMatchObject({ name: '🇭🇰 香港 01 | SS', type: 'ss' })
      expect(nodes.json).not.toHaveProperty('config')

      // 预览不再请求上游
      upstream(() => {
        throw new Error('should not fetch')
      })
      expect((await call('GET', `/api/sources/${source.id}/nodes`)).status).toBe(200)
    })

    it('使用订阅自定义的 User-Agent', async () => {
      const fetch = okUpstream()
      const source = await createRemote({ userAgent: 'Shadowrocket/2070' })
      await call('POST', `/api/sources/${source.id}/refresh`)
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('user-agent')).toBe(
        'Shadowrocket/2070',
      )
    })

    it('成功拉取但上游没有 subscription-userinfo 时清空 userinfo', async () => {
      okUpstream()
      const source = await createRemote()
      await call('POST', `/api/sources/${source.id}/refresh`)
      upstream(() => new Response(uriSubscription))
      const res = await call('POST', `/api/sources/${source.id}/refresh`)
      expect(res.status).toBe(200)
      expect(res.json.source.userinfo).toBeNull()
    })

    describe('失败时保留上一次成功的缓存', () => {
      const failures: Array<[string, () => void, string]> = [
        ['HTTP 错误', () => upstream(() => new Response('oops', { status: 503 })), 'FETCH_FAILED'],
        [
          '网络错误',
          () =>
            upstream(() => {
              throw new TypeError('fetch failed')
            }),
          'FETCH_FAILED',
        ],
        [
          '返回了无法识别的内容（如错误页）',
          () =>
            upstream(() => new Response('<html>maintenance</html>', { headers: UPSTREAM_HEADERS })),
          'PARSE_FAILED',
        ],
        [
          '解析出 0 个节点',
          () => upstream(() => new Response('proxies: []\nrules:\n  - MATCH,DIRECT\n')),
          'PARSE_FAILED',
        ],
      ]

      it.each(failures)('%s', async (_label, fail, code) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(1_800_000_000_000)
        okUpstream()
        const source = await createRemote()
        await call('POST', `/api/sources/${source.id}/refresh`)
        const nodesBefore = await platform.blobs.get(`src:${source.id}:nodes`)
        const rawBefore = await platform.blobs.get(`src:${source.id}:raw`)

        vi.setSystemTime(1_800_000_100_000)
        fail()
        const res = await call('POST', `/api/sources/${source.id}/refresh`)
        expect(res.status).toBe(502)
        expect(res.json.error.code).toBe(code)
        expect(res.json.error.message).not.toContain('CANARY')
        expect(res.json.source).toMatchObject({
          lastStatus: 'error',
          lastFetchedAt: 1_800_000_100_000,
          userinfo: USERINFO,
        })
        expect(res.json.source.lastError).toEqual(expect.any(String))

        // 缓存原封不动
        expect(await platform.blobs.get(`src:${source.id}:nodes`)).toBe(nodesBefore)
        expect(await platform.blobs.get(`src:${source.id}:raw`)).toBe(rawBefore)
        const nodes = await call('GET', `/api/sources/${source.id}/nodes`)
        expect(nodes.json.proxies).toHaveLength(URI_NODES)
        expect(nodes.json.fetchedAt).toBe(1_800_000_000_000)

        // 再次成功后恢复
        okUpstream(yamlSubscription)
        const again = await call('POST', `/api/sources/${source.id}/refresh`)
        expect(again.json.source).toMatchObject({ lastStatus: 'ok', lastError: null })
        expect((await call('GET', `/api/sources/${source.id}/nodes`)).json.proxies).toHaveLength(15)
      })

      it('从未成功过时没有缓存', async () => {
        upstream(() => new Response('oops', { status: 500 }))
        const source = await createRemote()
        expect((await call('POST', `/api/sources/${source.id}/refresh`)).status).toBe(502)
        expect((await call('GET', `/api/sources/${source.id}/nodes`)).status).toBe(404)
      })
    })

    it('拉取日志：新的在前，每个订阅只保留最近 20 条', async () => {
      const source = await createRemote()
      okUpstream()
      await call('POST', `/api/sources/${source.id}/refresh`)
      upstream(() => new Response('oops', { status: 500 }))
      await call('POST', `/api/sources/${source.id}/refresh`)

      const logs = (await call('GET', `/api/sources/${source.id}/logs`)).json.logs
      expect(logs).toHaveLength(2)
      expect(logs[0]).toMatchObject({ status: 'error', bytes: null })
      expect(logs[0]?.error).toContain('500')
      expect(logs[1]).toMatchObject({ status: 'ok', bytes: b64Subscription.length, error: null })
      expect(logs[1]?.durationMs).toEqual(expect.any(Number))

      for (let i = 0; i < 25; i++) await call('POST', `/api/sources/${source.id}/refresh`)
      expect((await call('GET', `/api/sources/${source.id}/logs`)).json.logs).toHaveLength(20)
    })

    describe('SSRF', () => {
      it('拒绝私有地址，不发请求', async () => {
        const fetch = okUpstream()
        for (const url of [
          'http://127.0.0.1:9090/sub?token=CANARY',
          'http://[::1]/sub',
          'http://localhost/sub',
        ]) {
          const source = await createRemote({ url })
          const res = await call('POST', `/api/sources/${source.id}/refresh`)
          expect(res.status, url).toBe(502)
          expect(res.json.error.code).toBe('SSRF_BLOCKED')
          expect(res.json.source.lastStatus).toBe('error')
        }
        expect(fetch).not.toHaveBeenCalled()
      })

      it('拒绝解析后落到内网的域名', async () => {
        const fetch = okUpstream()
        const resolveHost = vi.fn(async () => ['10.1.2.3'])
        const app1 = server.createApp(makePlatform({ resolveHost }))
        const source = await createRemote()
        const res = await call('POST', `/api/sources/${source.id}/refresh`, undefined, {
          app: app1,
        })
        expect(res.json.error.code).toBe('SSRF_BLOCKED')
        expect(resolveHost).toHaveBeenCalledWith('sub.example.com')
        expect(fetch).not.toHaveBeenCalled()
      })

      it('ALLOW_PRIVATE_FETCH 开启后可以拉取局域网订阅', async () => {
        const fetch = okUpstream()
        const app1 = server.createApp(
          makePlatform({
            env: { ...ENV, allowPrivateFetch: true },
            resolveHost: vi.fn(async () => ['192.168.1.2']),
          }),
        )
        const source = await createRemote({ url: 'http://192.168.1.2:8080/sub' })
        const res = await call('POST', `/api/sources/${source.id}/refresh`, undefined, {
          app: app1,
        })
        expect(res.status).toBe(200)
        expect(fetch).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('本地订阅', () => {
    it('新建时立即解析，修改内容后重新解析', async () => {
      const fetch = okUpstream()
      const res = await call('POST', '/api/sources', {
        name: '本地',
        kind: 'local',
        content: uriSubscription,
      })
      expect(res.status).toBe(201)
      const id = res.json.source.id
      expect(res.json.source).toMatchObject({ kind: 'local', lastStatus: 'ok', url: null })
      expect((await call('GET', `/api/sources/${id}/nodes`)).json.proxies).toHaveLength(URI_NODES)

      await call('PATCH', `/api/sources/${id}`, { content: yamlSubscription })
      expect((await call('GET', `/api/sources/${id}/nodes`)).json.proxies).toHaveLength(15)

      // refresh 重新解析内容；不访问网络
      expect((await call('POST', `/api/sources/${id}/refresh`)).json.nodeCount).toBe(15)
      expect(fetch).not.toHaveBeenCalled()
      expect(await platform.blobs.get(`src:${id}:raw`)).toBeNull()
      const row = await dbSource(id)
      expect(row?.urlEnc).toBeNull()
    })

    it('内容无法解析时记录错误，保留之前的节点', async () => {
      const res = await call('POST', '/api/sources', {
        name: '本地',
        kind: 'local',
        content: uriSubscription,
      })
      const id = res.json.source.id
      const patched = await call('PATCH', `/api/sources/${id}`, { content: 'garbage' })
      expect(patched.status).toBe(200)
      expect(patched.json.source).toMatchObject({ lastStatus: 'error' })
      expect((await call('GET', `/api/sources/${id}/nodes`)).json.proxies).toHaveLength(URI_NODES)
    })
  })

  describe('加密密钥', () => {
    it('未设置 SECRET_KEY 时自动生成并存入 settings，重启后仍能解密', async () => {
      const env = { ...ENV, secretKey: undefined }
      const app1 = server.createApp(makePlatform({ env }))
      const created = await call(
        'POST',
        '/api/sources',
        { name: 'a', kind: 'remote', url: SUB_URL },
        { app: app1 },
      )
      expect(created.status).toBe(201)
      expect(await setting('secret_key')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(printed()).toMatch(/SECRET_KEY/)

      const app2 = server.createApp(makePlatform({ env }))
      const one = await call('GET', `/api/sources/${created.json.source.id}`, undefined, {
        app: app2,
      })
      expect(one.json.source.url).toBe(SUB_URL)
    })

    it('SECRET_KEY 被更换后：启动时报错，详情中 URL 为 null，刷新报 DECRYPT_FAILED', async () => {
      const source = await createRemote()
      const fetch = okUpstream()

      const p2 = makePlatform({ env: { ...ENV, secretKey: 'another-key' } })
      await server.bootstrap(p2)
      const errors = consoleSpies[3]?.mock.calls.map((a) => a.join(' ')).join('\n')
      expect(errors).toMatch(/SECRET_KEY/)

      const app2 = server.createApp(p2)
      const one = await call('GET', `/api/sources/${source.id}`, undefined, { app: app2 })
      expect(one.status).toBe(200)
      expect(one.json.source.url).toBeNull()
      const res = await call('POST', `/api/sources/${source.id}/refresh`, undefined, { app: app2 })
      expect(res.status).toBe(502)
      expect(res.json.error.code).toBe('DECRYPT_FAILED')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('密文不能挪到其他订阅上使用', async () => {
      const a = await createRemote()
      const b = await createRemote({ url: 'https://other.example.com/sub' })
      const rowA = await dbSource(a.id)
      await platform.db.update(sources).set({ urlEnc: rowA?.urlEnc }).where(eq(sources.id, b.id))
      expect((await call('GET', `/api/sources/${b.id}`)).json.source.url).toBeNull()
    })
  })

  describe('定时刷新', () => {
    it('只刷新到期的远程订阅，失败不影响其他订阅', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_800_000_000_000)
      const fetch = upstream((url) =>
        url.includes('bad.example.com')
          ? new Response('oops', { status: 500 })
          : new Response(b64Subscription, { headers: UPSTREAM_HEADERS }),
      )
      const fresh = await createRemote({ name: 'fresh', ttlSec: 3600 })
      await call('POST', `/api/sources/${fresh.id}/refresh`)
      const never = await createRemote({ name: 'never' })
      const bad = await createRemote({ name: 'bad', url: 'https://bad.example.com/sub' })
      await call('POST', '/api/sources', { name: 'local', kind: 'local', content: uriSubscription })
      fetch.mockClear()

      vi.setSystemTime(1_800_000_000_000 + 1800 * 1000)
      const r1 = await server.runScheduledRefresh(platform)
      expect(r1).toEqual({ refreshed: 1, failed: 1 })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect((await call('GET', `/api/sources/${never.id}`)).json.source.lastStatus).toBe('ok')
      expect((await call('GET', `/api/sources/${bad.id}`)).json.source.lastStatus).toBe('error')

      // fresh 到期（ttl 1 小时）；never、bad 刚尝试过，未到期（默认 6 小时）
      fetch.mockClear()
      vi.setSystemTime(1_800_000_000_000 + 3600 * 1000)
      expect(await server.runScheduledRefresh(platform)).toEqual({ refreshed: 1, failed: 0 })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(String(fetch.mock.calls[0]?.[0])).toBe(SUB_URL)
    })

    it('某个订阅出现意外错误（如存储写入失败）时继续刷新其他订阅', async () => {
      okUpstream()
      const broken = await createRemote({ name: 'broken' })
      const ok = await createRemote({ name: 'ok' })
      const blobs: Server.BlobStore = {
        ...storage.blobs,
        put: async (key, value, opts) => {
          if (key.includes(broken.id)) throw new Error('disk full')
          return storage.blobs.put(key, value, opts)
        },
      }
      const r = await server.runScheduledRefresh(makePlatform({ blobs }))
      expect(r).toEqual({ refreshed: 1, failed: 1 })
      expect((await call('GET', `/api/sources/${ok.id}`)).json.source.lastStatus).toBe('ok')
    })
  })
}
