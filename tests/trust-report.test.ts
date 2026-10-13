import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('README trust report', () => {
  it('is up to date with the current dsh-trust-check scan', () => {
    const r = spawnSync(process.execPath, ['scripts/trust-report.mjs', '--check'], { cwd: root, encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
  })

  it.each(['\n', '\r\n'])('preserves %j line endings when regenerating the report', (newline) => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-trust-report-'))
    try {
      mkdirSync(join(fixture, 'scripts'))
      copyFileSync(join(root, 'scripts/trust-report.mjs'), join(fixture, 'scripts/trust-report.mjs'))
      symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'junction')
      symlinkSync(join(root, 'packages'), join(fixture, 'packages'), 'junction')
      const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r?\n/g, newline)
      writeFileSync(join(fixture, 'README.md'), readme)
      const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/trust-report.mjs', ...args], { cwd: fixture, encoding: 'utf8' })
      const generated = run()
      expect(generated.status, generated.stdout + generated.stderr).toBe(0)
      expect(readFileSync(join(fixture, 'README.md'), 'utf8')).toBe(readme)
      const checked = run('--check')
      expect(checked.status, checked.stdout + checked.stderr).toBe(0)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
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
