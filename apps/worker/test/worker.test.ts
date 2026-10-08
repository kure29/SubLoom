import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import uriSubscription from '../../../packages/core/test/fixtures/import/uri-mixed/input.txt?raw'
import worker, { type Env } from '../src/index.js'
import { nextBindings, resetStorage } from './storage.js'

// Workers 入口：fetch / scheduled 处理器、环境变量、waitUntil、每个 isolate 只初始化一次
const ADMIN = 'worker-admin-token'

let logs: MockInstance[]

beforeEach(async () => {
  await resetStorage()
  logs = (['log', 'info', 'warn', 'error'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

const printed = () =>
  logs.flatMap((s) => s.mock.calls.map((args) => args.map(String).join(' '))).join('\n')

function makeEnv(vars: Record<string, string> = {}): Env {
  const { d1, kv } = nextBindings()
  return { DB: d1, BLOBS: kv, ADMIN_TOKEN: ADMIN, SECRET_KEY: 'worker-secret', ...vars }
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {},
  token: string | null = ADMIN,
) {
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body) headers.set('content-type', 'application/json')
  const ctx = createExecutionContext()
  const waitUntil = vi.spyOn(ctx, 'waitUntil')
  const res = await worker.fetch(
    new Request(`https://subloom.example.workers.dev${path}`, { ...init, headers }),
    env,
    ctx,
  )
  const text = await res.text()
  await waitOnExecutionContext(ctx)
  return { res, text, json: () => JSON.parse(text), waitUntil }
}

describe('fetch', () => {
  it('健康检查与 meta：平台为 workers，密钥来自 Secret', async () => {
    const env = makeEnv()
    const health = await request(env, '/healthz', {}, null)
    expect(health.res.status).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })

    const meta = await request(env, '/api/meta')
    expect(meta.res.status).toBe(200)
    expect(meta.json()).toMatchObject({ platform: 'workers', secretKeySource: 'env' })
    expect((await request(env, '/api/meta', {}, 'wrong')).res.status).toBe(401)
  })

  it('未设置 ADMIN_TOKEN、SECRET_KEY 时与 Node 一致：自动生成，令牌只打印一次', async () => {
    const env = makeEnv()
    delete env.ADMIN_TOKEN
    delete env.SECRET_KEY
    // 同一个 isolate 中的多个请求（各自的 ExecutionContext）只初始化一次
    await request(env, '/healthz', {}, null)
    await request(env, '/healthz', {}, null)
    const tokens = [...printed().matchAll(/admin token[^\n]*?([A-Za-z0-9_-]{43})/gi)]
    expect(tokens).toHaveLength(1)
    const token = tokens[0]?.[1] ?? null
    const meta = await request(env, '/api/meta', {}, token)
    expect(meta.res.status).toBe(200)
    expect(meta.json().secretKeySource).toBe('generated')
  })

  it('环境变量不合法时返回 500，日志中说明原因', async () => {
    const env = makeEnv({ PUBLIC_URL: 'not a url' })
    const res = await request(env, '/healthz', {}, null)
    expect(res.res.status).toBe(500)
    expect(res.json().error.message).not.toContain('not a url')
    expect(printed()).toMatch(/PUBLIC_URL/)
  })

  it('PUBLIC_URL 用于对外链接', async () => {
    const env = makeEnv({ PUBLIC_URL: 'https://sub.example.com' })
    const source = (
      await request(env, '/api/sources', {
        method: 'POST',
        body: JSON.stringify({ name: 'l', kind: 'local', content: uriSubscription }),
      })
    ).json().source
    const ir = { version: 1, name: 'p', proxies: [], groups: [], rules: [], ruleSets: [] }
    const profile = (
      await request(env, '/api/profiles', {
        method: 'POST',
        body: JSON.stringify({ ir, sourceIds: [source.id] }),
      })
    ).json().profile
    const output = (
      await request(env, '/api/outputs', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, target: 'surge' }),
      })
    ).json().output
    expect(output.url).toBe(`https://sub.example.com${output.path}`)
    const sub = await request(env, output.path, {}, null)
    expect(sub.text.split('\n')[0]).toBe(
      `#!MANAGED-CONFIG https://sub.example.com${output.path} interval=21600 strict=false`,
    )
  })

  it('后台任务交给 ctx.waitUntil（生成结果缓存的 stale-while-revalidate）', async () => {
    const env = makeEnv()
    const create = await request(env, '/api/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'l', kind: 'local', content: uriSubscription }),
    })
    const source = create.json().source
    const ir = { version: 1, name: 'p', proxies: [], groups: [], rules: [], ruleSets: [] }
    const profile = (
      await request(env, '/api/profiles', {
        method: 'POST',
        body: JSON.stringify({ ir, sourceIds: [source.id] }),
      })
    ).json().profile
    const output = (
      await request(env, '/api/outputs', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, target: 'mihomo' }),
      })
    ).json().output
    expect((await request(env, output.path, {}, null)).waitUntil).not.toHaveBeenCalled()

    // 节点变化：先返回旧结果，后台重新生成
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    await request(env, `/api/sources/${source.id}/refresh`, { method: 'POST' })
    vi.useRealTimers()
    const stale = await request(env, output.path, {}, null)
    expect(stale.waitUntil).toHaveBeenCalledTimes(1)
    const fresh = await request(env, output.path, {}, null)
    expect(fresh.waitUntil).not.toHaveBeenCalled()
  })
})

describe('scheduled', () => {
  it('刷新到期的远程订阅，用 ctx.waitUntil 等待完成', async () => {
    const env = makeEnv()
    const created = await request(env, '/api/sources', {
      method: 'POST',
      body: JSON.stringify({
        name: 'r',
        kind: 'remote',
        url: 'https://sub.example.com/link?token=CANARY',
      }),
    })
    const id = created.json().source.id
    const fetch = vi.fn(async () => new Response(uriSubscription))
    vi.stubGlobal('fetch', fetch)

    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '*/10 * * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(fetch).toHaveBeenCalledTimes(1)
    const source = (await request(env, `/api/sources/${id}`)).json().source
    expect(source.lastStatus).toBe('ok')
    expect(printed()).not.toContain('CANARY')
  })
})
