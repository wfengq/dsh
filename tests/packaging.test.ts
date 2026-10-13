import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: `${root}packages/${dir}`, encoding: 'utf8' })
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

  it('ships no stale build output (every lib module and declaration comes from a current source file)', () => {
    // lib/types/ holds the browser half's declarations (tsconfig.client.json), mirroring src/ like lib/ does.
    const source = (f: string) => f.replace(/^lib\/(types\/)?/, '').replace(/\.(d\.ts|js)$/, '')
    const stale = files.filter(f => /^lib\/.*\.(js|d\.ts)$/.test(f) && f !== 'lib/client.js')
      .filter(f => !existsSync(`${root}packages/${dir}/src/${source(f)}.ts`) && !existsSync(`${root}packages/${dir}/src/${source(f)}.tsx`))
    expect(stale).toEqual([])
  })

  it('has no two source files whose names differ only in case (they would overwrite each other on Windows)', () => {
    const sources = readdirSync(`${root}packages/${dir}/src`, { recursive: true, encoding: 'utf8' })
      .map(f => f.replace(/\\/g, '/').replace(/\.tsx?$/, ''))
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const f of sources) {
      const key = f.toLowerCase()
      const other = seen.get(key)
      if (other !== undefined && other !== f) clashes.push(`${other} / ${f}`)
      seen.set(key, f)
    }
    expect(clashes).toEqual([])
  })

  it('publishes real version ranges instead of workspace: links', () => {
    const out = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
    try {
      const command = process.platform === 'win32'
        ? 'pnpm pack --json --pack-destination "%DSH_PACK_DEST%"'
        : 'pnpm pack --json --pack-destination "$DSH_PACK_DEST"'
      const packed = execSync(command, {
        cwd: `${root}packages/${dir}`, encoding: 'utf8', env: { ...process.env, DSH_PACK_DEST: out },
      })
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
    expect(manifest.version).toBe('0.1.0-beta.1')
  })
})

describe('dsh-tally-ui', () => {
  it('accepts the dsh-tally preview as its peer (a plain >=0.1.0 range excludes prereleases)', () => {
    const manifest = JSON.parse(readFileSync(`${root}packages/tally-ui/package.json`, 'utf8'))
    expect(manifest.peerDependencies['dsh-tally']).toBe('>=0.1.0-0 <0.2.0')
  })
})

describe('repository', () => {
  it('checks text files out with LF line endings on every platform, so Windows builds publish LF', () => {
    const attributes = existsSync(`${root}.gitattributes`) ? readFileSync(`${root}.gitattributes`, 'utf8') : ''
    expect(attributes).toMatch(/^\*\s+text=auto\s+eol=lf\s*$/m)
  })

  it('documents reconcile through npx, not through the plugin directory (its dsh peers are not there)', () => {
    for (const readme of ['README.md', 'packages/tally/README.md', 'docs/local-install.md']) {
      expect(readFileSync(`${root}${readme}`, 'utf8'), readme).not.toMatch(/node <dsh-tally 安装目录>\/lib\/cli\.js/)
    }
    expect(readFileSync(`${root}packages/tally/README.md`, 'utf8')).toContain('npx dsh-tally@beta reconcile')
  })
})
