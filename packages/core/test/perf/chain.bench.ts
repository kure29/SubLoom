import { bench, describe } from 'vitest'
import { createTemplate, exporters, importSubscription, runPipeline } from '../../src/index.js'
import { NODE_COUNT, PIPELINE, runChain, SUBSCRIPTION } from './chain.js'

const imported = importSubscription(SUBSCRIPTION)
const { nodes } = runPipeline(imported.proxies, PIPELINE)
const profile = createTemplate('common')

describe(`${NODE_COUNT} nodes`, () => {
  bench('import (mihomo YAML)', () => {
    importSubscription(SUBSCRIPTION)
  })

  bench('pipeline', () => {
    runPipeline(imported.proxies, PIPELINE)
  })

  for (const exporter of Object.values(exporters)) {
    bench(`export ${exporter.target}`, () => {
      exporter.export(profile, nodes)
    })

    bench(`full chain → ${exporter.target}`, () => {
      runChain(exporter)
    })
  }
})
