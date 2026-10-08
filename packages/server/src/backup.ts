import { PipelineSchema, ProfileSchema } from '@subloom/core'
import { fetchLogs, outputs, profiles, sources } from '@subloom/db'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppEnv } from './app.js'
import { decrypt, encrypt } from './crypto.js'
import { deleteOutputCache, listOutputs } from './outputs/service.js'
import { listProfiles, profileRow, toInput } from './profiles/service.js'
import {
  blobKeys,
  type Ctx,
  DEFAULT_TTL_SEC,
  listSources,
  refreshSource,
  type SourceRow,
  urlAad,
} from './sources/service.js'
import {
  contentSchema,
  idSchema,
  MAX_CONTENT_CHARS,
  nameSchema,
  OutputOptionsSchema,
  type OutputTarget,
  OutputTargetSchema,
  parseBody,
  timestampSchema,
  ttlSecSchema,
  urlSchema,
  userAgentSchema,
} from './validation.js'

// 备份与恢复。见 PLAN.md 5.3"备份与恢复"。

export const BACKUP_WARNING =
  'This backup contains your subscription URLs in plaintext (they often embed access tokens) ' +
  'and the output tokens that grant access to your configs. Keep it safe; ' +
  'never share it or upload it anywhere public.'

const SourceSchema = z
  .strictObject({
    id: idSchema,
    name: nameSchema,
    kind: z.enum(['remote', 'local']),
    /** 明文；无法解密时为 null */
    url: urlSchema.nullable(),
    content: contentSchema.nullable(),
    userAgent: userAgentSchema,
    ttlSec: ttlSecSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine(
    (s) =>
      s.kind === 'remote'
        ? s.content === null
        : s.content !== null && s.url === null && s.userAgent === null,
    'remote sources have no content; local sources have content and no url or userAgent',
  )

const BackupProfileSchema = z.strictObject({
  id: idSchema,
  ir: ProfileSchema,
  pipeline: PipelineSchema,
  sourceIds: z.array(idSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

const BackupOutputSchema = z.strictObject({
  id: idSchema,
  profileId: idSchema,
  target: OutputTargetSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  options: OutputOptionsSchema,
  createdAt: timestampSchema,
})

export const BackupSchema = z
  .strictObject({
    format: z.literal('subloom-backup'),
    version: z.literal(1),
    exportedAt: timestampSchema,
    warning: z.string().optional(),
    sources: z.array(SourceSchema),
    profiles: z.array(BackupProfileSchema),
    outputs: z.array(BackupOutputSchema),
  })
  .superRefine((b, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    const unique = (label: string, values: string[]) => {
      if (new Set(values).size !== values.length) issue(`duplicate ${label}`)
    }
    unique(
      'source ids',
      b.sources.map((s) => s.id),
    )
    unique(
      'profile ids',
      b.profiles.map((p) => p.id),
    )
    unique(
      'output ids',
      b.outputs.map((o) => o.id),
    )
    unique(
      'output tokens',
      b.outputs.map((o) => o.token),
    )
    const sourceIds = new Set(b.sources.map((s) => s.id))
    for (const p of b.profiles) {
      unique(`source ids in profile ${p.id}`, p.sourceIds)
      for (const id of p.sourceIds) {
        if (!sourceIds.has(id)) issue(`profile ${p.id} references unknown source ${id}`)
      }
    }
    const profileIds = new Set(b.profiles.map((p) => p.id))
    for (const o of b.outputs) {
      if (!profileIds.has(o.profileId)) {
        issue(`output ${o.id} references unknown profile ${o.profileId}`)
      }
    }
  })

export type Backup = z.infer<typeof BackupSchema>

export async function createBackup(ctx: Ctx): Promise<Backup> {
  const sourceRows = await listSources(ctx)
  return {
    format: 'subloom-backup',
    version: 1,
    exportedAt: Date.now(),
    warning: BACKUP_WARNING,
    sources: await Promise.all(
      sourceRows.map(async (s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        url:
          s.urlEnc === null
            ? null
            : await decrypt(ctx.runtime.key, s.urlEnc, urlAad(s.id)).catch(() => null),
        content: s.content,
        userAgent: s.userAgent,
        ttlSec: s.ttlSec,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    ),
    profiles: (await listProfiles(ctx)).map((p) => ({
      id: p.id,
      ...toInput(p),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    outputs: (await listOutputs(ctx)).map((o) => ({
      id: o.id,
      profileId: o.profileId,
      target: o.target as OutputTarget,
      token: o.token,
      options: JSON.parse(o.optionsJson) as Backup['outputs'][number]['options'],
      createdAt: o.createdAt,
    })),
  }
}

/**
 * 清空并替换全部数据（调用前已完整校验）。URL 用当前密钥重新加密；本地订阅立即解析，
 * 远程订阅需要重新拉取。D1 不支持交互式事务，中途出错时重新执行即可。
 */
export async function restoreBackup(ctx: Ctx, backup: Backup): Promise<void> {
  const { db, blobs } = ctx.platform
  const oldSources = await listSources(ctx)
  const oldOutputs = await listOutputs(ctx)

  await db.delete(outputs)
  await db.delete(profiles)
  await db.delete(fetchLogs)
  await db.delete(sources)
  for (const s of oldSources) {
    await blobs.delete(blobKeys.raw(s.id))
    await blobs.delete(blobKeys.nodes(s.id))
  }
  for (const o of oldOutputs) await deleteOutputCache(ctx, o.id)

  const locals: SourceRow[] = []
  for (const s of backup.sources) {
    const row: SourceRow = {
      id: s.id,
      name: s.name,
      kind: s.kind,
      urlEnc: s.url === null ? null : await encrypt(ctx.runtime.key, s.url, urlAad(s.id)),
      content: s.content,
      userAgent: s.userAgent,
      ttlSec: s.kind === 'remote' ? s.ttlSec : DEFAULT_TTL_SEC,
      lastFetchedAt: null,
      lastStatus: null,
      lastError: null,
      userinfoJson: null,
      nodesFetchedAt: null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }
    // 逐行写入：D1 每条语句的绑定参数个数有限
    await db.insert(sources).values(row)
    if (row.kind === 'local') locals.push(row)
  }
  for (const p of backup.profiles) {
    const { id, createdAt, updatedAt, ...input } = p
    await db.insert(profiles).values(profileRow(id, input, { createdAt, updatedAt }))
  }
  for (const o of backup.outputs) {
    await db.insert(outputs).values({
      id: o.id,
      profileId: o.profileId,
      target: o.target,
      token: o.token,
      optionsJson: JSON.stringify(o.options),
      lastAccessAt: null,
      createdAt: o.createdAt,
    })
  }
  for (const row of locals) await refreshSource(ctx, row)
}

const datePart = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')

export const backupRoutes = new Hono<AppEnv>()
  .get('/backup', async (c) => {
    const backup = await createBackup(c.get('ctx'))
    return c.json(backup, 200, {
      'content-disposition': `attachment; filename="subloom-backup-${datePart(backup.exportedAt)}.json"`,
      'cache-control': 'no-store',
    })
  })
  .post(
    '/restore',
    // 本地订阅的内容可能较大，与订阅源接口相同
    bodyLimit({ maxSize: MAX_CONTENT_CHARS * 4 + 64 * 1024 }),
    async (c) => {
      const backup = await parseBody(c.req, BackupSchema)
      await restoreBackup(c.get('ctx'), backup)
      return c.json({
        restored: {
          sources: backup.sources.length,
          profiles: backup.profiles.length,
          outputs: backup.outputs.length,
        },
      })
    },
  )
