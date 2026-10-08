import {
  type ImportFormat,
  type ImportWarning,
  importSubscription,
  type ProxyNode,
} from '@subloom/core'
import { fetchLogs, sources } from '@subloom/db'
import { and, desc, eq, notInArray } from 'drizzle-orm'
import type { Runtime } from '../bootstrap.js'
import { DecryptError, decrypt, encrypt } from '../crypto.js'
import type { SourceErrorCode } from '../errors.js'
import { DEFAULT_USER_AGENT, fetchSubscription } from '../fetch.js'
import type { Platform } from '../platform.js'
import { SsrfError } from '../ssrf.js'
import type { Userinfo } from '../userinfo.js'

// 订阅源的存储与刷新。见 PLAN.md 5.2–5.4。

export type SourceRow = typeof sources.$inferSelect

export const DEFAULT_TTL_SEC = 6 * 3600
export const MIN_TTL_SEC = 300
/** 每个订阅保留的拉取日志条数 */
export const FETCH_LOG_LIMIT = 20

export interface SourceDto {
  id: string
  name: string
  kind: 'remote' | 'local'
  /** 明文 URL；本地订阅、或无法解密（SECRET_KEY 被更换）时为 null */
  url: string | null
  /** 本地订阅的内容；列表中不返回 */
  content?: string | null
  userAgent: string | null
  ttlSec: number
  lastFetchedAt: number | null
  lastStatus: 'ok' | 'error' | null
  lastError: string | null
  userinfo: Userinfo | null
  createdAt: number
  updatedAt: number
}

export interface FetchLogDto {
  at: number
  status: 'ok' | 'error'
  bytes: number | null
  durationMs: number | null
  error: string | null
}

/** 存在 BlobStore 中的解析结果（src:<id>:nodes） */
export interface CachedNodes {
  /** 本次成功拉取（或解析本地内容）的时间 */
  fetchedAt: number
  format: ImportFormat
  proxies: ProxyNode[]
  warnings: ImportWarning[]
}

export type RefreshResult =
  | { ok: true; nodeCount: number; warnings: ImportWarning[] }
  | { ok: false; code: SourceErrorCode; message: string }

export const blobKeys = {
  raw: (id: string) => `src:${id}:raw`,
  nodes: (id: string) => `src:${id}:nodes`,
}

/** URL 密文的附加认证数据：密文不能挪到其他订阅上使用 */
const urlAad = (id: string) => `source:${id}`

export interface Ctx {
  platform: Platform
  runtime: Runtime
}

export async function listSources({ platform }: Ctx): Promise<SourceRow[]> {
  return platform.db.select().from(sources).orderBy(sources.createdAt, sources.id)
}

export async function getSource({ platform }: Ctx, id: string): Promise<SourceRow | undefined> {
  const rows = await platform.db.select().from(sources).where(eq(sources.id, id))
  return rows[0]
}

export async function toDto(ctx: Ctx, row: SourceRow, withContent: boolean): Promise<SourceDto> {
  const dto: SourceDto = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: await decryptUrl(ctx, row).catch(() => null),
    userAgent: row.userAgent,
    ttlSec: row.ttlSec,
    lastFetchedAt: row.lastFetchedAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    userinfo: row.userinfoJson ? (JSON.parse(row.userinfoJson) as Userinfo) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (withContent) dto.content = row.content
  return dto
}

async function decryptUrl({ runtime }: Ctx, row: SourceRow): Promise<string | null> {
  if (row.urlEnc === null) return null
  return decrypt(runtime.key, row.urlEnc, urlAad(row.id))
}

export type CreateInput =
  | { kind: 'remote'; name: string; url: string; userAgent?: string | null; ttlSec?: number }
  | { kind: 'local'; name: string; content: string }

export async function createSource(ctx: Ctx, input: CreateInput): Promise<SourceRow> {
  const id = crypto.randomUUID()
  const now = Date.now()
  const row: SourceRow = {
    id,
    name: input.name,
    kind: input.kind,
    urlEnc: input.kind === 'remote' ? await encrypt(ctx.runtime.key, input.url, urlAad(id)) : null,
    content: input.kind === 'local' ? input.content : null,
    userAgent: input.kind === 'remote' ? (input.userAgent ?? null) : null,
    ttlSec: input.kind === 'remote' ? (input.ttlSec ?? DEFAULT_TTL_SEC) : DEFAULT_TTL_SEC,
    lastFetchedAt: null,
    lastStatus: null,
    lastError: null,
    userinfoJson: null,
    createdAt: now,
    updatedAt: now,
  }
  await ctx.platform.db.insert(sources).values(row)
  // 本地订阅立即解析
  if (row.kind === 'local') await refreshSource(ctx, row)
  return (await getSource(ctx, id)) ?? row
}

export interface UpdateInput {
  name?: string
  url?: string
  content?: string
  userAgent?: string | null
  ttlSec?: number
}

export async function updateSource(
  ctx: Ctx,
  row: SourceRow,
  input: UpdateInput,
): Promise<SourceRow> {
  const patch: Partial<SourceRow> = { updatedAt: Date.now() }
  if (input.name !== undefined) patch.name = input.name
  if (input.url !== undefined)
    patch.urlEnc = await encrypt(ctx.runtime.key, input.url, urlAad(row.id))
  if (input.content !== undefined) patch.content = input.content
  if (input.userAgent !== undefined) patch.userAgent = input.userAgent
  if (input.ttlSec !== undefined) patch.ttlSec = input.ttlSec
  await ctx.platform.db.update(sources).set(patch).where(eq(sources.id, row.id))
  const updated = { ...row, ...patch }
  // 本地订阅的内容变化后重新解析
  if (row.kind === 'local' && input.content !== undefined) await refreshSource(ctx, updated)
  return (await getSource(ctx, row.id)) ?? updated
}

