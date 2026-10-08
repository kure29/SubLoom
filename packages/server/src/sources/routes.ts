import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { HttpError } from '../errors.js'
import {
  type Ctx,
  createSource,
  deleteSource,
  getCachedNodes,
  getSource,
  listFetchLogs,
  listSources,
  MIN_TTL_SEC,
  refreshSource,
  type SourceRow,
  toDto,
  updateSource,
} from './service.js'

/** 本地订阅内容的上限与远程订阅响应体相同 */
const MAX_CONTENT_CHARS = 10 * 1024 * 1024

const name = z.string().trim().min(1).max(100)
const url = z
  .string()
  .trim()
  .max(4096)
  .refine((s) => {
    try {
      const u = new URL(s)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an http or https URL')
const userAgent = z.string().trim().min(1).max(500).nullable()
const ttlSec = z
  .number()
  .int()
  .min(MIN_TTL_SEC)
  .max(30 * 86400)
const content = z.string().min(1).max(MAX_CONTENT_CHARS)

const createSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('remote'),
    name,
    url,
    userAgent: userAgent.optional(),
    ttlSec: ttlSec.optional(),
  }),
  z.strictObject({ kind: z.literal('local'), name, content }),
])

const updateSchema = z.strictObject({
  name: name.optional(),
  url: url.optional(),
  content: content.optional(),
  userAgent: userAgent.optional(),
  ttlSec: ttlSec.optional(),
})

async function parseBody<T>(req: { json(): Promise<unknown> }, schema: z.ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'request body must be JSON')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new HttpError(400, 'INVALID_REQUEST', z.prettifyError(parsed.error))
  return parsed.data
}

async function mustGet(ctx: Ctx, id: string): Promise<SourceRow> {
  const row = await getSource(ctx, id)
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'source not found')
  return row
}

export const sourceRoutes = new Hono<AppEnv>()
  .use(bodyLimit({ maxSize: MAX_CONTENT_CHARS * 4 + 64 * 1024 }))
  .get('/', async (c) => {
    const ctx = c.get('ctx')
    const rows = await listSources(ctx)
    return c.json({ sources: await Promise.all(rows.map((r) => toDto(ctx, r, false))) })
  })
  .post('/', async (c) => {
    const ctx = c.get('ctx')
    const input = await parseBody(c.req, createSchema)
    const row = await createSource(ctx, input)
    return c.json({ source: await toDto(ctx, row, true) }, 201)
  })
  .get('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    return c.json({ source: await toDto(ctx, row, true) })
  })
  .patch('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    const input = await parseBody(c.req, updateSchema)
    const allowed =
      row.kind === 'remote' ? ['name', 'url', 'userAgent', 'ttlSec'] : ['name', 'content']
    const invalid = Object.keys(input).filter((k) => !allowed.includes(k))
    if (invalid.length > 0) {
      throw new HttpError(
        400,
        'INVALID_REQUEST',
        `${row.kind} sources cannot set: ${invalid.join(', ')}`,
      )
    }
    const updated = await updateSource(ctx, row, input)
    return c.json({ source: await toDto(ctx, updated, true) })
  })
  .delete('/:id', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    await deleteSource(ctx, row.id)
    return c.body(null, 204)
  })
  .post('/:id/refresh', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    const result = await refreshSource(ctx, row)
    const source = await toDto(ctx, (await getSource(ctx, row.id)) ?? row, true)
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message }, source }, 502)
    }
    return c.json({ source, nodeCount: result.nodeCount, warnings: result.warnings })
  })
  .get('/:id/nodes', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    const nodes = await getCachedNodes(ctx, row.id)
    if (!nodes) throw new HttpError(404, 'NO_CACHE', 'source has not been fetched successfully yet')
    return c.json(nodes)
  })
  .get('/:id/logs', async (c) => {
    const ctx = c.get('ctx')
    const row = await mustGet(ctx, c.req.param('id'))
    return c.json({ logs: await listFetchLogs(ctx, row.id) })
  })
