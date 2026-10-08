// 测试中的绑定（见 vitest.config.ts）
declare namespace Cloudflare {
  interface Env {
    DB0: D1Database
    DB1: D1Database
    DB2: D1Database
    DB3: D1Database
    KV0: KVNamespace
    KV1: KVNamespace
    KV2: KVNamespace
    KV3: KVNamespace
  }
}
