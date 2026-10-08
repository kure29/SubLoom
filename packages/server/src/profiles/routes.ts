import { exporters, PipelineSchema, ProfileSchema } from '@subloom/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { HttpError } from '../errors.js'
import { generate } from '../generate.js'
import { type Ctx, getSourcesByIds } from '../sources/service.js'
import type { ExportTarget } from '../sub/user-agent.js'
import {
  parseBody,
  parseOptionalBody,
  sourceIdsSchema,
  UserExportOptionsSchema,
} from '../validation.js'
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  type ProfileRow,
  toDto,
  toInput,
  toSummaryDto,
  updateProfile,
} from './service.js'

/** profile 中的手动节点、规则可能较多 */
const MAX_BODY = 5 * 1024 * 1024

const createSchema = z.strictObject({
  ir: ProfileSchema,
  pipeline: PipelineSchema.optional(),
  sourceIds: sourceIdsSchema.optional(),
})

const updateSchema = z.strictObject({
  ir: ProfileSchema.optional(),
  pipeline: PipelineSchema.optional(),
  sourceIds: sourceIdsSchema.optional(),
})

const previewSchema = updateSchema.extend({ options: UserExportOptionsSchema.optional() })

async function mustGet(ctx: Ctx, id: string): Promise<ProfileRow> {
  const row = await getProfile(ctx, id)
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'profile not found')
  return row
}

/** sourceIds 必须都是已存在的订阅源 */
async function checkSources(ctx: Ctx, ids: string[] | undefined): Promise<void> {
  if (!ids?.length) return
  const found = new Set((await getSourcesByIds(ctx, ids)).map((s) => s.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new HttpError(400, 'INVALID_REQUEST', `unknown source ids: ${missing.join(', ')}`)
  }
}

const isExportTarget = (value: string | undefined): value is ExportTarget =>
  value !== undefined && Object.hasOwn(exporters, value)

function previewTarget(value: string | undefined): ExportTarget {
  if (isExportTarget(value)) return value
  throw new HttpError(
    400,
    'INVALID_REQUEST',
    `target must be one of: ${Object.keys(exporters).join(', ')}`,
  )
}

export const profileRoutes = new Hono<AppEnv>()
  .use(bodyLimit({ maxSize: MAX_BODY }))
  .get('/', async (c) => {
    const rows = await listProfiles(c.get('ctx'))
    return c.json({ profiles: rows.map(toSummaryDto) })
  })
  .post('/', async (c) => {
    const ctx = c.get('ctx')
    const input = await parseBody(c.req, createSchema)
    await checkSources(ctx, input.sourceIds)
    const row = await createProfile(ctx, {
      ir: input.ir,
      pipeline: input.pipeline ?? [],
      sourceIds: input.sourceIds ?? [],
    })
    return c.json({ profile: toDto(row) }, 201)
  })
  .get('/:id', async (c) => {
    const row = await mustGet(c.get('ctx'), c.req.param('id'))
    return c.json({ profile: toDto(row) })
  })
  .patch('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    const input = await parseBody(c.req, updateSchema)
    await checkSources(ctx, input.sourceIds)
    return c.json({ profile: toDto(await updateProfile(ctx, row, input)) })
  })
  .delete('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    await deleteProfile(ctx, row.id)
    return c.body(null, 204)
  })
  .post('/:id/preview', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    const target = previewTarget(c.req.query('target'))
    // 请求体中给出的项覆盖已保存的值（预览尚未保存的编辑）
    const { options, ...override } = await parseOptionalBody(c.req, previewSchema)
    await checkSources(ctx, override.sourceIds)
    const input = { ...toInput(row), ...override }
    return c.json(await generate(ctx, input, target, options))
  })
