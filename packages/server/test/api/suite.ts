// 与运行时无关的 API 集成测试。packages/* 的测试不能使用 Node API（拿不到 better-sqlite3），
// 因此这里只定义测试，由 apps/node/test（M5 起还有 apps/worker/test）传入各自的存储运行。见 PLAN.md 第 8 节。
import { importSubscription } from '@subloom/core'
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
export type TestStorage = Pick<Server.Platform, 'name' | 'db' | 'blobs' | 'waitUntil'>

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
  trustProxy: false,
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
  profile: Server.ProfileDto
  profiles: Server.ProfileSummaryDto[]
  output: Server.OutputDto
  outputs: Server.OutputDto[]
  restored: { sources: number; profiles: number; outputs: number }
}

export function describeApi(server: ServerApi, createStorage: () => Promise<TestStorage>) {
  let storage: TestStorage
  let platform: Server.Platform
  let app: ReturnType<ServerApi['createApp']>
  let consoleSpies: MockInstance[]
  /** 测试中出现过的全部输出 token，日志中不得出现完整 token */
  let tokens: string[]

  function makePlatform(overrides: Partial<Server.Platform> = {}): Server.Platform {
    return { ...storage, env: ENV, resolveHost: vi.fn(publicDns), ...overrides }
  }

  beforeEach(async () => {
    storage = await createStorage()
    platform = makePlatform()
    app = server.createApp(platform)
    tokens = []
    consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
  })

  afterEach(() => {
    // 日志脱敏：任何日志中都不能出现订阅 URL 中的 token（测试中为 CANARY）
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) {
        const line = args.map(String).join(' ')
        expect(line).not.toContain('CANARY')
        for (const token of tokens) expect(line).not.toContain(token)
      }
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
    const json = text ? (JSON.parse(text) as Body) : ({} as Body)
    if (json.output?.token) tokens.push(json.output.token)
    for (const o of Array.isArray(json.outputs) ? json.outputs : []) tokens.push(o.token)
    return { status: res.status, json, headers: res.headers }
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

    it('同一份数据库与环境变量的不同 platform 对象共用一次初始化（Workers 每个请求一个 platform）', async () => {
      const env = { ...ENV, adminToken: undefined }
      const a = server.bootstrap(makePlatform({ env }))
      const b = server.bootstrap(makePlatform({ env, waitUntil: () => {} }))
      expect(b).toBe(a)
      await a
      // 环境变量或数据库不同（如更换了 SECRET_KEY）时重新初始化
      const otherEnv = server.bootstrap(makePlatform({ env: { ...env } }))
      const otherDb = server.bootstrap(makePlatform({ env, db: (await createStorage()).db }))
      expect(otherEnv).not.toBe(a)
      expect(otherDb).not.toBe(a)
      await Promise.all([otherEnv, otherDb])
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

  // ---------------------------------------------------------------- M4

  describe('/api/meta 与 /healthz', () => {
    it('meta：版本、运行平台、密钥来源、已实现导出器的能力矩阵', async () => {
      expect((await call('GET', '/api/meta', undefined, { token: null })).status).toBe(401)
      const res = await call('GET', '/api/meta')
      expect(res.status).toBe(200)
      const meta = res.json as unknown as Server.MetaDto
      expect(meta).toMatchObject({
        name: 'subloom',
        version: expect.any(String),
        coreVersion: expect.any(String),
        platform: storage.name,
        secretKeySource: 'env',
      })
      expect(Object.keys(meta.targets).sort()).toEqual(['mihomo', 'surge'])
      expect(meta.targets.surge?.proxyTypes).not.toContain('vless')
      expect(meta.targets.mihomo?.ruleSetProxy).toBe(true)
    })

    it('meta：未设置 SECRET_KEY 时密钥来源为 generated（重启后不变）', async () => {
      const env = { ...ENV, secretKey: undefined }
      for (let i = 0; i < 2; i++) {
        const app1 = server.createApp(makePlatform({ env }))
        const res = await call('GET', '/api/meta', undefined, { app: app1 })
        expect((res.json as unknown as Server.MetaDto).secretKeySource).toBe('generated')
      }
    })

    it('healthz：无需认证；初始化或数据库访问失败时返回 503，不含细节', async () => {
      const ok = await call('GET', '/healthz', undefined, { token: null })
      expect(ok.status).toBe(200)
      expect(ok.json).toEqual({ status: 'ok' })

      const broken = server.createApp(makePlatform({ db: {} as Server.Platform['db'] }))
      const res = await call('GET', '/healthz', undefined, { token: null, app: broken })
      expect(res.status).toBe(503)
      expect(res.json).toEqual({ status: 'error' })
    })
  })

  /** 带两个分组和兜底规则的最小 profile */
  const IR = {
    version: 1,
    name: '我的配置',
    proxies: [],
    groups: [
      {
        name: 'Proxy',
        type: 'select',
        members: [{ kind: 'builtin', name: 'DIRECT' }],
        includeAllProxies: true,
      },
    ],
    rules: [{ type: 'MATCH', target: 'Proxy' }],
    ruleSets: [],
  }

  async function createProfile(body: Record<string, unknown> = {}): Promise<Server.ProfileDto> {
    const res = await call('POST', '/api/profiles', { ir: IR, ...body })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    return res.json.profile
  }

  async function createOutput(body: Record<string, unknown>): Promise<Server.OutputDto> {
    const res = await call('POST', '/api/outputs', body)
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    return res.json.output
  }

  async function createLocal(content = uriSubscription, name = '本地'): Promise<Server.SourceDto> {
    const res = await call('POST', '/api/sources', { name, kind: 'local', content })
    expect(res.status).toBe(201)
    return res.json.source
  }

  /** 请求公开接口（不带管理令牌） */
  async function sub(
    path: string,
    opts: { ua?: string; headers?: Record<string, string>; app?: typeof app } = {},
  ) {
    const headers: Record<string, string> = { ...opts.headers }
    if (opts.ua !== undefined) headers['user-agent'] = opts.ua
    const res = await (opts.app ?? app).request(path, { headers })
    return { status: res.status, text: await res.text(), headers: res.headers }
  }

  const proxyNames = (text: string) => importSubscription(text).proxies.map((p) => p.name)

  describe('profiles', () => {
    it('增删改查：name 取自 IR，列表不返回 ir 和 pipeline', async () => {
      const source = await createLocal()
      const created = await createProfile({ sourceIds: [source.id] })
      expect(created).toMatchObject({
        name: '我的配置',
        ir: IR,
        pipeline: [],
        sourceIds: [source.id],
      })
      expect(created.id).toEqual(expect.any(String))
      expect(created.createdAt).toEqual(expect.any(Number))

      const list = await call('GET', '/api/profiles')
      expect(list.status).toBe(200)
      expect(list.json.profiles).toEqual([
        {
          id: created.id,
          name: '我的配置',
          sourceIds: [source.id],
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      ])
      expect((await call('GET', `/api/profiles/${created.id}`)).json.profile).toEqual(created)

      const pipeline = [{ op: 'prefix', text: 'A-' }]
      const patched = await call('PATCH', `/api/profiles/${created.id}`, {
        ir: { ...IR, name: '改名' },
        pipeline,
        sourceIds: [],
      })
      expect(patched.status).toBe(200)
      expect(patched.json.profile).toMatchObject({ name: '改名', pipeline, sourceIds: [] })
      expect(patched.json.profile.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
      expect((await call('GET', '/api/profiles')).json.profiles[0]?.name).toBe('改名')

      expect((await call('DELETE', `/api/profiles/${created.id}`)).status).toBe(204)
      expect((await call('GET', `/api/profiles/${created.id}`)).status).toBe(404)
      expect((await call('GET', '/api/profiles')).json.profiles).toEqual([])
    })

    it('请求体不合法时返回 400，不写入', async () => {
      const source = await createLocal()
      const bad = [
        '{not json',
        {},
        { ir: { ...IR, groups: undefined } },
        { ir: { ...IR, version: 2 } },
        { ir: IR, pipeline: [{ op: 'nope' }] },
        { ir: IR, sourceIds: ['missing'] },
        { ir: IR, sourceIds: [source.id, source.id] },
        { ir: IR, other: 1 },
      ]
      for (const body of bad) {
        const res = await call('POST', '/api/profiles', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.json.error.code).toBe('INVALID_REQUEST')
      }
      expect((await call('GET', '/api/profiles')).json.profiles).toEqual([])

      const profile = await createProfile()
      for (const body of [{ ir: { name: 'x' } }, { sourceIds: ['missing'] }, { id: 'x' }]) {
        const res = await call('PATCH', `/api/profiles/${profile.id}`, body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
      expect((await call('GET', `/api/profiles/${profile.id}`)).json.profile).toEqual(profile)
    })

    it('不存在的 profile 返回 404', async () => {
      for (const [method, path] of [
        ['GET', '/api/profiles/nope'],
        ['PATCH', '/api/profiles/nope'],
        ['DELETE', '/api/profiles/nope'],
        ['POST', '/api/profiles/nope/preview?target=mihomo'],
      ] as const) {
        const res = await call(method, path, method === 'PATCH' ? { pipeline: [] } : undefined)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.json.error.code).toBe('NOT_FOUND')
      }
    })

    it('删除订阅源时从 profile 的 sourceIds 中移除', async () => {
      const a = await createLocal(uriSubscription, 'a')
      const b = await createLocal(yamlSubscription, 'b')
      const profile = await createProfile({ sourceIds: [a.id, b.id] })
      await call('DELETE', `/api/sources/${a.id}`)
      expect((await call('GET', `/api/profiles/${profile.id}`)).json.profile.sourceIds).toEqual([
        b.id,
      ])
    })

    it('删除 profile 时同时删除它的输出和生成结果缓存', async () => {
      const profile = await createProfile()
      const output = await createOutput({ profileId: profile.id, target: 'mihomo' })
      expect((await sub(output.path)).status).toBe(200)
      expect(await platform.blobs.get(`out:${output.id}:mihomo`)).not.toBeNull()

      await call('DELETE', `/api/profiles/${profile.id}`)
      expect((await call('GET', `/api/outputs/${output.id}`)).status).toBe(404)
      expect((await sub(output.path)).status).toBe(404)
      expect(await platform.blobs.get(`out:${output.id}:mihomo`)).toBeNull()
    })
  })

  describe('preview', () => {
    it('按 sourceIds 顺序拼接节点缓存 → 流水线 → 导出；没有缓存的订阅源跳过', async () => {
      const a = await createLocal(uriSubscription, 'a')
      const b = await createLocal(yamlSubscription, 'b')
      const never = await createRemote()
      const profile = await createProfile({
        sourceIds: [b.id, never.id, a.id],
        pipeline: [
          { op: 'filter-regex', pattern: '[', mode: 'keep' },
          { op: 'prefix', text: 'P-' },
        ],
      })

      const res = await call('POST', `/api/profiles/${profile.id}/preview?target=mihomo`)
      expect(res.status).toBe(200)
      const preview = res.json as unknown as Server.PreviewResult
      const names = proxyNames(preview.text)
      expect(names).toHaveLength(15 + URI_NODES)
      expect(names.every((n) => n.startsWith('P-'))).toBe(true)
      expect(names.slice(0, 15)).toEqual(
        importSubscription(yamlSubscription).proxies.map((p) => `P-${p.name}`),
      )
      expect(preview.sources).toEqual([
        { id: b.id, nodeCount: 15 },
        { id: never.id, nodeCount: null },
        { id: a.id, nodeCount: URI_NODES },
      ])
      // 非法正则：跳过该操作并警告
      expect(preview.pipelineWarnings).toEqual([
        expect.objectContaining({ code: 'INVALID_REGEX', path: 'pipeline[0]' }),
      ])
      expect(preview.warnings).toEqual(expect.any(Array))

      const surge = await call('POST', `/api/profiles/${profile.id}/preview?target=surge`)
      expect(surge.status).toBe(200)
      const surgePreview = surge.json as unknown as Server.PreviewResult
      expect(surgePreview.text).toContain('[Proxy]')
      expect(surgePreview.text).not.toContain('#!MANAGED-CONFIG')
      // Surge 不支持 vless 等：有降级警告
      expect(surgePreview.warnings.map((w) => w.code)).toContain('UNSUPPORTED_PROXY_TYPE')
    })

    it('请求体覆盖已保存的值（预览未保存的编辑），不写入', async () => {
      const a = await createLocal()
      const profile = await createProfile()
      const res = await call('POST', `/api/profiles/${profile.id}/preview?target=mihomo`, {
        ir: { ...IR, name: '未保存' },
        sourceIds: [a.id],
        pipeline: [{ op: 'suffix', text: '-S' }],
        options: { defaultUdp: false },
      })
      expect(res.status).toBe(200)
      const { text } = res.json as unknown as Server.PreviewResult
      const proxies = importSubscription(text).proxies
      expect(proxies).toHaveLength(URI_NODES)
      expect(proxies.every((p) => p.name.endsWith('-S'))).toBe(true)
      // URI 节点没有 udp 信息，按 defaultUdp
      expect(proxies.every((p) => p.udp === false)).toBe(true)
      expect((await call('GET', `/api/profiles/${profile.id}`)).json.profile).toEqual(profile)
    })

    it('target 和请求体不合法时返回 400', async () => {
      const profile = await createProfile()
      for (const query of ['', '?target=', '?target=loon', '?target=auto', '?target=proxies']) {
        const res = await call('POST', `/api/profiles/${profile.id}/preview${query}`)
        expect(res.status, query).toBe(400)
        expect(res.json.error.code).toBe('INVALID_REQUEST')
      }
      for (const body of [
        '{not json',
        { options: { proxyProvider: { name: 'x', url: 'https://x.example.com/' } } },
        { sourceIds: ['missing'] },
        { other: 1 },
      ]) {
        const res = await call('POST', `/api/profiles/${profile.id}/preview?target=mihomo`, body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
    })
  })

  describe('outputs', () => {
    it('增删改查：token 为 32 字节 base64url，path 为 /sub/<token>', async () => {
      const p1 = await createProfile()
      const p2 = await createProfile()
      const a = await createOutput({ profileId: p1.id, target: 'mihomo' })
      expect(a).toMatchObject({
        profileId: p1.id,
        target: 'mihomo',
        options: {},
        lastAccessAt: null,
      })
      expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(a.path).toBe(`/sub/${a.token}`)
      const b = await createOutput({
        profileId: p2.id,
        target: 'auto',
        options: { export: { defaultUdp: false }, nodes: 'provider' },
      })
      expect(b.options).toEqual({ export: { defaultUdp: false }, nodes: 'provider' })
      expect(b.token).not.toBe(a.token)

      const list = await call('GET', '/api/outputs')
      expect(list.json.outputs.map((o) => o.id).sort()).toEqual([a.id, b.id].sort())
      const filtered = await call('GET', `/api/outputs?profileId=${p2.id}`)
      expect(filtered.json.outputs).toEqual([b])
      expect((await call('GET', `/api/outputs/${a.id}`)).json.output).toEqual(a)

      const patched = await call('PATCH', `/api/outputs/${a.id}`, {
        target: 'surge',
        options: { export: { ruleSetMirror: 'jsdelivr' } },
      })
      expect(patched.status).toBe(200)
      expect(patched.json.output).toEqual({
        ...a,
        target: 'surge',
        options: { export: { ruleSetMirror: 'jsdelivr' } },
      })

      expect((await call('DELETE', `/api/outputs/${a.id}`)).status).toBe(204)
      expect((await call('GET', `/api/outputs/${a.id}`)).status).toBe(404)
      expect((await sub(a.path)).status).toBe(404)
    })

    it('请求体不合法时返回 400；shadowrocket、loon 的导出器尚未实现', async () => {
      const profile = await createProfile()
      for (const body of [
        '{not json',
        { profileId: profile.id },
        { profileId: 'missing', target: 'mihomo' },
        { profileId: profile.id, target: 'shadowrocket' },
        { profileId: profile.id, target: 'loon' },
        { profileId: profile.id, target: 'clash' },
        { profileId: profile.id, target: 'mihomo', options: { nodes: 'remote' } },
        { profileId: profile.id, target: 'mihomo', options: { export: { defaultUdp: 1 } } },
        {
          profileId: profile.id,
          target: 'mihomo',
          options: { export: { proxyProvider: { name: 'x', url: 'https://x.example.com/' } } },
        },
        { profileId: profile.id, target: 'mihomo', token: 'chosen-token' },
      ]) {
        const res = await call('POST', '/api/outputs', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.json.error.code).toBe('INVALID_REQUEST')
      }
      const rejected = await call('POST', '/api/outputs', { profileId: profile.id, target: 'loon' })
      expect(rejected.json.error.message).toMatch(/not implemented/)
      expect((await call('GET', '/api/outputs')).json.outputs).toEqual([])

      const output = await createOutput({ profileId: profile.id, target: 'mihomo' })
      for (const body of [{ target: 'loon' }, { profileId: profile.id }, { token: 'x' }]) {
        expect((await call('PATCH', `/api/outputs/${output.id}`, body)).status).toBe(400)
      }
    })

    it('不存在的输出返回 404', async () => {
      for (const [method, path] of [
        ['GET', '/api/outputs/nope'],
        ['PATCH', '/api/outputs/nope'],
        ['DELETE', '/api/outputs/nope'],
        ['POST', '/api/outputs/nope/rotate'],
      ] as const) {
        const res = await call(method, path, method === 'PATCH' ? { target: 'surge' } : undefined)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.json.error.code).toBe('NOT_FOUND')
      }
    })

    it('rotate：生成新 token，旧链接立即失效，清除生成结果缓存', async () => {
      const profile = await createProfile()
      const output = await createOutput({ profileId: profile.id, target: 'mihomo' })
      expect((await sub(output.path)).status).toBe(200)
      expect(await platform.blobs.get(`out:${output.id}:mihomo`)).not.toBeNull()

      const res = await call('POST', `/api/outputs/${output.id}/rotate`)
      expect(res.status).toBe(200)
      const rotated = res.json.output
      expect(rotated).toMatchObject({ id: output.id, profileId: profile.id, target: 'mihomo' })
      expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(rotated.token).not.toBe(output.token)
      expect(rotated.path).toBe(`/sub/${rotated.token}`)
      expect(await platform.blobs.get(`out:${output.id}:mihomo`)).toBeNull()

      expect((await sub(output.path)).status).toBe(404)
      expect((await sub(rotated.path)).status).toBe(200)
    })
  })

  describe('/sub/:token', () => {
    const SUB_URL_B = 'https://sub-b.example.com/link?token=CANARY'
    const SUB_URL_C = 'https://sub-c.example.com/link?token=CANARY'

    /** 三个远程订阅：A 有 userinfo，B 的 userinfo 不同，C 没有该头 */
    function multiUpstream() {
      return upstream((url) => {
        if (url.startsWith('https://sub-b.')) {
          return new Response(yamlSubscription, {
            headers: {
              'subscription-userinfo': 'upload=2; download=3; total=1000; expire=1700000000',
            },
          })
        }
        if (url.startsWith('https://sub-c.')) return new Response(uriSubscription)
        return new Response(b64Subscription, { headers: UPSTREAM_HEADERS })
      })
    }

    async function refreshed(extra: Record<string, unknown> = {}) {
      const source = await createRemote(extra)
      expect((await call('POST', `/api/sources/${source.id}/refresh`)).status).toBe(200)
      return source
    }

    it('不存在的 token 返回 404，无需管理令牌', async () => {
      const res = await sub('/sub/nope')
      expect(res.status).toBe(404)
      expect((await sub('/sub/nope/proxies')).status).toBe(404)
    })

    it('mihomo：配置内容与全部响应头', async () => {
      multiUpstream()
      const a = await refreshed({ ttlSec: 7200 })
      const b = await refreshed({ url: SUB_URL_B, ttlSec: 3 * 3600 })
      const c = await refreshed({ url: SUB_URL_C })
      const local = await createLocal()
      const profile = await createProfile({
        sourceIds: [a.id, b.id, c.id, local.id],
        pipeline: [{ op: 'dedupe', by: 'name' }],
      })
      const output = await createOutput({ profileId: profile.id, target: 'mihomo' })

      const res = await sub(output.path, { ua: 'clash-verge/v2.0.3' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent('我的配置')}.yaml`,
      )
      // 远程订阅 ttlSec 的最小值（2 小时）
      expect(res.headers.get('profile-update-interval')).toBe('2')
      // A + B 求和，expire 取最早；C（没有该头）和本地订阅不参与
      expect(res.headers.get('subscription-userinfo')).toBe(
        `upload=${USERINFO.upload + 2}; download=${USERINFO.download + 3}; total=${USERINFO.total + 1000}; expire=1700000000`,
      )
      expect(res.headers.get('x-subloom-target')).toBe('mihomo')
      expect(res.headers.get('x-subloom-fallback')).toBeNull()

      const imported = importSubscription(res.text)
      expect(imported.format).toBe('mihomo-yaml')
      // 按名称去重：C、本地与 A 的节点相同
      const unique = new Set(
        [uriSubscription, yamlSubscription].flatMap((t) =>
          importSubscription(t).proxies.map((p) => p.name),
        ),
      )
      expect(imported.proxies.map((p) => p.name).sort()).toEqual([...unique].sort())
      expect(imported.config?.groups?.[0]?.name).toBe('Proxy')

      const after = await call('GET', `/api/outputs/${output.id}`)
      expect(after.json.output.lastAccessAt).toEqual(expect.any(Number))
    })

    it('没有任何来源有流量信息时不返回 subscription-userinfo；没有远程订阅时更新间隔为 6 小时', async () => {
      const local = await createLocal()
      const profile = await createProfile({ sourceIds: [local.id] })
      const output = await createOutput({ profileId: profile.id, target: 'mihomo' })
      const res = await sub(output.path)
      expect(res.status).toBe(200)
      expect(res.headers.get('subscription-userinfo')).toBeNull()
      expect(res.headers.get('profile-update-interval')).toBe('6')
      expect(proxyNames(res.text)).toHaveLength(URI_NODES)
    })

    it('订阅源还没有节点缓存时照常生成（只含手动节点）', async () => {
      const never = await createRemote()
      const profile = await createProfile({ sourceIds: [never.id] })
      const output = await createOutput({ profileId: profile.id, target: 'mihomo' })
      const res = await sub(output.path)
      expect(res.status).toBe(200)
      expect(proxyNames(res.text)).toEqual([])
    })

    it('Surge：首行 MANAGED-CONFIG（当前 URL，间隔为秒），文件名为 .conf', async () => {
      multiUpstream()
      const a = await refreshed()
      const profile = await createProfile({ sourceIds: [a.id] })
      const output = await createOutput({ profileId: profile.id, target: 'surge' })

      const res = await sub(output.path, { ua: 'Surge iOS/3083' })
      expect(res.status).toBe(200)
      const [first, ...rest] = res.text.split('\n')
      expect(first).toBe(
        `#!MANAGED-CONFIG http://localhost${output.path} interval=21600 strict=false`,
      )
      expect(rest.join('\n')).toContain('[Proxy]')
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent('我的配置')}.conf`,
      )
      expect(res.headers.get('subscription-userinfo')).toBe(
        UPSTREAM_HEADERS['subscription-userinfo'],
      )
      expect(res.headers.get('x-subloom-target')).toBe('surge')
      // MANAGED-CONFIG 行在响应时添加，缓存中不含该行
      const cached = JSON.parse((await platform.blobs.get(`out:${output.id}:surge`)) ?? '{}')
      expect(cached.text).not.toContain('MANAGED-CONFIG')
      expect(cached.text).toBe(rest.join('\n'))
    })

    describe('对外链接：PUBLIC_URL > TRUST_PROXY 时的 X-Forwarded-* > 请求的 Host', () => {
      const FORWARDED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'proxy.example.net' }

      /** 返回 Surge 配置首行和 provider 地址 */
      async function links(env: Partial<Server.PlatformEnv>, headers: Record<string, string> = {}) {
        const local = await createLocal()
        const profile = await createProfile({ sourceIds: [local.id] })
        const surge = await createOutput({ profileId: profile.id, target: 'surge' })
        const mihomo = await createOutput({
          profileId: profile.id,
          target: 'mihomo',
          options: { nodes: 'provider' },
        })
        const app1 = server.createApp(makePlatform({ env: { ...ENV, ...env } }))
        const managed = (await sub(`${surge.path}?x=1`, { app: app1, headers })).text.split('\n')[0]
        const provider = /url: (\S+\/proxies)/.exec(
          (await sub(mihomo.path, { app: app1, headers })).text,
        )?.[1]
        const dto = (await call('GET', `/api/outputs/${surge.id}`, undefined, { app: app1 })).json
          .output
        return { managed, provider, url: dto.url, surge, mihomo }
      }

      it('都未设置：用请求的 Host，忽略 X-Forwarded-*', async () => {
        const r = await links({}, FORWARDED)
        expect(r.managed).toBe(
          `#!MANAGED-CONFIG http://localhost${r.surge.path}?x=1 interval=21600 strict=false`,
        )
        expect(r.provider).toBe(`http://localhost${r.mihomo.path}/proxies`)
        expect(r.url).toBeNull()
      })

      it('TRUST_PROXY=true：按 X-Forwarded-Proto / X-Forwarded-Host 改写', async () => {
        const r = await links({ trustProxy: true }, FORWARDED)
        expect(r.managed).toBe(
          `#!MANAGED-CONFIG https://proxy.example.net${r.surge.path}?x=1 interval=21600 strict=false`,
        )
        expect(r.provider).toBe(`https://proxy.example.net${r.mihomo.path}/proxies`)
        // 没有这两个头时仍用请求的 Host
        const plain = await links({ trustProxy: true })
        expect(plain.provider).toBe(`http://localhost${plain.mihomo.path}/proxies`)
      })

      it('TRUST_PROXY=true：不合法的头被忽略', async () => {
        const r = await links(
          { trustProxy: true },
          { 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'evil.example/path' },
        )
        expect(r.provider).toBe(`http://localhost${r.mihomo.path}/proxies`)
      })

      it('PUBLIC_URL：优先于一切请求头，支持路径前缀；输出带完整的 url', async () => {
        const r = await links(
          { publicUrl: 'https://example.com/subloom', trustProxy: true },
          FORWARDED,
        )
        expect(r.managed).toBe(
          `#!MANAGED-CONFIG https://example.com/subloom${r.surge.path}?x=1 interval=21600 strict=false`,
        )
        expect(r.provider).toBe(`https://example.com/subloom${r.mihomo.path}/proxies`)
        expect(r.url).toBe(`https://example.com/subloom${r.surge.path}`)
      })
    })

    it('文件名中的特殊字符按 RFC 5987 编码', async () => {
      const profile = await createProfile({ ir: { ...IR, name: "Bob's (main) *config*" } })
      const output = await createOutput({ profileId: profile.id, target: 'mihomo' })
      expect((await sub(output.path)).headers.get('content-disposition')).toBe(
        "attachment; filename*=UTF-8''Bob%27s%20%28main%29%20%2Aconfig%2A.yaml",
      )
    })

    describe('target=auto 按 User-Agent 识别', () => {
      const cases: Array<[ua: string | undefined, target: string, fallback: string | null]> = [
        ['Surge Mac/2735', 'surge', null],
        ['clash-verge/v2.0.3', 'mihomo', null],
        ['Stash/2.4.6 Clash/1.9.0', 'mihomo', null],
        ['Shadowrocket/2070 CFNetwork/1410.0.3 Darwin/22.6.0', 'mihomo', 'shadowrocket'],
        ['Loon/797 CFNetwork/1410.0.3 Darwin/22.6.0', 'mihomo', 'loon'],
        ['Mozilla/5.0', 'mihomo', null],
        [undefined, 'mihomo', null],
      ]

      it.each(cases)('%s → %s', async (ua, target, fallback) => {
        const profile = await createProfile()
        const output = await createOutput({ profileId: profile.id, target: 'auto' })
        const res = await sub(output.path, { ua })
        expect(res.status).toBe(200)
        expect(res.headers.get('x-subloom-target')).toBe(target)
        expect(res.headers.get('x-subloom-fallback')).toBe(fallback)
        expect(res.text.startsWith('#!MANAGED-CONFIG')).toBe(target === 'surge')
        expect(await platform.blobs.get(`out:${output.id}:${target}`)).not.toBeNull()
      })

      it('回退时记一条 info 日志，其中只有 token 的前 4 个字符', async () => {
        const profile = await createProfile()
        const output = await createOutput({ profileId: profile.id, target: 'auto' })
        await sub(output.path, { ua: 'Shadowrocket/2070' })
        const logs = printed()
        expect(logs).toContain(`${output.token.slice(0, 4)}…`)
        expect(logs).toMatch(/shadowrocket/i)
        // 完整 token 不出现在日志中：由 afterEach 检查
      })
    })

    describe('生成结果缓存', () => {
      /** 收集 waitUntil 的后台任务，测试中手动等待 */
      function deferredPlatform() {
        const pending: Array<Promise<unknown>> = []
        const p = makePlatform({ waitUntil: (task) => void pending.push(task) })
        return { app: server.createApp(p), pending }
      }

      async function setup(options?: Record<string, unknown>) {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(1_800_000_000_000)
        okUpstream()
        const a = await refreshed()
        const profile = await createProfile({ sourceIds: [a.id] })
        const output = await createOutput({ profileId: profile.id, target: 'mihomo', options })
        return { a, profile, output, ...deferredPlatform() }
      }

      /** 订阅刷新出新的节点（15 个），节点缓存版本变化 */
      async function nodesChange(sourceId: string) {
        vi.setSystemTime(1_800_000_100_000)
        okUpstream(yamlSubscription)
        expect((await call('POST', `/api/sources/${sourceId}/refresh`)).json.nodeCount).toBe(15)
      }

      it('缓存命中时直接返回缓存内容，不重新生成', async () => {
        const { output, app: app1, pending } = await setup()
        const first = await sub(output.path, { app: app1 })
        expect(proxyNames(first.text)).toHaveLength(URI_NODES)

        const key = `out:${output.id}:mihomo`
        const entry = JSON.parse((await platform.blobs.get(key)) ?? 'null')
        expect(entry).toMatchObject({
          configKey: expect.stringMatching(/^[0-9a-f]{64}$/),
          nodesKey: expect.stringMatching(/^[0-9a-f]{64}$/),
          text: first.text,
          generatedAt: 1_800_000_000_000,
        })
        await platform.blobs.put(key, JSON.stringify({ ...entry, text: 'proxies: []\n# cached\n' }))
        expect((await sub(output.path, { app: app1 })).text).toBe('proxies: []\n# cached\n')
        expect(pending).toEqual([])
      })

      it('节点变化：先返回旧结果，后台重新生成（stale-while-revalidate）', async () => {
        const { a, output, app: app1, pending } = await setup()
        await sub(output.path, { app: app1 })
        await nodesChange(a.id)

        const stale = await sub(output.path, { app: app1 })
        expect(proxyNames(stale.text)).toHaveLength(URI_NODES)
        expect(pending).toHaveLength(1)
        // 后台任务完成前的并发请求不会再启动一个
        await sub(output.path, { app: app1 })
        expect(pending).toHaveLength(1)
        await Promise.all(pending)

        const fresh = await sub(output.path, { app: app1 })
        expect(proxyNames(fresh.text)).toHaveLength(15)
        expect(pending).toHaveLength(1)
      })

      it('profile 变化：同步重新生成', async () => {
        const { profile, output, app: app1, pending } = await setup()
        await sub(output.path, { app: app1 })
        await call('PATCH', `/api/profiles/${profile.id}`, {
          pipeline: [{ op: 'prefix', text: 'NEW-' }],
        })
        const res = await sub(output.path, { app: app1 })
        expect(proxyNames(res.text).every((n) => n.startsWith('NEW-'))).toBe(true)
        expect(pending).toEqual([])
      })

      it('导出选项变化：同步重新生成', async () => {
        const { output, app: app1, pending } = await setup()
        await sub(output.path, { app: app1 })
        await call('PATCH', `/api/outputs/${output.id}`, {
          options: { export: { defaultUdp: false } },
        })
        const res = await sub(output.path, { app: app1 })
        expect(importSubscription(res.text).proxies.every((p) => p.udp === false)).toBe(true)
        expect(pending).toEqual([])
      })

      it('configKey 不同（如升级了 core）：同步重新生成，即使节点也变了', async () => {
        const { a, output, app: app1, pending } = await setup()
        await sub(output.path, { app: app1 })
        const key = `out:${output.id}:mihomo`
        const entry = JSON.parse((await platform.blobs.get(key)) ?? 'null')
        await platform.blobs.put(
          key,
          JSON.stringify({ ...entry, configKey: 'old-core', text: 'proxies: []\n# old\n' }),
        )
        await nodesChange(a.id)
        const res = await sub(output.path, { app: app1 })
        expect(proxyNames(res.text)).toHaveLength(15)
        expect(pending).toEqual([])
      })

      it('后台重新生成失败时记录日志（不含完整 token），旧结果仍然可用', async () => {
        const { a, output, pending } = await setup()
        await sub(output.path)
        await nodesChange(a.id)
        const blobs: Server.BlobStore = {
          ...storage.blobs,
          put: async (key, value, opts) => {
            if (key.startsWith('out:')) throw new Error('disk full')
            return storage.blobs.put(key, value, opts)
          },
        }
        const failing = server.createApp(
          makePlatform({ blobs, waitUntil: (task) => void pending.push(task) }),
        )
        const res = await sub(output.path, { app: failing })
        expect(proxyNames(res.text)).toHaveLength(URI_NODES)
        await Promise.allSettled(pending)
        expect(printed()).toContain(`${output.token.slice(0, 4)}…`)
        expect(proxyNames((await sub(output.path, { app: failing })).text)).toHaveLength(URI_NODES)
        // 上一次失败后不再占用：再次请求时重新尝试
        expect(pending).toHaveLength(2)
        await Promise.allSettled(pending)
      })
    })

    describe("nodes: 'provider'", () => {
      it('mihomo 配置通过 proxy-providers 引用 /sub/:token/proxies', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(1_800_000_000_000)
        okUpstream()
        const a = await refreshed({ ttlSec: 3600 })
        const profile = await createProfile({
          sourceIds: [a.id],
          pipeline: [{ op: 'prefix', text: 'P-' }],
        })
        const output = await createOutput({
          profileId: profile.id,
          target: 'mihomo',
          options: { nodes: 'provider' },
        })
        const pending: Array<Promise<unknown>> = []
        const app1 = server.createApp(
          makePlatform({ waitUntil: (task) => void pending.push(task) }),
        )

        const res = await sub(output.path, { app: app1 })
        expect(res.status).toBe(200)
        expect(proxyNames(res.text)).toEqual([])
        expect(res.text).toContain(
          `proxy-providers:\n  subloom:\n    type: http\n    url: http://localhost${output.path}/proxies\n    interval: 3600\n`,
        )
        expect(res.text).toMatch(/use:\n {6}- subloom\n/)
        expect(res.headers.get('subscription-userinfo')).toBe(
          UPSTREAM_HEADERS['subscription-userinfo'],
        )

        const nodes = await sub(`${output.path}/proxies`, { app: app1 })
        expect(nodes.status).toBe(200)
        expect(nodes.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(nodes.headers.get('subscription-userinfo')).toBe(
          UPSTREAM_HEADERS['subscription-userinfo'],
        )
        expect(nodes.headers.get('profile-update-interval')).toBe('1')
        const imported = importSubscription(nodes.text)
        expect(imported.config).toBeUndefined()
        expect(imported.proxies).toHaveLength(URI_NODES)
        expect(imported.proxies.every((p) => p.name.startsWith('P-'))).toBe(true)

        // 节点变化：配置不含订阅节点，缓存仍然有效；节点列表走 stale-while-revalidate
        vi.setSystemTime(1_800_000_100_000)
        okUpstream(yamlSubscription)
        await call('POST', `/api/sources/${a.id}/refresh`)
        expect((await sub(output.path, { app: app1 })).text).toBe(res.text)
        expect(pending).toEqual([])
        expect(proxyNames((await sub(`${output.path}/proxies`, { app: app1 })).text)).toHaveLength(
          URI_NODES,
        )
        await Promise.all(pending)
        expect(proxyNames((await sub(`${output.path}/proxies`, { app: app1 })).text)).toHaveLength(
          15,
        )

        // rotate 后 provider 地址随 token 变化
        const rotated = (await call('POST', `/api/outputs/${output.id}/rotate`)).json.output
        const after = await sub(rotated.path, { app: app1 })
        expect(after.text).toContain(`url: http://localhost${rotated.path}/proxies`)
      })

      it('只影响 mihomo：Surge 仍然内联节点', async () => {
        const local = await createLocal()
        const profile = await createProfile({ sourceIds: [local.id] })
        const output = await createOutput({
          profileId: profile.id,
          target: 'auto',
          options: { nodes: 'provider' },
        })
        const res = await sub(output.path, { ua: 'Surge iOS/3083' })
        expect(res.text).not.toContain('proxy-providers')
        expect(
          res.text.split('\n').filter((l) => / = (ss|trojan|vmess|hysteria2),/.test(l)).length,
        ).toBeGreaterThan(0)
      })

      it('内联模式的输出也提供节点列表', async () => {
        const local = await createLocal()
        const profile = await createProfile({ sourceIds: [local.id] })
        const output = await createOutput({ profileId: profile.id, target: 'surge' })
        const res = await sub(`${output.path}/proxies`)
        expect(res.status).toBe(200)
        expect(proxyNames(res.text)).toHaveLength(URI_NODES)
        expect(res.text).not.toContain('MANAGED-CONFIG')
      })
    })
  })

  describe('备份与恢复', () => {
    async function populate() {
      okUpstream()
      const remote = await createRemote({ userAgent: 'mihomo/1.19', ttlSec: 3600 })
      await call('POST', `/api/sources/${remote.id}/refresh`)
      const local = await createLocal()
      const profile = await createProfile({
        sourceIds: [remote.id, local.id],
        pipeline: [{ op: 'add-flag' }],
      })
      const output = await createOutput({
        profileId: profile.id,
        target: 'auto',
        options: { nodes: 'provider' },
      })
      return { remote, local, profile, output }
    }

    it('backup：明文订阅链接与输出 token，附妥善保管的提示；不含令牌、密钥和缓存', async () => {
      const { remote, local, profile, output } = await populate()
      expect((await call('GET', '/api/backup', undefined, { token: null })).status).toBe(401)

      const res = await call('GET', '/api/backup')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toMatch(
        /^attachment; filename="subloom-backup-\d{8}\.json"$/,
      )
      expect(res.headers.get('cache-control')).toBe('no-store')
      const backup = res.json as unknown as Server.Backup
      expect(backup).toMatchObject({ format: 'subloom-backup', version: 1 })
      expect(backup.exportedAt).toEqual(expect.any(Number))
      expect(backup.warning).toMatch(/plaintext/i)
      expect(backup.sources).toEqual([
        {
          id: remote.id,
          name: '机场 A',
          kind: 'remote',
          url: SUB_URL,
          content: null,
          userAgent: 'mihomo/1.19',
          ttlSec: 3600,
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
        },
        {
          id: local.id,
          name: '本地',
          kind: 'local',
          url: null,
          content: uriSubscription,
          userAgent: null,
          ttlSec: local.ttlSec,
          createdAt: local.createdAt,
          updatedAt: local.updatedAt,
        },
      ])
      expect(backup.profiles).toEqual([
        {
          id: profile.id,
          ir: profile.ir,
          pipeline: profile.pipeline,
          sourceIds: profile.sourceIds,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        },
      ])
      expect(backup.outputs).toEqual([
        {
          id: output.id,
          profileId: profile.id,
          target: 'auto',
          token: output.token,
          options: { nodes: 'provider' },
          createdAt: output.createdAt,
        },
      ])
      expect(Object.keys(backup).sort()).toEqual(
        ['exportedAt', 'format', 'outputs', 'profiles', 'sources', 'version', 'warning'].sort(),
      )
      const text = JSON.stringify(backup)
      expect(text).not.toContain(ENV.secretKey)
      expect(text).not.toContain(ADMIN_TOKEN)
      expect(text).not.toContain(`"${(await dbSource(remote.id))?.urlEnc}"`)
    })

    it('restore 到新实例：数据一致，URL 用新密钥重新加密，旧链接仍然有效', async () => {
      const { remote, local, profile, output } = await populate()
      const backup = (await call('GET', '/api/backup')).json

      const storage2 = await createStorage()
      const p2 = { ...makePlatform(), ...storage2, env: { ...ENV, secretKey: 'other-key' } }
      const app2 = server.createApp(p2)
      const res = await call('POST', '/api/restore', backup, { app: app2 })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      expect(res.json.restored).toEqual({ sources: 2, profiles: 1, outputs: 1 })

      const sources2 = (await call('GET', '/api/sources', undefined, { app: app2 })).json.sources
      expect(sources2.find((s) => s.id === remote.id)).toMatchObject({
        url: SUB_URL,
        userAgent: 'mihomo/1.19',
        ttlSec: 3600,
        createdAt: remote.createdAt,
      })
      const rows = await p2.db.select().from(sources).where(eq(sources.id, remote.id))
      expect(rows[0]?.urlEnc).toMatch(/^v1\./)
      expect(rows[0]?.urlEnc).not.toBe((await dbSource(remote.id))?.urlEnc)
      // 本地订阅立即解析；远程订阅需要重新拉取
      const localNodes = await call('GET', `/api/sources/${local.id}/nodes`, undefined, {
        app: app2,
      })
      expect(localNodes.json.proxies).toHaveLength(URI_NODES)
      const remoteNodes = await call('GET', `/api/sources/${remote.id}/nodes`, undefined, {
        app: app2,
      })
      expect(remoteNodes.json.error.code).toBe('NO_CACHE')

      expect(
        (await call('GET', `/api/profiles/${profile.id}`, undefined, { app: app2 })).json.profile,
      ).toEqual(profile)
      expect((await sub(output.path, { app: app2 })).status).toBe(200)
      expect((await sub(`${output.path}/proxies`, { app: app2 })).status).toBe(200)

      // 再次备份得到相同的数据
      const again = (await call('GET', '/api/backup', undefined, { app: app2 })).json
      expect({ ...again, exportedAt: 0 }).toEqual({ ...backup, exportedAt: 0 })
    })

    it('restore 替换全部现有数据，清除旧数据的缓存', async () => {
      const { output } = await populate()
      const backup = (await call('GET', '/api/backup')).json as unknown as Server.Backup
      expect((await sub(output.path)).status).toBe(200)

      const extra = await createLocal(yamlSubscription, '多余')
      const extraProfile = await createProfile({ sourceIds: [extra.id] })
      const extraOutput = await createOutput({ profileId: extraProfile.id, target: 'mihomo' })
      expect((await sub(extraOutput.path)).status).toBe(200)

      const res = await call('POST', '/api/restore', backup)
      expect(res.status).toBe(200)
      expect((await call('GET', '/api/sources')).json.sources).toHaveLength(2)
      expect((await call('GET', '/api/profiles')).json.profiles).toHaveLength(1)
      expect((await call('GET', '/api/outputs')).json.outputs).toHaveLength(1)
      expect((await sub(extraOutput.path)).status).toBe(404)
      expect(await platform.blobs.get(`src:${extra.id}:nodes`)).toBeNull()
      expect(await platform.blobs.get(`out:${extraOutput.id}:mihomo`)).toBeNull()
      expect(await platform.blobs.get(`out:${output.id}:mihomo`)).toBeNull()
      const logs = await platform.db.select().from(fetchLogs)
      expect(logs.filter((l) => l.sourceId === extra.id)).toEqual([])
    })

    it('备份内容不合法时返回 400，不改动现有数据', async () => {
      const { profile } = await populate()
      const backup = (await call('GET', '/api/backup')).json as unknown as Server.Backup
      const [s0, s1] = backup.sources
      const [p0] = backup.profiles
      const [o0] = backup.outputs
      if (!s0 || !s1 || !p0 || !o0) throw new Error('backup is incomplete')
      const bad: unknown[] = [
        '{not json',
        {},
        { ...backup, format: 'other' },
        { ...backup, version: 2 },
        { ...backup, sources: [s0, { ...s1, id: s0.id }] },
        { ...backup, sources: [{ ...s0, url: 'ftp://x.example.com/' }, s1] },
        { ...backup, sources: [{ ...s0, kind: 'local', content: null }, s1] },
        { ...backup, sources: [s0] },
        { ...backup, profiles: [{ ...p0, ir: { name: 'x' } }] },
        { ...backup, outputs: [{ ...o0, profileId: 'missing' }] },
        { ...backup, outputs: [o0, { ...o0, id: 'other' }] },
        { ...backup, outputs: [{ ...o0, target: 'loon' }] },
      ]
      for (const body of bad) {
        const res = await call('POST', '/api/restore', body)
        expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(400)
        expect(res.json.error.code).toBe('INVALID_REQUEST')
      }
      expect((await call('GET', `/api/profiles/${profile.id}`)).json.profile).toEqual(profile)
      expect((await call('GET', '/api/backup')).json).toMatchObject({
        sources: backup.sources,
        profiles: backup.profiles,
        outputs: backup.outputs,
      })
    })
  })
}
