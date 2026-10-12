import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditPlugin, classifyRedLine, collectPlugin, type AuditReport } from 'dsh-trust-check'

/**
 * Capability gate: audits the built `lib` of every package with dsh-trust-check (run after
 * `pnpm build`, which `pretest` does). The core packages must stay free of red lines;
 * `dsh-tally-balance-deepseek` is the only package allowed to read credentials and reach the
 * network, so `creds-network` is the one red line it may carry.
 */

const packageDir = (name: string) => fileURLToPath(new URL(`../packages/${name}/`, import.meta.url))

function collect(name: string) {
  const dir = packageDir(name)
  return collectPlugin(dir, 'file:' + dir)
}

function audit(name: string): AuditReport {
  return auditPlugin(collect(name))
}

describe('dsh-trust-check capability gate', () => {
  for (const name of ['pricing-data', 'tally-api', 'tally', 'tally-ui']) {
    it(`${name} has no red lines`, () => {
      const report = audit(name)
      expect(report.redLines, JSON.stringify(report.redLines)).toEqual([])
      // Reading credentials and reaching the network belong to the provider plugin only.
      expect(report.capabilities).not.toContain('credentials')
      expect(report.capabilities).not.toContain('network')
    })
  }

  it('tally-ui is audited together with its browser bundle', () => {
    // The browser half must not reach the network either: it only talks to the same-origin Remote API.
    expect(Object.keys(collect('tally-ui').sources)).toEqual(expect.arrayContaining(['lib/index.js', 'lib/client.js']))
  })

  it('balance-deepseek only has the creds-network red line', () => {
    const report = audit('balance-deepseek')
    const codes = new Set(report.redLines.map(classifyRedLine))
    expect([...codes], JSON.stringify(report.redLines)).toEqual(['creds-network'])
  })
})
