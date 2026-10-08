import type { BlobStore } from './platform.js'

/** 内存 BlobStore，用于测试 */
export function createMemoryBlobStore(): BlobStore {
  const map = new Map<string, { value: string; expiresAt: number | null }>()
  return {
    async get(key) {
      const entry = map.get(key)
      if (!entry) return null
      if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
        map.delete(key)
        return null
      }
      return entry.value
    },
    async put(key, value, opts) {
      const ttl = opts?.ttlSec
      map.set(key, { value, expiresAt: ttl === undefined ? null : Date.now() + ttl * 1000 })
    },
    async delete(key) {
      map.delete(key)
    },
  }
}
