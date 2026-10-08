import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, createApp, runScheduledRefresh } from '@subloom/server'
import { afterAll } from 'vitest'
import { describeApi } from '../../../packages/server/test/api/suite.js'
import { createFileBlobStore } from '../src/blob-store.js'
import { openDatabase, waitUntil } from '../src/platform.js'

// 在 Node（better-sqlite3 + 文件 BlobStore）下运行与运行时无关的 API 集成测试
const dirs: string[] = []
const closers: Array<() => void> = []

afterAll(async () => {
  for (const close of closers) close()
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

describeApi({ bootstrap, createApp, runScheduledRefresh }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subloom-api-'))
  dirs.push(dir)
  const { db, close } = openDatabase(':memory:')
  closers.push(close)
  return { name: 'node', db, blobs: await createFileBlobStore(join(dir, 'blobs')), waitUntil }
})
