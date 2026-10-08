import { type SubloomDb, schema } from '@subloom/db'
import { type Platform, parseEnv } from '@subloom/server'
import { drizzle } from 'drizzle-orm/d1'
import { createKvBlobStore } from './blob-store.js'

/** wrangler.jsonc 中的绑定，以及 vars、secrets（字符串，由 parseEnv 解析） */
export interface Env {
  DB: D1Database
  BLOBS: KVNamespace
  [name: string]: unknown
}

/** D1 的 Drizzle 实例 */
export function createDb(d1: D1Database): SubloomDb {
  return drizzle(d1, { schema }) as unknown as SubloomDb
}

/** 与请求无关的部分，按 env 对象缓存：同一个 isolate 中的请求复用 db 和 env，只初始化一次 */
const bases = new WeakMap<Env, Omit<Platform, 'waitUntil'>>()

/**
 * 每个请求（或定时任务）一个 platform：waitUntil 交给该请求的 ctx。
 * 环境变量不合法时抛出错误（不缓存，修正配置后的下一个请求重新解析）。
 */
export function createPlatform(env: Env, ctx: ExecutionContext): Platform {
  let base = bases.get(env)
  if (!base) {
    base = {
      name: 'workers',
      db: createDb(env.DB),
      blobs: createKvBlobStore(env.BLOBS),
      env: parseEnv(env),
    }
    bases.set(env, base)
  }
  return {
    ...base,
    waitUntil(p) {
      ctx.waitUntil(p.catch((e: unknown) => console.error('[subloom] background task failed:', e)))
    },
  }
}
