import { describe, expect, it } from 'vitest'
import { importSubscription } from '../../src/index.js'

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const TROJAN = 'trojan://pw@t.example.com:443#t'

describe('importSubscription format detection', () => {
  it.each(['', '  \r\n\t\n'])('reports empty input %j', (text) => {
    expect(importSubscription(text)).toEqual({
      format: 'unknown',
      proxies: [],
      warnings: [expect.objectContaining({ level: 'error', code: 'EMPTY_INPUT' })],
    })
  })

  it('detects mihomo YAML, including a UTF-8 BOM', () => {
    const r = importSubscription(
      '﻿# comment\nproxies:\n  - { name: a, type: ss, server: a.example.com, port: 1, cipher: c, password: p }\n',
    )
    expect(r.format).toBe('mihomo-yaml')
    expect(r.proxies).toHaveLength(1)
  })

  it('detects YAML that only has groups or rules at the top', () => {
    expect(importSubscription('rules:\n  - MATCH,DIRECT\n').format).toBe('mihomo-yaml')
  })

  it('detects a plain URI list and keeps 1-based line numbers', () => {
    const r = importSubscription(`${TROJAN}\n\nnot a link\n`)
    expect(r.format).toBe('uri-list')
    expect(r.proxies).toHaveLength(1)
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'INVALID_URI', line: 3 })])
  })

  it.each([
    ['standard', b64(`${TROJAN}\n`)],
    [
      'url-safe without padding',
      b64(`${TROJAN}\n`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    ],
    ['wrapped with CRLF', b64(`${TROJAN}\n`).replace(/(.{8})/g, '$1\r\n')],
  ])('detects %s base64', (_, text) => {
    const r = importSubscription(text)
    expect(r.format).toBe('base64-uri-list')
    expect(r.proxies.map((p) => p.name)).toEqual(['t'])
  })

  it.each([
    ['text that is neither YAML, URIs nor base64', 'hello world'],
    ['base64 of binary data', 'abcd'],
    ['base64 of text without links', b64('hello\nworld')],
  ])('reports %s as unknown', (_, text) => {
    expect(importSubscription(text)).toEqual({
      format: 'unknown',
      proxies: [],
      warnings: [expect.objectContaining({ level: 'error', code: 'UNKNOWN_FORMAT' })],
    })
  })
})
