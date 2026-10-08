import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { HttpError } from '../errors.js'
import { getProfile } from '../profiles/service.js'
import type { Ctx } from '../sources/service.js'
import { idSchema, OutputOptionsSchema, OutputTargetSchema, parseBody } from '../validation.js'
import {
  createOutput,
  deleteOutput,
  getOutput,
  listOutputs,
  type OutputRow,
  rotateOutput,
  toDto,
  updateOutput,
} from './service.js'

const createSchema = z.strictObject({
  profileId: idSchema,
  target: OutputTargetSchema,
  options: OutputOptionsSchema.optional(),
})

const updateSchema = z.strictObject({
  target: OutputTargetSchema.optional(),
  options: OutputOptionsSchema.optional(),
})

async function mustGet(ctx: Ctx, id: string): Promise<OutputRow> {
  const row = await getOutput(ctx, id)
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'output not found')
  return row
}

export const outputRoutes = new Hono<AppEnv>()
  .use(bodyLimit({ maxSize: 64 * 1024 }))
  .get('/', async (c) => {
    const ctx = c.get('ctx')
    const rows = await listOutputs(ctx, c.req.query('profileId'))
    return c.json({ outputs: rows.map((r) => toDto(r, ctx.platform.env)) })
  })
  .post('/', async (c) => {
    const ctx = c.get('ctx')
    const input = await parseBody(c.req, createSchema)
    if (!(await getProfile(ctx, input.profileId))) {
      throw new HttpError(400, 'INVALID_REQUEST', 'profile not found')
    }
    const row = await createOutput(ctx, { ...input, options: input.options ?? {} })
    return c.json({ output: toDto(row, ctx.platform.env) }, 201)
  })
  .get('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    return c.json({ output: toDto(row, ctx.platform.env) })
  })
  .patch('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    const input = await parseBody(c.req, updateSchema)
    return c.json({ output: toDto(await updateOutput(ctx, row, input), ctx.platform.env) })
  })
  .delete('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    await deleteOutput(ctx, row.id)
    return c.body(null, 204)
  })
  .post('/:id/rotate', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    return c.json({ output: toDto(await rotateOutput(ctx, row), ctx.platform.env) })
  })
