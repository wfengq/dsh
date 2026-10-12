import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('ships no stale build output (every lib module comes from a current source file)', () => {
    const stale = files.filter(f => /^lib\/.*\.js$/.test(f) && f !== 'lib/client.js')
      .filter(f => !existsSync(`${root}packages/${dir}/src/${f.slice(4).replace(/\.js$/, '.ts')}`)
        && !existsSync(`${root}packages/${dir}/src/${f.slice(4).replace(/\.js$/, '.tsx')}`))
    expect(stale).toEqual([])
  })

  it('publishes real version ranges instead of workspace: links', () => {
    const out = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
    try {
      const packed = execFileSync('pnpm', ['pack', '--json', '--pack-destination', out], { cwd: `${root}packages/${dir}`, encoding: 'utf8' })
      const tarball = (JSON.parse(packed) as { filename: string }).filename
      const json = execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })
      expect(json).not.toContain('workspace:')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('carries release metadata', () => {
    expect(manifest.description).toEqual(expect.any(String))
    expect(manifest.keywords).toContain('dsh-plugin')
    expect(manifest.repository).toEqual({ type: 'git', url: 'git+https://github.com/wfengq/dsh.git', directory: `packages/${dir}` })
    expect(manifest.homepage).toBe(`https://github.com/wfengq/dsh/tree/main/packages/${dir}#readme`)
    expect(manifest.bugs).toBe('https://github.com/wfengq/dsh/issues')
    // A preview until dsh 0.2 is final: `npm publish` puts it under the beta tag, never latest.
    expect(manifest.publishConfig).toEqual({ access: 'public', tag: 'beta' })
    expect(manifest.version).toBe('0.1.0-beta.0')
  })
})

describe('dsh-tally-ui', () => {
  it('accepts the dsh-tally preview as its peer (a plain >=0.1.0 range excludes prereleases)', () => {
    const manifest = JSON.parse(readFileSync(`${root}packages/tally-ui/package.json`, 'utf8'))
    expect(manifest.peerDependencies['dsh-tally']).toBe('>=0.1.0-0 <0.2.0')
  })
})
