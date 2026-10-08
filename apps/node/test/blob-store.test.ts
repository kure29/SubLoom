import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileBlobStore } from '../src/blob-store.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'subloom-blobs-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('createFileBlobStore', () => {
  it('get / put / delete，自动创建目录', async () => {
    const blobs = await createFileBlobStore(join(dir, 'nested', 'blobs'))
    expect(await blobs.get('src:a:nodes')).toBeNull()
    await blobs.put('src:a:nodes', '{"a":1}')
    await blobs.put('src:a:nodes', '{"a":2}')
    expect(await blobs.get('src:a:nodes')).toBe('{"a":2}')
    await blobs.delete('src:a:nodes')
    await blobs.delete('missing')
    expect(await blobs.get('src:a:nodes')).toBeNull()
  })

  it('内容原样保留（含换行、非 ASCII、首行像数字的内容）', async () => {
    const blobs = await createFileBlobStore(dir)
    for (const value of ['', '\n', '123\nabc\r\n', '🇭🇰 香港\n'.repeat(1000)]) {
      await blobs.put('k', value)
      expect(await blobs.get('k')).toBe(value)
    }
  })

  it('key 编码为安全的文件名，不会写出目录之外', async () => {
    const blobs = await createFileBlobStore(join(dir, 'blobs'))
    for (const key of ['..', '../escape', 'a/b', 'src:1:raw']) await blobs.put(key, key)
    for (const key of ['..', '../escape', 'a/b', 'src:1:raw'])
      expect(await blobs.get(key)).toBe(key)
    expect(await readdir(dir)).toEqual(['blobs'])
    expect((await readdir(join(dir, 'blobs'))).sort()).toEqual(
      ['%2E%2E', '%2E%2E%2Fescape', 'a%2Fb', 'src%3A1%3Araw'].sort(),
    )
  })

  it('ttlSec 过期后读不到，并删除文件', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const blobs = await createFileBlobStore(dir)
    await blobs.put('k', 'v', { ttlSec: 60 })
    vi.setSystemTime(1_000_000 + 59_999)
    expect(await blobs.get('k')).toBe('v')
    vi.setSystemTime(1_000_000 + 60_000)
    expect(await blobs.get('k')).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('不留下临时文件', async () => {
    const blobs = await createFileBlobStore(dir)
    await Promise.all(Array.from({ length: 20 }, (_, i) => blobs.put('k', String(i))))
    expect(await readdir(dir)).toEqual(['k'])
  })
})