export async function deleteSource({ platform }: Ctx, id: string): Promise<void> {
  // fetch_logs 有 ON DELETE CASCADE；这里也显式删除，不依赖 foreign_keys 是否开启
  await platform.db.delete(fetchLogs).where(eq(fetchLogs.sourceId, id))
  await platform.db.delete(sources).where(eq(sources.id, id))
  await platform.blobs.delete(blobKeys.raw(id))
  await platform.blobs.delete(blobKeys.nodes(id))
}

export async function getCachedNodes({ platform }: Ctx, id: string): Promise<CachedNodes | null> {
  const text = await platform.blobs.get(blobKeys.nodes(id))
  return text === null ? null : (JSON.parse(text) as CachedNodes)
}

export async function listFetchLogs({ platform }: Ctx, id: string): Promise<FetchLogDto[]> {
  const rows = await platform.db
    .select()
    .from(fetchLogs)
    .where(eq(fetchLogs.sourceId, id))
    .orderBy(desc(fetchLogs.id))
    .limit(FETCH_LOG_LIMIT)
  return rows.map(({ at, status, bytes, durationMs, error }) => ({
    at,
    status,
    bytes,
    durationMs,
    error,
  }))
}

class RefreshError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * 拉取（远程）或重新解析（本地）订阅，成功时把解析结果写入 src:<id>:nodes。
 * 失败时保留上一次成功的缓存（raw、nodes、userinfo 都不动），只记录错误。
 */
export async function refreshSource(ctx: Ctx, row: SourceRow): Promise<RefreshResult> {
  const { platform } = ctx
  const startedAt = Date.now()
  let bytes: number | null = null
  try {
    let text: string
    let userinfo: Userinfo | null = null
    if (row.kind === 'local') {
      text = row.content ?? ''
    } else {
      let url: string | null
      try {
        url = await decryptUrl(ctx, row)
      } catch (e) {
        if (e instanceof DecryptError) throw new RefreshError('DECRYPT_FAILED', e.message)
        throw e
      }
      if (url === null) throw new RefreshError('DECRYPT_FAILED', 'URL is missing')
      try {
        const res = await fetchSubscription(url, {
          userAgent: row.userAgent ?? DEFAULT_USER_AGENT,
          allowPrivate: platform.env.allowPrivateFetch,
          resolveHost: platform.resolveHost?.bind(platform),
        })
        text = res.text
        userinfo = res.userinfo
      } catch (e) {
        if (e instanceof SsrfError) throw new RefreshError('SSRF_BLOCKED', e.message)
        throw new RefreshError('FETCH_FAILED', e instanceof Error ? e.message : String(e))
      }
    }
    bytes = new TextEncoder().encode(text).length

    const result = importSubscription(text)
    if (result.format === 'unknown') {
      throw new RefreshError('PARSE_FAILED', result.warnings[0]?.message ?? 'unknown format')
    }
    // 机场返回错误页或空列表时不覆盖缓存
    if (result.proxies.length === 0) throw new RefreshError('PARSE_FAILED', 'no proxies found')

    const cached: CachedNodes = {
      fetchedAt: startedAt,
      format: result.format,
      proxies: result.proxies,
      warnings: result.warnings,
    }
    await platform.blobs.put(blobKeys.nodes(row.id), JSON.stringify(cached))
    if (row.kind === 'remote') await platform.blobs.put(blobKeys.raw(row.id), text)

    await platform.db
      .update(sources)
      .set({
        lastFetchedAt: startedAt,
        lastStatus: 'ok',
        lastError: null,
        // 本地订阅没有 userinfo；远程订阅成功拉取但响应中没有该头时清空
        userinfoJson: userinfo ? JSON.stringify(userinfo) : null,
      })
      .where(eq(sources.id, row.id))
    await addLog(ctx, row.id, {
      at: startedAt,
      status: 'ok',
      bytes,
      durationMs: Date.now() - startedAt,
      error: null,
    })
    return { ok: true, nodeCount: result.proxies.length, warnings: result.warnings }
  } catch (e) {
    if (!(e instanceof RefreshError)) throw e
    await platform.db
      .update(sources)
      .set({ lastFetchedAt: startedAt, lastStatus: 'error', lastError: e.message })
      .where(eq(sources.id, row.id))
    await addLog(ctx, row.id, {
      at: startedAt,
      status: 'error',
      bytes,
      durationMs: Date.now() - startedAt,
      error: e.message,
    })
    // 日志脱敏：只记录 id 和错误（错误信息中不含 URL）
    console.warn(`[subloom] refresh source ${row.id} failed: ${e.code}: ${e.message}`)
    return { ok: false, code: e.code, message: e.message }
  }
}

async function addLog({ platform }: Ctx, sourceId: string, log: FetchLogDto): Promise<void> {
  await platform.db.insert(fetchLogs).values({ sourceId, ...log })
  const keep = platform.db
    .select({ id: fetchLogs.id })
    .from(fetchLogs)
    .where(eq(fetchLogs.sourceId, sourceId))
    .orderBy(desc(fetchLogs.id))
    .limit(FETCH_LOG_LIMIT)
  await platform.db
    .delete(fetchLogs)
    .where(and(eq(fetchLogs.sourceId, sourceId), notInArray(fetchLogs.id, keep)))
}
