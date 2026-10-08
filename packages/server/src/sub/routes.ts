import { CORE_VERSION, type ExportOptions } from '@subloom/core'
import { type Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import { HttpError } from '../errors.js'
import { type GenerateTarget, generate } from '../generate.js'
import { cacheKeys } from '../outputs/cache.js'
import {
  getOutputByToken,
  maskToken,
  type OutputRow,
  outputCacheKey,
  touchOutput,
} from '../outputs/service.js'
import type { Platform } from '../platform.js'
import { getProfile, type ProfileRow, toInput } from '../profiles/service.js'
import { type Ctx, DEFAULT_TTL_SEC, getSourcesByIds, type SourceRow } from '../sources/service.js'
import { externalUrl } from '../urls.js'
import { formatUserinfo, mergeUserinfo, type Userinfo } from '../userinfo.js'
import type { OutputOptions } from '../validation.js'
import { detectClient, type ExportTarget } from './user-agent.js'

// 公开接口：GET /sub/:token（生成好的配置）与 /sub/:token/proxies（节点列表）。见 PLAN.md 5.3。

/** nodes: 'provider' 时 proxy-providers 中的名称 */
export const PROVIDER_NAME = 'subloom'

/** BlobStore 中的生成结果缓存（out:<id>:<target>） */
interface CacheEntry {
  configKey: string
  nodesKey: string
  text: string
  generatedAt: number
}

/** 正在后台重新生成的缓存：同一份缓存同时只有一个任务 */
const regenerating = new WeakMap<Platform, Set<string>>()

/** RFC 5987 的 ext-value：encodeURIComponent 之外还要编码 ' ( ) * */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** 客户端的更新间隔（秒）：profile 中远程订阅源 ttlSec 的最小值，没有时为默认值 */
function updateIntervalSec(sources: readonly SourceRow[]): number {
  const ttls = sources.filter((s) => s.kind === 'remote').map((s) => s.ttlSec)
  return ttls.length > 0 ? Math.min(...ttls) : DEFAULT_TTL_SEC
}

function mergedUserinfo(sources: readonly SourceRow[]): Userinfo | null {
  return mergeUserinfo(
    sources.map((s) => (s.userinfoJson ? (JSON.parse(s.userinfoJson) as Userinfo) : null)),
  )
}

async function readCache(ctx: Ctx, key: string): Promise<CacheEntry | null> {
  const text = await ctx.platform.blobs.get(key)
  if (text === null) return null
  try {
    return JSON.parse(text) as CacheEntry
  } catch {
    return null
  }
}

interface Job {
  ctx: Ctx
  output: OutputRow
  profile: ProfileRow
  target: GenerateTarget
  options: ExportOptions
  key: string
  configKey: string
  nodesKey: string
}

/** 生成并写入缓存 */
async function regenerate(job: Job): Promise<string> {
  const { text } = await generate(job.ctx, toInput(job.profile), job.target, job.options)
  const entry: CacheEntry = {
    configKey: job.configKey,
    nodesKey: job.nodesKey,
    text,
    generatedAt: Date.now(),
  }
  await job.ctx.platform.blobs.put(job.key, JSON.stringify(entry))
  return text
}

/** 后台重新生成（stale-while-revalidate），失败只记录日志 */
function regenerateInBackground(job: Job): void {
  const { platform } = job.ctx
  let running = regenerating.get(platform)
  if (!running) {
    running = new Set()
    regenerating.set(platform, running)
  }
  if (running.has(job.key)) return
  running.add(job.key)
  const set = running
  const task = regenerate(job).then(
    () => set.delete(job.key),
    (e: unknown) => {
      set.delete(job.key)
      // 日志脱敏：只记录 token 的前 4 个字符
      console.error(
        `[subloom] regenerating ${job.target} for output ${maskToken(job.output.token)} failed:`,
        e instanceof Error ? e.message : String(e),
      )
    },
  )
  platform.waitUntil(task)
}

/** 按缓存键决定直接返回、先返回旧结果并在后台刷新，还是同步生成。见 PLAN.md 5.3"生成结果缓存"。 */
async function cachedText(job: Job): Promise<string> {
  const entry = await readCache(job.ctx, job.key)
  if (entry && entry.configKey === job.configKey) {
    if (entry.nodesKey !== job.nodesKey) regenerateInBackground(job)
    return entry.text
  }
  return regenerate(job)
}

async function serve(c: Context<AppEnv>, kind: 'config' | 'proxies') {
  const ctx = c.get('ctx')
  const token = c.req.param('token') ?? ''
  const output = await getOutputByToken(ctx, token)
  const profile = output && (await getProfile(ctx, output.profileId))
  if (!output || !profile) throw new HttpError(404, 'NOT_FOUND', 'not found')

  let target: GenerateTarget
  let fallback: string | undefined
  if (kind === 'proxies') {
    target = 'proxies'
  } else if (output.target === 'auto') {
    const detected = detectClient(c.req.header('user-agent'))
    target = detected.target
    if (detected.fallback) {
      fallback = detected.client
      console.info(
        `[subloom] output ${maskToken(token)}: the ${detected.client} exporter is not implemented yet, falling back to ${target}`,
      )
    }
  } else {
    target = output.target as ExportTarget
  }

  const sources = await getSourcesByIds(ctx, JSON.parse(profile.sourceIdsJson) as string[])
  const interval = updateIntervalSec(sources)
  const options = JSON.parse(output.optionsJson) as OutputOptions
  const url = externalUrl(c.req.url, (name) => c.req.header(name), ctx.platform.env)

  const exportOptions: ExportOptions = { ...options.export }
  let providerUrl: string | null = null
  if (target === 'mihomo' && options.nodes === 'provider') {
    const provider = new URL(url)
    provider.pathname = `${provider.pathname.replace(/\/+$/, '')}/proxies`
    provider.search = ''
    providerUrl = provider.href
    exportOptions.proxyProvider = { name: PROVIDER_NAME, url: providerUrl, interval }
  }

  const keys = await cacheKeys({
    coreVersion: CORE_VERSION,
    target,
    profile,
    optionsJson: output.optionsJson,
    providerUrl,
    // 订阅节点由 provider 提供时，配置不随节点变化
    nodes: providerUrl === null ? sources.map((s) => [s.id, s.nodesFetchedAt] as const) : null,
  })
  let text = await cachedText({
    ctx,
    output,
    profile,
    target,
    options: exportOptions,
    key: outputCacheKey(output.id, target),
    ...keys,
  })
  await touchOutput(ctx, output.id)

  const ext = target === 'surge' ? 'conf' : 'yaml'
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename*=UTF-8''${encodeRfc5987(profile.name)}.${ext}`,
    'profile-update-interval': String(Math.max(1, Math.ceil(interval / 3600))),
  }
  const userinfo = mergedUserinfo(sources)
  if (userinfo) headers['subscription-userinfo'] = formatUserinfo(userinfo)
  if (target !== 'proxies') headers['x-subloom-target'] = target
  if (fallback) headers['x-subloom-fallback'] = fallback
  // MANAGED-CONFIG 行在响应时添加，不进入缓存
  if (target === 'surge') {
    text = `#!MANAGED-CONFIG ${url.href} interval=${interval} strict=false\n${text}`
  }
  return c.body(text, 200, headers)
}

export const subRoutes = new Hono<AppEnv>()
  .get('/:token', (c) => serve(c, 'config'))
  .get('/:token/proxies', (c) => serve(c, 'proxies'))
