import { migrate, settings } from '@subloom/db'
import { eq } from 'drizzle-orm'
import { DecryptError, decrypt, deriveKey, encrypt, randomToken, sha256Hex } from './crypto.js'
import type { Platform } from './platform.js'

// 初始化：数据库迁移 → 管理令牌 → 加密密钥。见 PLAN.md 5.1、5.5。

export interface Runtime {
  /** 管理令牌的 SHA-256（十六进制） */
  adminTokenHash: string
  /** 由 SECRET_KEY 派生的 AES-GCM 密钥 */
  key: CryptoKey
  /**
   * 密钥来源：env 为 SECRET_KEY 环境变量；generated 为自动生成并存在数据库中
   * （与密文在同一个数据库里，数据库泄露时加密无效，前端据此提示用户设置 SECRET_KEY）
   */
  secretKeySource: 'env' | 'generated'
}

const KEY_ADMIN_TOKEN_HASH = 'admin_token_hash'
const KEY_SECRET = 'secret_key'
const KEY_SECRET_CHECK = 'secret_key_check'
const SECRET_CHECK_PLAINTEXT = 'subloom'

/** 初始化结果只取决于数据库和环境变量：按 (db, env) 两个对象缓存 */
const runtimes = new WeakMap<object, WeakMap<object, Promise<Runtime>>>()

/**
 * 幂等：同一份数据库（platform.db 对象）与环境变量（platform.env 对象）只执行一次，失败时下次重试。
 * Workers 每个请求构造新的 platform（waitUntil 不同），但复用 db 和 env，不会每个请求都重新初始化。
 * createApp 的中间件在每个请求前等待它。
 */
export function bootstrap(platform: Platform): Promise<Runtime> {
  let byEnv = runtimes.get(platform.db)
  if (!byEnv) {
    byEnv = new WeakMap()
    runtimes.set(platform.db, byEnv)
  }
  let p = byEnv.get(platform.env)
  if (!p) {
    p = init(platform)
    byEnv.set(platform.env, p)
    const cache = byEnv
    p.catch(() => cache.delete(platform.env))
  }
  return p
}

async function init(platform: Platform): Promise<Runtime> {
  await migrate(platform.db)
  const adminTokenHash = await ensureAdminToken(platform)
  const key = await ensureSecretKey(platform)
  return { adminTokenHash, key, secretKeySource: platform.env.secretKey ? 'env' : 'generated' }
}

async function getSetting(platform: Platform, key: string): Promise<string | undefined> {
  const rows = await platform.db.select().from(settings).where(eq(settings.key, key))
  return rows[0]?.value
}

/** 不存在时写入；返回最终存储的值和本次是否写入成功（并发初始化时只有一方成功） */
async function putSettingIfAbsent(
  platform: Platform,
  key: string,
  value: string,
): Promise<{ value: string; created: boolean }> {
  await platform.db.insert(settings).values({ key, value }).onConflictDoNothing()
  const stored = (await getSetting(platform, key)) ?? value
  return { value: stored, created: stored === value }
}

async function ensureAdminToken(platform: Platform): Promise<string> {
  if (platform.env.adminToken) return sha256Hex(platform.env.adminToken)
  const existing = await getSetting(platform, KEY_ADMIN_TOKEN_HASH)
  if (existing) return existing

  const token = randomToken()
  const { value, created } = await putSettingIfAbsent(
    platform,
    KEY_ADMIN_TOKEN_HASH,
    await sha256Hex(token),
  )
  if (created) {
    console.log(
      `[subloom] ADMIN_TOKEN is not set. Generated admin token (shown only once, save it now): ${token}`,
    )
  }
  return value
}

async function ensureSecretKey(platform: Platform): Promise<CryptoKey> {
  let secret = platform.env.secretKey
  if (!secret) {
    secret = await getSetting(platform, KEY_SECRET)
    if (!secret) {
      const generated = await putSettingIfAbsent(platform, KEY_SECRET, randomToken())
      secret = generated.value
      if (generated.created) {
        console.warn(
          '[subloom] SECRET_KEY is not set. Generated one and stored it in the database. ' +
            'Subscription URLs are encrypted with it, but anyone with the database can decrypt them; ' +
            'set the SECRET_KEY environment variable to protect them (data cannot be decrypted if it is lost).',
        )
      }
    }
  }
  const key = await deriveKey(secret)

  // 校验值：检测 SECRET_KEY 被更换（已加密的 URL 将无法解密）
  const check = await getSetting(platform, KEY_SECRET_CHECK)
  if (!check) {
    await putSettingIfAbsent(
      platform,
      KEY_SECRET_CHECK,
      await encrypt(key, SECRET_CHECK_PLAINTEXT, KEY_SECRET_CHECK),
    )
  } else {
    try {
      await decrypt(key, check, KEY_SECRET_CHECK)
    } catch (e) {
      if (!(e instanceof DecryptError)) throw e
      console.error(
        '[subloom] SECRET_KEY does not match the key that encrypted the existing data. ' +
          'Stored subscription URLs cannot be decrypted; restore the original SECRET_KEY or re-enter the URLs.',
      )
    }
  }
  return key
}
