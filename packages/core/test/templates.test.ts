import { describe, expect, it } from 'vitest'
import { createTemplate, ProfileSchema, TEMPLATE_IDS, type TemplateLocale } from '../src/index.js'

const LOCALES: TemplateLocale[] = ['zh-CN', 'en']
const BUILTINS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP'])

describe('templates', () => {
  it('provides the minimal and common templates', () => {
    expect(TEMPLATE_IDS).toEqual(['minimal', 'common'])
  })

  describe.each(TEMPLATE_IDS.flatMap((id) => LOCALES.map((locale) => ({ id, locale }))))(
    '$id ($locale)',
    ({ id, locale }) => {
      const profile = createTemplate(id, { locale })

      it('is a schema-valid profile without proxies', () => {
        expect(ProfileSchema.parse(profile)).toEqual(profile)
        expect(profile.proxies).toEqual([])
      })

      it('only references existing groups, rule sets and built-in targets', () => {
        const groups = new Set(profile.groups.map((g) => g.name))
        expect(groups.size).toBe(profile.groups.length)
        for (const g of profile.groups) {
          for (const m of g.members) {
            if (m.kind === 'group') expect(groups.has(m.name), m.name).toBe(true)
            expect(m.kind, `${g.name} must not reference proxies directly`).not.toBe('proxy')
          }
        }
        const sets = new Set(profile.ruleSets.map((s) => s.id))
        for (const r of profile.rules) {
          expect(groups.has(r.target) || BUILTINS.has(r.target), r.target).toBe(true)
          if (r.type === 'RULE-SET') expect(sets.has(r.value ?? ''), r.value).toBe(true)
        }
      })

      it('includes subscription nodes through includeAllProxies', () => {
        expect(profile.groups.some((g) => g.includeAllProxies)).toBe(true)
      })

      it('ends with a MATCH rule', () => {
        expect(profile.rules.at(-1)?.type).toBe('MATCH')
        expect(profile.rules.filter((r) => r.type === 'MATCH')).toHaveLength(1)
      })

      it('returns a fresh object every time', () => {
        const again = createTemplate(id, { locale })
        expect(again).toEqual(profile)
        expect(again).not.toBe(profile)
        again.groups.pop()
        expect(createTemplate(id, { locale })).toEqual(profile)
      })
    },
  )

  it('only differs between locales in names', () => {
    for (const id of TEMPLATE_IDS) {
      const zh = createTemplate(id, { locale: 'zh-CN' })
      const en = createTemplate(id, { locale: 'en' })
      expect(en.name).not.toBe(zh.name)
      expect(en.groups.map((g) => g.type)).toEqual(zh.groups.map((g) => g.type))
      expect(en.rules.map((r) => [r.type, r.value])).toEqual(zh.rules.map((r) => [r.type, r.value]))
      expect(en.ruleSets).toEqual(zh.ruleSets)
    }
  })

  it('defaults to zh-CN', () => {
    expect(createTemplate('minimal')).toEqual(createTemplate('minimal', { locale: 'zh-CN' }))
  })

  it('uses Chinese and English group names', () => {
    expect(createTemplate('minimal', { locale: 'zh-CN' }).groups.map((g) => g.name)).toEqual([
      '节点选择',
      '自动选择',
    ])
    expect(createTemplate('minimal', { locale: 'en' }).groups.map((g) => g.name)).toEqual([
      'Proxy',
      'Auto',
    ])
  })

  it('references blackmatrix7/ios_rule_script for every client in the common template', () => {
    const { ruleSets } = createTemplate('common')
    expect(ruleSets.length).toBeGreaterThan(0)
    const base = 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/'
    for (const rs of ruleSets) {
      expect(rs.behavior).toBe('classical')
      expect(rs.sources.mihomo?.url).toMatch(new RegExp(`^${base}Clash/\\w+/\\w+\\.yaml$`))
      expect(rs.sources.mihomo?.format).toBe('yaml')
      for (const target of ['surge', 'shadowrocket', 'loon'] as const) {
        const dir = { surge: 'Surge', shadowrocket: 'Shadowrocket', loon: 'Loon' }[target]
        expect(rs.sources[target]?.url).toMatch(new RegExp(`^${base}${dir}/\\w+/\\w+\\.list$`))
        expect(rs.sources[target]?.format).toBe('list')
      }
    }
  })
})
