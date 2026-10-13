import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exited, killTree, removeDir, spawnTree } from './support/process-tree.ts'

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('process-tree', () => {
  it('kills a child together with the grandchild it started, then removes the directory they used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tree-'))
    const pidFile = join(dir, 'grandchild.pid')
    // The child starts a grandchild that would outlive it, records its pid, and both keep running.
    const script = `
      const { spawn } = require('node:child_process')
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))
      setInterval(() => {}, 1000)
    `
    const child = spawnTree(process.execPath, ['-e', script], { cwd: dir, stdio: 'ignore' })
    await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(grandchild)).toBe(true)

    killTree(child)
    await exited(child)
    await expect.poll(() => alive(grandchild), { timeout: 10_000 }).toBe(false)

    writeFileSync(join(dir, 'left-behind.txt'), 'x')
    await removeDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('treats an already finished child as exited and killing it again as harmless', async () => {
    const child = spawnTree(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await exited(child)
    expect(() => killTree(child)).not.toThrow()
    await exited(child)
  })
})
