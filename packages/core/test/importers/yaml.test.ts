import { describe, expect, it } from 'vitest'
import { parse, type Tags } from 'yaml'
import { parseYaml } from '../../src/importers/mihomo/yaml.js'
import { importMihomoYaml } from '../../src/index.js'

const INT = 'tag:yaml.org,2002:int'
const FLOAT = 'tag:yaml.org,2002:float'

/** 导入器原来的实现（yaml 库 + 自定义数字规则），作为对照 */
function customTags(tags: Tags): Tags {
  const out: Tags = []
  for (const t of tags) {
    if (typeof t !== 'object' || (t.tag !== INT && t.tag !== FLOAT)) {
      out.push(t)
      continue
    }
    if (t.format !== undefined || !('test' in t) || !t.test) continue
    if (t.tag === INT) {
      out.push({
        ...t,
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (s: string) => (Number.isSafeInteger(Number(s)) ? Number(s) : s),
      })
    } else if (!String(t.test).includes('inf')) {
      out.push({
        ...t,
        test: /^-?(?:0|[1-9][0-9]*)\.[0-9]*[1-9]$/,
        resolve: (s: string) => Number(s),
      })
    }
  }
  return out
}
const reference = (text: string): unknown =>
  parse(text, { merge: true, uniqueKeys: false, customTags })

const fixtures = import.meta.glob<string>('../fixtures/import/*/input.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const SCALARS = [
  '0',
  '-1',
  '+1',
  '01',
  '0777',
  '0o17',
  '0x1F',
  '0b101',
  '1_000',
  '12e4',
  '1.5',
  '1.50',
  '1.0',
  '.5',
  '-0.25',
  '.inf',
  '-.Inf',
  '.nan',
  '9007199254740991',
  '9007199254740993',
  '12345678901234567890',
  'true',
  'True',
  'TRUE',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'y',
  'null',
  'Null',
  '~',
  '',
  '"quoted 1"',
  "'single'",
  '!!str 123',
  '2001-12-14',
  '1:20',
  '🇭🇰 香港 01',
]

describe('parseYaml', () => {
  it.each(Object.keys(fixtures))('matches the previous parser on %s', (path) => {
    const text = fixtures[path] as string
    expect(parseYaml(text)).toEqual({ ok: true, value: reference(text) })
  })

  it.each(SCALARS)('reads the scalar %j like the previous parser', (s) => {
    const text = `a: ${s}\nb: [${s || '""'}]\n`
    expect(parseYaml(text)).toEqual({ ok: true, value: reference(text) })
  })

  it('reads anchors, aliases and merge keys like the previous parser', () => {
    const text = [
      'base: &base { udp: true, tfo: false, port: 1 }',
      'proxies:',
      '  - <<: *base',
      '    name: a',
      '    port: 2',
      '  - <<: [*base, { sni: x }]',
      '    name: b',
      'list: &l [1, 2]',
      'again: *l',
      '',
    ].join('\n')
    const value = reference(text)
    expect(parseYaml(text)).toEqual({ ok: true, value })
    expect((value as { proxies: unknown[] }).proxies[0]).toEqual({
      udp: true,
      tfo: false,
      port: 2,
      name: 'a',
    })
  })

  it('keeps the last of duplicate keys like the previous parser', () => {
    const text = 'a: 1\nb: 2\na: 3\n'
    expect(parseYaml(text)).toEqual({ ok: true, value: reference(text) })
    expect(parseYaml(text)).toEqual({ ok: true, value: { a: 3, b: 2 } })
  })

  it('reads block scalars and flow collections like the previous parser', () => {
    const text = 'a: |\n  line 1\n  line 2\nb: >-\n  folded\n  text\nc: {x: [1, "2", y]}\n'
    expect(parseYaml(text)).toEqual({ ok: true, value: reference(text) })
  })

  it('treats empty input as null', () => {
    expect(parseYaml('')).toEqual({ ok: true, value: null })
    expect(parseYaml('  \n')).toEqual({ ok: true, value: null })
    expect(parseYaml('# only a comment\n')).toEqual({ ok: true, value: null })
  })

  it('rejects multiple documents like the previous parser', () => {
    expect(() => reference('a: 1\n---\nb: 2\n')).toThrow()
    expect(parseYaml('a: 1\n---\nb: 2\n').ok).toBe(false)
  })

  it('reports the 1-based line of a syntax error without the source text', () => {
    const r = parseYaml('proxies:\n  - name: a\n  bad: [\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.line).toBeGreaterThanOrEqual(3)
    const imported = importMihomoYaml('proxies:\n  - name: "secret\n')
    expect(imported.warnings).toEqual([
      expect.objectContaining({ code: 'INVALID_YAML', message: expect.stringMatching(/line \d+/) }),
    ])
    expect(JSON.stringify(imported.warnings)).not.toContain('secret')
  })
})
