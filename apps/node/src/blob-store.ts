import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from '@subloom/server'

/**
 * 文件 BlobStore：一个 key 一个文件，文件名为 key 的百分号编码（`.` 也编码，避免 `..`）。
 * 文件首行为过期时间（毫秒时间戳，0 表示不过期），其后为内容。先写临时文件再改名，保证原子性。
 */
export async function createFileBlobStore(dir: string): Promise<BlobStore> {
  await mkdir(dir, { recursive: true })
  const file = (key: string) => join(dir, encodeURIComponent(key).replace(/\./g, '%2E'))

  return {
    async get(key) {
      let text: string
      try {
        text = await readFile(file(key), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
      const newline = text.indexOf('\n')
      const expiresAt = Number(text.slice(0, newline))
      if (newline < 0 || !Number.isFinite(expiresAt)) return null
      if (expiresAt > 0 && Date.now() >= expiresAt) {
        await rm(file(key), { force: true })
        return null
      }
      return text.slice(newline + 1)
    },
    async put(key, value, opts) {
      const expiresAt = opts?.ttlSec === undefined ? 0 : Date.now() + opts.ttlSec * 1000
      const target = file(key)
      const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`
      await writeFile(tmp, `${expiresAt}\n${value}`, 'utf8')
      await rename(tmp, target)
    },
    async delete(key) {
      await rm(file(key), { force: true })
    },
  }
}
