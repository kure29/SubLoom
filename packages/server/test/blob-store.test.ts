import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryBlobStore } from '../src/blob-store.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('createMemoryBlobStore', () => {
  it('get / put / delete', async () => {
    const blobs = createMemoryBlobStore()
    expect(await blobs.get('a')).toBeNull()
    await blobs.put('a', '1')
    await blobs.put('a', '2')
    expect(await blobs.get('a')).toBe('2')
    await blobs.delete('a')
    await blobs.delete('missing')
    expect(await blobs.get('a')).toBeNull()
  })

  it('ttlSec 过期后读不到', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const blobs = createMemoryBlobStore()
    await blobs.put('k', 'v', { ttlSec: 60 })
    vi.setSystemTime(1_000_000 + 59_999)
    expect(await blobs.get('k')).toBe('v')
    vi.setSystemTime(1_000_000 + 60_000)
    expect(await blobs.get('k')).toBeNull()
  })
})
