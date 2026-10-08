// 加密与令牌工具，只用 Web Crypto（Node 与 Workers 通用）。见 PLAN.md 5.5。

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const VERSION = 'v1'
const IV_BYTES = 12
const HKDF_SALT = encoder.encode('subloom')
const HKDF_INFO = encoder.encode('subloom/source-url/v1')

export class DecryptError extends Error {
  constructor(message = 'cannot decrypt (wrong SECRET_KEY or tampered data)') {
    super(message)
    this.name = 'DecryptError'
  }
}

/** 由 SECRET_KEY 经 HKDF-SHA256 派生 AES-256-GCM 密钥 */
export async function deriveKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 加密为 `v1.<iv>.<密文+tag>`（base64url）。aad 为附加认证数据，解密时必须相同。 */
export async function encrypt(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  )
  return `${VERSION}.${toBase64url(iv)}.${toBase64url(new Uint8Array(ct))}`
}

/** 解密 encrypt 的结果。密钥错误、aad 不同、密文被篡改或格式不对时抛出 DecryptError。 */
export async function decrypt(key: CryptoKey, token: string, aad: string): Promise<string> {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION)
    throw new DecryptError('invalid ciphertext format')
  const iv = fromBase64url(parts[1] ?? '')
  const ct = fromBase64url(parts[2] ?? '')
  if (!iv || iv.length !== IV_BYTES || !ct) throw new DecryptError('invalid ciphertext format')
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
      key,
      ct,
    )
    return decoder.decode(plain)
  } catch {
    throw new DecryptError()
  }
}

/** 随机令牌：默认 32 字节，base64url 编码（无 padding） */
export function randomToken(bytes = 32): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 常量时间比较（长度不同时直接返回 false，长度本身不是秘密：比较的是定长哈希） */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
