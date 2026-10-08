import { describe, expect, it } from 'vitest'
import { maskToken } from '../src/outputs/service.js'

describe('maskToken', () => {
  it('只保留前 4 个字符', () => {
    const token = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f'
    expect(maskToken(token)).toBe('aB3d…')
    expect(maskToken(token)).not.toContain(token.slice(4, 8))
  })

  it('很短的 token 也不完整输出', () => {
    expect(maskToken('abc')).toBe('…')
    expect(maskToken('abcd')).toBe('…')
    expect(maskToken('abcde')).toBe('abcd…')
  })
})
