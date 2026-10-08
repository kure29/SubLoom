import { describe, expect, it } from 'vitest'
import { Document, isScalar, parse, visit } from 'yaml'
import { stringifyYaml } from '../../src/exporters/mihomo/yaml.js'

const AMBIGUOUS_RE =
  /^(?:[-+]?[0-9][0-9_]*|[-+]?0[xX][0-9a-fA-F_]+|[-+]?0[oO][0-7_]+|[-+]?0[bB][01_]+|[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?[eE][-+]?[0-9]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~|<<|=)$/

/** 导出器原来的实现（yaml 库 + 给歧义字符串加引号），作为输出风格的参照 */
function reference(value: unknown): string {
  const doc = new Document(value)
  visit(doc, {
    Scalar(_, node) {
      if (isScalar(node) && typeof node.value === 'string' && AMBIGUOUS_RE.test(node.value)) {
        node.type = 'QUOTE_DOUBLE'
      }
    },
  })
  return doc.toString({ lineWidth: 0 })
}

const STRINGS = [
  '',
  ' ',
  'plain',
  'with space',
  'trailing ',
  ' leading',
  'a: b',
  'a:b',
  'ends with:',
  'a #b',
  'a#b',
  '#comment',
  '- dash',
  '-dash',
  '-',
  '?',
  '? q',
  ':colon',
  '*.lan',
  '&anchor',
  '!tag',
  '%percent',
  '@at',
  '`tick',
  '|pipe',
  '>gt',
  '[brackets]',
  'a[b]',
  '{braces}',
  'a,b',
  ',comma',
  "single ' quote",
  "'quoted'",
  'double " quote',
  '"quoted"',
  'both \' and "',
  'back\\slash',
  'line\nbreak',
  'tab\there',
  '\tlead tab',
  'ctrl\u0001char',
  'del\u007f',
  '---',
  '--- doc',
  '...',
  'a---',
  '🇭🇰 香港 01',
  '[Demo] 🇭🇰 香港 01',
  '剩余流量：98.5 GB',
  'https://example.com/a?b=c#d',
  '/path',
  'Host:example.com|X:y',
]

/** 数字、布尔值、null 的各种写法（YAML 1.2 core、go-yaml、YAML 1.1） */
const AMBIGUOUS = [
  '0',
  '-1',
  '+1',
  '01234567',
  '0777',
  '0o17',
  '0x1F',
  '0b101',
  '1_000',
  '12e4',
  '1.5',
  '.5',
  '1.',
  '-.inf',
  '.inf',
  '.NaN',
  '1:20',
  'true',
  'False',
  'yes',
  'No',
  'on',
  'OFF',
  'y',
  'N',
  'null',
  'Null',
  '~',
  '<<',
  '=',
]

describe('stringifyYaml', () => {
  it.each([...STRINGS, ...AMBIGUOUS])('round-trips %j as a value and as a key', (s) => {
    const doc = { [s]: s, list: [s] }
    const text = stringifyYaml(doc)
    expect(parse(text)).toEqual(doc)
    // go-yaml 按 YAML 1.1 规则读取时也必须是字符串
    expect(parse(text, { version: '1.1' })).toEqual(doc)
  })

  it.each(AMBIGUOUS)('quotes %j', (s) => {
    expect(stringifyYaml({ k: s })).toMatch(/^k: ["']/)
  })

  // 换行、控制字符、文档标记的写法与 yaml 库不同（更保守），单独测试
  const special = (s: string) =>
    /^(?:---|\.\.\.)/.test(s) || [...s].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f')
  it.each([...STRINGS, ...AMBIGUOUS].filter((s) => !special(s)))(
    'matches the previous implementation for %j',
    (s) => {
      expect(stringifyYaml({ k: s, l: [s] })).toBe(reference({ k: s, l: [s] }))
    },
  )

  it('writes multi-line strings and control characters double-quoted on one line', () => {
    expect(stringifyYaml({ k: 'a\nb' })).toBe('k: "a\\nb"\n')
    expect(stringifyYaml({ k: 'a\u0001' })).toBe('k: "a\\u0001"\n')
    expect(stringifyYaml({ k: 'a\u0085' })).toBe('k: "a\\u0085"\n')
    expect(stringifyYaml({ k: 'a\ud800b' })).toBe('k: "a\\ud800b"\n')
    expect(stringifyYaml({ k: 'a\tb', l: '🇭🇰' })).toBe('k: a\tb\nl: 🇭🇰\n')
  })

  it('quotes document markers', () => {
    expect(stringifyYaml({ k: '---', l: ['... x'] })).toBe('k: "---"\nl:\n  - "... x"\n')
  })

  it('writes numbers, booleans and null', () => {
    const doc = { int: 7890, neg: -1, float: 0.5, big: 1e21, t: true, f: false, n: null }
    expect(stringifyYaml(doc)).toBe(reference(doc))
    expect(stringifyYaml({ a: Number.POSITIVE_INFINITY, b: Number.NaN })).toBe('a: .inf\nb: .nan\n')
  })

  it('matches the yaml library for nested structures', () => {
    const doc = {
      empty: {},
      none: [],
      map: { a: 1, b: { c: [1, 2], d: [] } },
      proxies: [
        { name: 'a', 'ws-opts': { path: '/', headers: { Host: 'h' } } },
        { name: 'b', alpn: ['h2', 'http/1.1'] },
      ],
      nested: [[1, 2], [[3], { x: 1 }], [], {}],
      'rule-providers': { '123': { type: 'http' }, ads: { type: 'http' } },
      rules: ['MATCH,DIRECT'],
    }
    expect(stringifyYaml(doc)).toBe(reference(doc))
    expect(parse(stringifyYaml(doc))).toEqual(doc)
  })

  it('skips undefined values like the yaml library', () => {
    const doc = { a: undefined, b: 1, c: { d: undefined }, e: [undefined] }
    expect(stringifyYaml(doc)).toBe(reference(doc))
  })

  it('writes an empty document as an empty mapping', () => {
    expect(parse(stringifyYaml({}))).toEqual({})
  })
})
