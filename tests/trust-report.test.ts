import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('README trust report', () => {
  it('is up to date with the current dsh-trust-check scan', () => {
    const r = spawnSync(process.execPath, ['scripts/trust-report.mjs', '--check'], { cwd: root, encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
  })

  it('shows creds-network only for the balance package', () => {
    const readme = readFileSync(`${root}README.md`, 'utf8')
    const table = readme.slice(readme.indexOf('<!-- trust-report:start -->'), readme.indexOf('<!-- trust-report:end -->'))
    const rows = table.split('\n').filter(l => l.startsWith('| `'))
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      const redLines = row.split('|')[3]!.trim()
      expect(redLines, row).toBe(row.includes('dsh-tally-balance-deepseek') ? 'creds-network' : '—')
    }
  })
})
