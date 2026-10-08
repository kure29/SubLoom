import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import {
  createTemplate,
  ExportOptionsSchema,
  exportMihomo,
  type ImportResult,
  importMihomoYaml,
  importSubscription,
  PipelineSchema,
  type Profile,
  ProfileSchema,
  ProxySchema,
  type RuleSet,
  runPipeline,
  TEMPLATE_IDS,
} from '../src/index.js'

/**
 * fixtures/export/<case>/input.json 描述一次完整的生成过程：
 * 节点来自 import 用例（subscription）或直接给出（nodes），经过流水线后，
 * 与 profile（直接给出、来自模板、或来自订阅中的配置）一起导出。
 */
const CaseSchema = z
  .strictObject({
    description: z.string(),
    /** fixtures/import 下的用例名 */
    subscription: z.string().optional(),
    nodes: z.array(ProxySchema).optional(),
    profile: ProfileSchema.optional(),
    template: z
      .strictObject({ id: z.enum(TEMPLATE_IDS), locale: z.enum(['zh-CN', 'en']) })
      .optional(),
    /** 用订阅中的策略组、规则等作为 profile */
    importConfig: z.literal(true).optional(),
    pipeline: PipelineSchema.optional(),
    options: ExportOptionsSchema.optional(),
  })
  .refine(
    (c) => [c.profile, c.template, c.importConfig].filter((x) => x !== undefined).length === 1,
    { message: 'exactly one of profile, template and importConfig is required' },
  )
  .refine((c) => !c.importConfig || c.subscription, {
    message: 'importConfig requires subscription',
  })
type Case = z.infer<typeof CaseSchema>

const inputs = import.meta.glob<string>('./fixtures/export/*/input.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const subscriptions = import.meta.glob<string>('./fixtures/import/*/input.*', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function subscription(name: string): ImportResult {
  const entry = Object.entries(subscriptions).find(([path]) => path.split('/').at(-2) === name)
  if (!entry) throw new Error(`import fixture not found: ${name}`)
  const r = importSubscription(entry[1])
  if (r.format === 'unknown') throw new Error(`import fixture is not importable: ${name}`)
  return r
}

function profileOf(c: Case, imported: ImportResult | undefined): Profile {
  if (c.profile) return c.profile
  if (c.template) return createTemplate(c.template.id, { locale: c.template.locale })
  const config = imported?.config
  if (!config) throw new Error('subscription has no config')
  return ProfileSchema.parse({ version: 1, name: 'imported', proxies: [], ...config })
}

function generate(c: Case) {
  const imported = c.subscription === undefined ? undefined : subscription(c.subscription)
  const nodes = [...(imported?.proxies ?? []), ...(c.nodes ?? [])]
  const pipeline = runPipeline(nodes, c.pipeline ?? [])
  const result = exportMihomo(profileOf(c, imported), pipeline.nodes, c.options)
  return { imported, nodes: pipeline.nodes, pipeline, result }
}

const cases = Object.entries(inputs)
  .map(([path, text]) => {
    const name = path.split('/').at(-2) ?? path
    return { name, input: CaseSchema.parse(JSON.parse(text)) }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

const outputs = new Map(cases.map((c) => [c.name, generate(c.input)]))

function output(name: string) {
  const o = outputs.get(name)
  if (!o) throw new Error(`fixture not found: ${name}`)
  return o
}

describe('golden: export fixtures', () => {
  it('finds the fixture cases', () => {
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'airport-full',
        'cleanup',
        'edge-common-en',
        'profile-features',
        'uri-common-zh',
        'uri-minimal-en',
        'variants',
      ]),
    )
  })

  it.each(cases)('$name matches expected.mihomo.yaml', async ({ name }) => {
    await expect(output(name).result.text).toMatchFileSnapshot(
      `./fixtures/export/${name}/expected.mihomo.yaml`,
    )
  })

  it.each(cases)('$name matches expected.warnings.json', async ({ name }) => {
    const { pipeline, result } = output(name)
    const warnings = { pipeline: pipeline.warnings, export: result.warnings }
    await expect(`${JSON.stringify(warnings, null, 2)}\n`).toMatchFileSnapshot(
      `./fixtures/export/${name}/expected.warnings.json`,
    )
  })

  it.each(cases)('$name re-imports without warnings', ({ name }) => {
    const { result } = output(name)
    const again = importMihomoYaml(result.text)
    expect(again.warnings).toEqual([])
    expect(again.proxies.length).toBe((parse(result.text) as { proxies: unknown[] }).proxies.length)
  })
})

function withoutPolicy(sets: RuleSet[] = []): RuleSet[] {
  return sets.map(({ extra, ...set }) => {
    const { proxy: _, ...mihomo } = extra?.mihomo ?? {}
    return Object.keys(mihomo).length ? { ...set, extra: { ...extra, mihomo } } : set
  })
}

describe('round trip of mihomo configs', () => {
  it.each(['airport-full', 'variants'])('%s re-imports to the same IR', (name) => {
    const { imported, result } = output(name)
    if (!imported?.config) throw new Error('config missing')
    const again = importMihomoYaml(result.text)
    expect(again.proxies).toEqual(imported.proxies)
    expect(again.config?.rules).toEqual(imported.config.rules)
    // 规则集的下载策略由导出选项决定，不参与往返比较
    expect(withoutPolicy(again.config?.ruleSets)).toEqual(withoutPolicy(imported.config.ruleSets))
    expect(again.config?.general).toEqual(imported.config.general)
    expect(again.config?.dns).toEqual(imported.config.dns)
  })
})

describe('acceptance: subscription → pipeline → template → mihomo', () => {
  it('drops the info nodes and keeps every real node of uri-mixed', () => {
    const { nodes, result } = output('uri-common-zh')
    expect(nodes.map((n) => n.name)).not.toContain('剩余流量：98.5 GB')
    expect(nodes).toHaveLength(11)
    const doc = parse(result.text) as { proxies: Array<{ name: string; udp: boolean }> }
    expect(doc.proxies.map((p) => p.name)).toEqual(nodes.map((n) => n.name))
    // URI 节点没有 udp 信息，按默认值开启
    expect(doc.proxies.every((p) => p.udp === true)).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('honours defaultUdp: false', () => {
    const doc = parse(output('uri-minimal-en').result.text) as { proxies: Array<{ udp: boolean }> }
    expect(doc.proxies.length).toBeGreaterThan(0)
    expect(doc.proxies.every((p) => p.udp === false)).toBe(true)
  })
})
