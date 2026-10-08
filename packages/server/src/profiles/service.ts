import type { PipelineOp, Profile } from '@subloom/core'
import { outputs, profiles } from '@subloom/db'
import { eq } from 'drizzle-orm'
import { deleteOutputCache } from '../outputs/service.js'
import type { Ctx } from '../sources/service.js'

// profile 的存储。见 PLAN.md 5.2、5.3。

export type ProfileRow = typeof profiles.$inferSelect

export interface ProfileDto {
  id: string
  /** 即 ir.name */
  name: string
  ir: Profile
  pipeline: PipelineOp[]
  /** 有序 */
  sourceIds: string[]
  createdAt: number
  updatedAt: number
}

/** 列表中不返回 ir 和 pipeline */
export type ProfileSummaryDto = Omit<ProfileDto, 'ir' | 'pipeline'>

export interface ProfileInput {
  ir: Profile
  pipeline: PipelineOp[]
  sourceIds: string[]
}

export function toDto(row: ProfileRow): ProfileDto {
  return {
    id: row.id,
    name: row.name,
    ir: JSON.parse(row.irJson) as Profile,
    pipeline: JSON.parse(row.pipelineJson) as PipelineOp[],
    sourceIds: JSON.parse(row.sourceIdsJson) as string[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toSummaryDto(row: ProfileRow): ProfileSummaryDto {
  const { ir: _ir, pipeline: _pipeline, ...summary } = toDto(row)
  return summary
}

/** 解析已保存的 profile（写入前已校验） */
export function toInput(row: ProfileRow): ProfileInput {
  const { ir, pipeline, sourceIds } = toDto(row)
  return { ir, pipeline, sourceIds }
}

export async function listProfiles({ platform }: Ctx): Promise<ProfileRow[]> {
  return platform.db.select().from(profiles).orderBy(profiles.createdAt, profiles.id)
}

export async function getProfile({ platform }: Ctx, id: string): Promise<ProfileRow | undefined> {
  const rows = await platform.db.select().from(profiles).where(eq(profiles.id, id))
  return rows[0]
}

export function profileRow(
  id: string,
  input: ProfileInput,
  times: { createdAt: number; updatedAt: number },
): ProfileRow {
  return {
    id,
    name: input.ir.name,
    irJson: JSON.stringify(input.ir),
    pipelineJson: JSON.stringify(input.pipeline),
    sourceIdsJson: JSON.stringify(input.sourceIds),
    ...times,
  }
}

export async function createProfile(ctx: Ctx, input: ProfileInput): Promise<ProfileRow> {
  const now = Date.now()
  const row = profileRow(crypto.randomUUID(), input, { createdAt: now, updatedAt: now })
  await ctx.platform.db.insert(profiles).values(row)
  return row
}

export async function updateProfile(
  ctx: Ctx,
  row: ProfileRow,
  input: Partial<ProfileInput>,
): Promise<ProfileRow> {
  const merged = { ...toInput(row), ...input }
  const updated = profileRow(row.id, merged, { createdAt: row.createdAt, updatedAt: Date.now() })
  await ctx.platform.db.update(profiles).set(updated).where(eq(profiles.id, row.id))
  return updated
}

/** 同时删除它的输出及其生成结果缓存 */
export async function deleteProfile(ctx: Ctx, id: string): Promise<void> {
  const { db } = ctx.platform
  const rows = await db.select().from(outputs).where(eq(outputs.profileId, id))
  // outputs 有 ON DELETE CASCADE；这里也显式删除，不依赖 foreign_keys 是否开启
  await db.delete(outputs).where(eq(outputs.profileId, id))
  await db.delete(profiles).where(eq(profiles.id, id))
  for (const o of rows) await deleteOutputCache(ctx, o.id)
}
