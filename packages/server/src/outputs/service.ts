import { outputs } from '@subloom/db'
import { eq } from 'drizzle-orm'
import { randomToken } from '../crypto.js'
import type { PlatformEnv } from '../platform.js'
import type { Ctx } from '../sources/service.js'
import { publicLink } from '../urls.js'
import type { OutputOptions, OutputTarget } from '../validation.js'

// 输出链接的存储。见 PLAN.md 5.2、5.3。

export type OutputRow = typeof outputs.$inferSelect

export interface OutputDto {
  id: string
  profileId: string
  target: OutputTarget
  /** 访问凭据：/sub/<token> */
  token: string
  path: string
  /** 设置了 PUBLIC_URL 时的完整链接，否则为 null（由前端用后端地址拼接） */
  url: string | null
  options: OutputOptions
  lastAccessAt: number | null
  createdAt: number
}

/** 生成结果缓存的 target：各导出器的配置与节点列表 */
const CACHE_TARGETS = ['mihomo', 'surge', 'shadowrocket', 'loon', 'proxies'] as const

export const outputCacheKey = (id: string, target: string) => `out:${id}:${target}`

/** token 即访问凭据，日志中只出现前 4 个字符 */
export function maskToken(token: string): string {
  return token.length > 4 ? `${token.slice(0, 4)}…` : '…'
}

export function toDto(row: OutputRow, env: Pick<PlatformEnv, 'publicUrl'>): OutputDto {
  const path = `/sub/${row.token}`
  return {
    id: row.id,
    profileId: row.profileId,
    target: row.target as OutputTarget,
    token: row.token,
    path,
    url: publicLink(env, path),
    options: JSON.parse(row.optionsJson) as OutputOptions,
    lastAccessAt: row.lastAccessAt,
    createdAt: row.createdAt,
  }
}

export async function listOutputs({ platform }: Ctx, profileId?: string): Promise<OutputRow[]> {
  const query = platform.db.select().from(outputs)
  const filtered = profileId === undefined ? query : query.where(eq(outputs.profileId, profileId))
  return filtered.orderBy(outputs.createdAt, outputs.id)
}

export async function getOutput({ platform }: Ctx, id: string): Promise<OutputRow | undefined> {
  const rows = await platform.db.select().from(outputs).where(eq(outputs.id, id))
  return rows[0]
}

export async function getOutputByToken(
  { platform }: Ctx,
  token: string,
): Promise<OutputRow | undefined> {
  const rows = await platform.db.select().from(outputs).where(eq(outputs.token, token))
  return rows[0]
}

export async function createOutput(
  ctx: Ctx,
  input: { profileId: string; target: OutputTarget; options: OutputOptions },
): Promise<OutputRow> {
  const row: OutputRow = {
    id: crypto.randomUUID(),
    profileId: input.profileId,
    target: input.target,
    token: randomToken(),
    optionsJson: JSON.stringify(input.options),
    lastAccessAt: null,
    createdAt: Date.now(),
  }
  await ctx.platform.db.insert(outputs).values(row)
  return row
}

export async function updateOutput(
  ctx: Ctx,
  row: OutputRow,
  input: { target?: OutputTarget; options?: OutputOptions },
): Promise<OutputRow> {
  const patch: Partial<OutputRow> = {}
  if (input.target !== undefined) patch.target = input.target
  if (input.options !== undefined) patch.optionsJson = JSON.stringify(input.options)
  if (Object.keys(patch).length > 0) {
    await ctx.platform.db.update(outputs).set(patch).where(eq(outputs.id, row.id))
  }
  return { ...row, ...patch }
}

/** 生成新 token，旧链接立即失效 */
export async function rotateOutput(ctx: Ctx, row: OutputRow): Promise<OutputRow> {
  const token = randomToken()
  await ctx.platform.db.update(outputs).set({ token }).where(eq(outputs.id, row.id))
  await deleteOutputCache(ctx, row.id)
  return { ...row, token }
}

export async function deleteOutput(ctx: Ctx, id: string): Promise<void> {
  await ctx.platform.db.delete(outputs).where(eq(outputs.id, id))
  await deleteOutputCache(ctx, id)
}

export async function deleteOutputCache({ platform }: Ctx, id: string): Promise<void> {
  for (const target of CACHE_TARGETS) await platform.blobs.delete(outputCacheKey(id, target))
}

export async function touchOutput({ platform }: Ctx, id: string): Promise<void> {
  await platform.db.update(outputs).set({ lastAccessAt: Date.now() }).where(eq(outputs.id, id))
}
