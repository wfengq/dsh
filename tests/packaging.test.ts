import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = {
  'pricing-data': ['lib/index.js', 'catalog.json'],
  'tally-api': ['lib/index.d.ts'],
  tally: ['lib/index.js', 'lib/cli.js', 'lib/remote/contract.js', 'cordis.patch.yml'],
  'tally-ui': ['lib/index.js', 'lib/client.js', 'cordis.patch.yml'],
  'balance-deepseek': ['lib/index.js', 'cordis.patch.yml'],
} as const

function packedFiles(dir: string): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: `${root}packages/${dir}`, encoding: 'utf8' })
  return (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(f => f.path)
}

describe.each(Object.entries(PACKAGES))('package %s', (dir, entries) => {
  const files = packedFiles(dir)
  const manifest = JSON.parse(readFileSync(`${root}packages/${dir}/package.json`, 'utf8'))

  it('ships its license, readme, manifest and entry points', () => {
    for (const f of ['LICENSE', 'README.md', 'package.json', ...entries]) expect(files, f).toContain(f)
  })

  it('ships no sources or tests', () => {
    expect(files.filter(f => f.startsWith('src/') || f.startsWith('tests/') || /\.test\./.test(f))).toEqual([])
  })

  it('carries release metadata', () => {
    expect(manifest.description).toEqual(expect.any(String))
    expect(manifest.keywords).toContain('dsh-plugin')
    expect(manifest.repository).toEqual({ type: 'git', url: 'git+https://github.com/wfengq/dsh.git', directory: `packages/${dir}` })
    expect(manifest.homepage).toBe(`https://github.com/wfengq/dsh/tree/main/packages/${dir}#readme`)
    expect(manifest.bugs).toBe('https://github.com/wfengq/dsh/issues')
    expect(manifest.publishConfig).toEqual({ access: 'public' })
    expect(manifest.version).toBe('0.1.0')
  })
})
