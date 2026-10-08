import type { SubloomDb } from '@subloom/db'

/** 运行时差异全部收敛到这里。Node 与 Workers 入口各自实现，见 PLAN.md 5.1。 */
export interface Platform {
  /** 运行平台，/api/meta 返回给前端（如 Workers 上隐藏自定义脚本） */
  name: 'node' | 'workers'
  db: SubloomDb
  blobs: BlobStore
  env: PlatformEnv
  /** Node 下直接执行不等待；Workers 用 ctx.waitUntil */
  waitUntil(p: Promise<unknown>): void
  /** DNS 解析出的全部地址（仅 Node 实现），用于 SSRF 检查 */
  resolveHost?(host: string): Promise<string[]>
}

export interface PlatformEnv {
  adminToken?: string | undefined
  secretKey?: string | undefined
  corsOrigins: string[]
  allowPrivateFetch: boolean
}

export interface BlobStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { ttlSec?: number }): Promise<void>
  delete(key: string): Promise<void>
}
