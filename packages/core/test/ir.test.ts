import { describe, expect, it } from 'vitest'
import {
  ProfileSchema,
  ProxyGroupSchema,
  ProxySchema,
  RuleSchema,
  RuleSetSchema,
} from '../src/index.js'

const TROJAN = {
  name: 't',
  type: 'trojan',
  server: 't.example.com',
  port: 443,
  password: 'p',
  tls: {},
}

describe('ProxySchema', () => {
  it('accepts a minimal trojan proxy', () => {
    expect(ProxySchema.parse(TROJAN)).toEqual(TROJAN)
  })

  it('rejects unknown keys (they belong in extra)', () => {
    expect(ProxySchema.safeParse({ ...TROJAN, foo: 1 }).success).toBe(false)
    expect(ProxySchema.safeParse({ ...TROJAN, tls: { foo: 1 } }).success).toBe(false)
  })

  it('only allows known extra namespaces', () => {
    expect(
      ProxySchema.safeParse({ ...TROJAN, extra: { mihomo: { a: 1 }, uri: { b: 2 } } }).success,
    ).toBe(true)
    expect(ProxySchema.safeParse({ ...TROJAN, extra: { a: 1 } }).success).toBe(false)
  })

  it.each([0, 65536, 1.5, -1])('rejects port %s', (port) => {
    expect(ProxySchema.safeParse({ ...TROJAN, port }).success).toBe(false)
  })

  it('requires TLS for protocols with built-in TLS', () => {
    const { tls: _tls, ...noTls } = TROJAN
    expect(ProxySchema.safeParse(noTls).success).toBe(false)
  })

  it('rejects unknown proxy types', () => {
    expect(ProxySchema.safeParse({ ...TROJAN, type: 'snell' }).success).toBe(false)
  })

  it.each([
    ['20000-30000', true],
    ['443,20000-30000', true],
    ['443', true],
    ['30000-20000', false],
    ['1-65536', false],
    ['443,', false],
    ['a-b', false],
  ])('validates hysteria2 ports %j', (ports, valid) => {
    const p = { name: 'h', type: 'hysteria2', server: 'h.example.com', port: 443, ports, tls: {} }
    expect(ProxySchema.safeParse(p).success).toBe(valid)
  })
})

describe('RuleSchema', () => {
  it('accepts nested logical rules', () => {
    const rule = {
      type: 'AND',
      children: [
        { type: 'DOMAIN', value: 'a.example.com' },
        { type: 'NOT', children: [{ type: 'DST-PORT', value: '80' }] },
      ],
      target: 'DIRECT',
    }
    expect(RuleSchema.parse(rule)).toEqual(rule)
  })

  it.each([
    ['MATCH with a value', { type: 'MATCH', value: 'x', target: 'DIRECT' }],
    ['DOMAIN without a value', { type: 'DOMAIN', target: 'DIRECT' }],
    ['AND without children', { type: 'AND', target: 'DIRECT' }],
    [
      'children on a non-logical rule',
      { type: 'DOMAIN', value: 'a', children: [], target: 'DIRECT' },
    ],
    [
      'NOT with two children',
      {
        type: 'NOT',
        children: [
          { type: 'DOMAIN', value: 'a' },
          { type: 'DOMAIN', value: 'b' },
        ],
        target: 'DIRECT',
      },
    ],
    [
      'a target on a sub-rule',
      {
        type: 'AND',
        children: [{ type: 'DOMAIN', value: 'a', target: 'DIRECT' }],
        target: 'DIRECT',
      },
    ],
    ['a missing target', { type: 'DOMAIN', value: 'a' }],
  ])('rejects %s', (_, rule) => {
    expect(RuleSchema.safeParse(rule).success).toBe(false)
  })
})

describe('other schemas', () => {
  it('validates group members', () => {
    const group = { name: 'g', type: 'select', members: [{ kind: 'builtin', name: 'DIRECT' }] }
    expect(ProxyGroupSchema.parse(group)).toEqual(group)
    expect(
      ProxyGroupSchema.safeParse({ ...group, members: [{ kind: 'builtin', name: 'PASS' }] })
        .success,
    ).toBe(false)
  })

  it('validates rule set sources', () => {
    const rs = {
      id: 'r',
      name: 'r',
      behavior: 'domain',
      sources: { mihomo: { url: 'https://r.example.com/a.yaml', format: 'yaml' } },
    }
    expect(RuleSetSchema.parse(rs)).toEqual(rs)
    expect(RuleSetSchema.safeParse({ ...rs, sources: { clash: rs.sources.mihomo } }).success).toBe(
      false,
    )
  })

  it('validates a profile', () => {
    const profile = {
      version: 1,
      name: 'p',
      proxies: [TROJAN],
      groups: [],
      rules: [],
      ruleSets: [],
    }
    expect(ProfileSchema.parse(profile)).toEqual(profile)
    expect(ProfileSchema.safeParse({ ...profile, version: 2 }).success).toBe(false)
  })
})
