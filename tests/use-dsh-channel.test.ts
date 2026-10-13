import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/use-dsh-channel.mjs', import.meta.url))
let root: string

function write(path: string, json: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-channel-'))
  write(join(root, 'package.json'), { devDependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2', vitest: '^3' } })
  write(join(root, 'packages/a/package.json'), {
    peerDependencies: { '@deepseek-ai/dsh-session': '>=0.2.0-0 <0.3.0-0 || >=0.2.1-0 <0.3.0-0', '@deepseek-ai/cordis': '>=4.0.4-0 <4.1.0-0 || >=4.0.5-0 <4.1.0-0' },
    devDependencies: { '@deepseek-ai/dsh-session': '0.2.0-rc.2', '@deepseek-ai/cordis': '4.0.4', 'dsh-tally-api': 'workspace:^' },
  })
  write(join(root, 'packages/b/package.json'), {
    devDependencies: {
      '@deepseek-ai/dsh-llm': '^0.2.0', '@deepseek-ai/cosmokit': '1.8.5', '@deepseek-ai/schemastery': '3.18.4',
      '@deepseek-ai/cordis-plugin-loader': '1.0.5', '@deepseek-ai/cordis-plugin-timer': '1.1.6',
    },
  })
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('use-dsh-channel', () => {
  it('pins dsh packages to the channel version and framework packages to what that dsh declares', () => {
    const r = spawnSync(process.execPath, [script, 'alpha', '--root', root,
      '--registry-version', '0.2.1-alpha.2',
      '--framework', '@deepseek-ai/cordis=~4.0.5-alpha.1', '--framework', '@deepseek-ai/schemastery=~3.18.5-alpha.1',
      '--framework', '@deepseek-ai/cosmokit=~1.8.6-alpha.1', '--framework', '@deepseek-ai/cordis-plugin-loader=~1.0.6-alpha.1',
    ], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('改动 6 个依赖')
    expect(read(join(root, 'package.json')).devDependencies).toEqual({ '@deepseek-ai/dsh': '0.2.1-alpha.2', vitest: '^3' })
    const a = read(join(root, 'packages/a/package.json'))
    expect(a.devDependencies).toEqual({ '@deepseek-ai/dsh-session': '0.2.1-alpha.2', '@deepseek-ai/cordis': '4.0.5-alpha.1', 'dsh-tally-api': 'workspace:^' })
    expect(a.peerDependencies).toEqual({ '@deepseek-ai/dsh-session': '>=0.2.0-0 <0.3.0-0 || >=0.2.1-0 <0.3.0-0', '@deepseek-ai/cordis': '>=4.0.4-0 <4.1.0-0 || >=4.0.5-0 <4.1.0-0' })
    expect(read(join(root, 'packages/b/package.json')).devDependencies).toEqual({
      '@deepseek-ai/dsh-llm': '^0.2.0', '@deepseek-ai/cosmokit': '1.8.6-alpha.1', '@deepseek-ai/schemastery': '3.18.5-alpha.1',
      '@deepseek-ai/cordis-plugin-loader': '1.0.6-alpha.1', '@deepseek-ai/cordis-plugin-timer': '1.1.6',
    })
    expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  })

  it('fails with usage when no channel is given', () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('用法')
  })
})

describe('use-dsh-channel guards', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' })

  it('refuses a framework range it cannot reduce to one version', () => {
    const r = run('alpha', '--registry-version', '0.2.1-alpha.2', '--framework', '@deepseek-ai/cordis=>=4.0.5 <4.1.0')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('@deepseek-ai/cordis')
  })

  it('refuses to run without a dsh version', () => {
    const r = run('alpha', '--registry-version', '', '--framework', '@deepseek-ai/cordis=~4.0.5')
    expect(r.status).toBe(2)
  })

  it('fails when the channel version is outside our peer ranges', () => {
    const r = run('next', '--registry-version', '0.3.0-alpha.1')
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('@deepseek-ai/dsh-session')
    expect(r.stderr).toContain('>=0.2.0-0 <0.3.0-0')
  })

  // npm only lets a prerelease satisfy a range whose comparator carries a prerelease tag on the same
  // major.minor.patch: `>=0.2.0-0 <0.3.0-0` looks wide but rejects 0.2.1-alpha.2.
  it('fails when an alpha on a newer patch is outside a range that has no prerelease branch for it', () => {
    write(join(root, 'packages/c/package.json'), { peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.2.0-0 <0.3.0-0' } })
    const r = run('alpha', '--registry-version', '0.2.1-alpha.2', '--framework', '@deepseek-ai/cordis=~4.0.5-alpha.1')
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('@deepseek-ai/dsh-llm >=0.2.0-0 <0.3.0-0')
    expect(r.stderr).not.toContain('dsh-session')
  })

  it('checks framework peer ranges against the framework version the channel pins', () => {
    write(join(root, 'packages/c/package.json'), { peerDependencies: { '@deepseek-ai/schemastery': '>=3.18.4-0 <3.19.0-0' } })
    const r = run('alpha', '--registry-version', '0.2.1-alpha.2',
      '--framework', '@deepseek-ai/cordis=~4.0.5-alpha.1', '--framework', '@deepseek-ai/schemastery=~3.18.5-alpha.1')
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('@deepseek-ai/schemastery >=3.18.4-0 <3.19.0-0')
    expect(r.stderr).toContain('3.18.5-alpha.1')
  })
})
