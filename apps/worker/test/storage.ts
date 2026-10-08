import { reset } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// 测试用的 D1、KV。cloudflare:test 的存储按测试文件隔离（同一文件中的测试共享），
// 因此每个测试开始前 reset()，测试中按顺序取用下一对绑定，同一个测试可以有多份独立的存储。

const PAIRS = [
  [env.DB0, env.KV0],
  [env.DB1, env.KV1],
  [env.DB2, env.KV2],
  [env.DB3, env.KV3],
] as const

let next = 0

/** 清空全部绑定的数据（在 beforeEach 中调用） */
export async function resetStorage(): Promise<void> {
  await reset()
  next = 0
}

/** 取下一对尚未使用的 D1、KV */
export function nextBindings(): { d1: D1Database; kv: KVNamespace } {
  const pair = PAIRS[next++]
  if (!pair) throw new Error(`a test can use at most ${PAIRS.length} storages`)
  return { d1: pair[0], kv: pair[1] }
}
