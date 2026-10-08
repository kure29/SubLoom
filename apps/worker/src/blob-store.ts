import type { BlobStore } from '@subloom/server'

/** KV 的 expirationTtl 下限（秒） */
const MIN_TTL_SEC = 60

/** KV BlobStore。更短的 TTL 提高到 60 秒（KV 的下限）。见 PLAN.md 5.6。 */
export function createKvBlobStore(kv: KVNamespace): BlobStore {
  return {
    get: (key) => kv.get(key),
    async put(key, value, opts) {
      const ttl = opts?.ttlSec
      await kv.put(
        key,
        value,
        ttl === undefined ? undefined : { expirationTtl: Math.max(MIN_TTL_SEC, Math.ceil(ttl)) },
      )
    },
    delete: (key) => kv.delete(key),
  }
}
