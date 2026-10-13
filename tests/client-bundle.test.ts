import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('browser bundle privacy', () => {
  it('uses only CSS filenames in the stylesheet identifiers', () => {
    const bundle = readFileSync(join(root, 'packages/tally-ui/lib/client.js'), 'utf8')
    const tags = [...bundle.matchAll(/const tagId(?:\$\d+)? = "([^"]+)";/g)].map(m => m[1])
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toMatch(/^dsh-tally-ui\/[\w.-]+\.css$/)
  })

  for (const target of ['bundle', 'map']) {
    it.each(['native', 'forward', 'escaped'])('rejects a %s checkout path in the ' + target, (spelling) => {
      const fixture = mkdtempSync(join(tmpdir(), 'dsh-bundle-check-'))
      try {
        mkdirSync(join(fixture, 'scripts'))
        copyFileSync(join(root, 'scripts/check-client-bundle.mjs'), join(fixture, 'scripts/check-client-bundle.mjs'))
        const path = spelling === 'forward' ? fixture.replaceAll('\\', '/')
          : spelling === 'escaped' ? JSON.stringify(fixture).slice(1, -1) : fixture
        const bundle = join(fixture, 'client.js')
        writeFileSync(bundle, 'require("react");\n')
        writeFileSync(target === 'map' ? bundle + '.map' : bundle, '// ' + path)
        const checked = spawnSync(process.execPath, ['scripts/check-client-bundle.mjs', bundle], { cwd: fixture, encoding: 'utf8' })
        expect(checked.status, checked.stdout + checked.stderr).toBe(1)
        expect(checked.stderr).toContain('absolute checkout path')
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    })
  }

  it('accepts the built client bundle and source map', () => {
    const checked = spawnSync(process.execPath, ['scripts/check-client-bundle.mjs', 'packages/tally-ui/lib/client.js'], { cwd: root, encoding: 'utf8' })
    expect(checked.status, checked.stdout + checked.stderr).toBe(0)
  })
})
