import { beforeEach, describe, expect, it } from 'vitest'
import { createKvBlobStore } from '../src/blob-store.js'
import { nextBindings, resetStorage } from './storage.js'

beforeEach(resetStorage)

async function expirationOf(kv: KVNamespace, key: string): Promise<number | undefined> {
  const { keys } = await kv.list({ prefix: key })
  return keys.find((k) => k.name === key)?.expiration
}

describe('KV BlobStore', () => {
  it('读写与删除；不存在的 key 为 null', async () => {
    const { kv } = nextBindings()
    const blobs = createKvBlobStore(kv)
    expect(await blobs.get('src:a:nodes')).toBeNull()
    await blobs.put('src:a:nodes', '{"proxies":[]}')
    expect(await blobs.get('src:a:nodes')).toBe('{"proxies":[]}')
    await blobs.put('src:a:nodes', '中文 ✓')
    expect(await blobs.get('src:a:nodes')).toBe('中文 ✓')
    await blobs.delete('src:a:nodes')
    expect(await blobs.get('src:a:nodes')).toBeNull()
    // 删除不存在的 key 不报错
    await blobs.delete('missing')
  })

  it('TTL 写成 KV 的 expirationTtl；不到 60 秒的提高到 60 秒（KV 的下限）', async () => {
    const { kv } = nextBindings()
    const blobs = createKvBlobStore(kv)
    const now = Math.floor(Date.now() / 1000)
    await blobs.put('no-ttl', 'x')
    await blobs.put('short', 'x', { ttlSec: 5 })
    await blobs.put('long', 'x', { ttlSec: 3600 })
    expect(await expirationOf(kv, 'no-ttl')).toBeUndefined()
    expect(await expirationOf(kv, 'short')).toBeGreaterThanOrEqual(now + 60)
    expect(await expirationOf(kv, 'short')).toBeLessThanOrEqual(now + 62)
    expect(await expirationOf(kv, 'long')).toBeGreaterThanOrEqual(now + 3600)
    expect(await expirationOf(kv, 'long')).toBeLessThanOrEqual(now + 3602)
  })
})
