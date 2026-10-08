import { describe, expect, it } from 'vitest'
import {
  DecryptError,
  decrypt,
  deriveKey,
  encrypt,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from '../src/crypto.js'

const URL_TEXT = 'https://sub.example.com/api/v1/client/subscribe?token=0123456789abcdef'

describe('encrypt / decrypt', () => {
  it('同一密钥加密后能解密回原文', async () => {
    const key = await deriveKey('correct horse battery staple')
    const token = await encrypt(key, URL_TEXT, 'source:a')
    expect(await decrypt(key, token, 'source:a')).toBe(URL_TEXT)
  })

  it('密文格式为 v1.<iv>.<密文>，不含明文，每次加密的结果不同', async () => {
    const key = await deriveKey('secret')
    const a = await encrypt(key, URL_TEXT, 'source:a')
    const b = await encrypt(key, URL_TEXT, 'source:a')
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
    expect(a).not.toContain('example.com')
    expect(a).not.toContain('token')
  })

  it('支持空字符串和非 ASCII 内容', async () => {
    const key = await deriveKey('secret')
    expect(await decrypt(key, await encrypt(key, '', 'x'), 'x')).toBe('')
    const text = 'https://例子.example.com/订阅?name=🇭🇰'
    expect(await decrypt(key, await encrypt(key, text, 'x'), 'x')).toBe(text)
  })

  it('密钥错误时解密失败', async () => {
    const token = await encrypt(await deriveKey('secret-a'), URL_TEXT, 'source:a')
    const wrong = await deriveKey('secret-b')
    await expect(decrypt(wrong, token, 'source:a')).rejects.toBeInstanceOf(DecryptError)
  })

  it('附加认证数据不同（密文挪到其他订阅）时解密失败', async () => {
    const key = await deriveKey('secret')
    const token = await encrypt(key, URL_TEXT, 'source:a')
    await expect(decrypt(key, token, 'source:b')).rejects.toBeInstanceOf(DecryptError)
  })

  it('密文被篡改时能检测出来', async () => {
    const key = await deriveKey('secret')
    const token = await encrypt(key, URL_TEXT, 'source:a')
    const [version, iv, body] = token.split('.') as [string, string, string]

    // 逐个翻转密文（含认证 tag）中每个字节的最低位
    const bytes = fromB64url(body)
    for (let i = 0; i < bytes.length; i++) {
      const tampered = bytes.slice()
      tampered[i] = (tampered[i] ?? 0) ^ 1
      await expect(
        decrypt(key, `${version}.${iv}.${toB64url(tampered)}`, 'source:a'),
      ).rejects.toBeInstanceOf(DecryptError)
    }

    // 篡改 IV
    const ivBytes = fromB64url(iv)
    ivBytes[0] = (ivBytes[0] ?? 0) ^ 1
    await expect(
      decrypt(key, `${version}.${toB64url(ivBytes)}.${body}`, 'source:a'),
    ).rejects.toBeInstanceOf(DecryptError)

    // 截断（去掉部分 tag）
    await expect(
      decrypt(key, `${version}.${iv}.${toB64url(bytes.slice(0, -1))}`, 'source:a'),
    ).rejects.toBeInstanceOf(DecryptError)
  })

  it('格式不对的密文报 DecryptError', async () => {
    const key = await deriveKey('secret')
    for (const bad of ['', 'v1', 'v1..', 'v2.AAAAAAAAAAAAAAAA.AAAA', 'v1.!!!.@@@', URL_TEXT]) {
      await expect(decrypt(key, bad, 'x')).rejects.toBeInstanceOf(DecryptError)
    }
  })
})

describe('randomToken', () => {
  it('默认 32 字节，base64url 无 padding', () => {
    const t = randomToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(t)
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
})

describe('sha256Hex / timingSafeEqual', () => {
  it('sha256Hex 为小写十六进制', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('timingSafeEqual 比较内容和长度', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

function toB64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
