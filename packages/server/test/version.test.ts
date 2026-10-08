import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { VERSION } from '../src/version.js'

describe('VERSION', () => {
  it('与 package.json 一致', () => {
    expect(VERSION).toBe(pkg.version)
  })
})
