/**
 * Child processes for the end-to-end tests, on every platform: dsh starts grandchildren (the web
 * server, plugin workers) that hold files in the test home open, so a test must end the whole tree
 * and wait for it before removing that home. POSIX does this with a process group; Windows has no
 * process groups for `kill`, so there the tree is ended with `taskkill /T`.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { rm } from 'node:fs/promises'

const WINDOWS = process.platform === 'win32'

/** Spawn a command whose whole process tree `killTree` can end: its own process group on POSIX. */
export function spawnTree(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, { ...options, detached: !WINDOWS, windowsHide: true })
}

/** End the child and every process it started; a tree that is already gone is not an error. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH: the group is already gone.
  }
}

/** Resolves once the child has exited (immediately if it already has, or never started). */
export function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve()
  return new Promise(resolve => child.once('exit', () => resolve()))
}

/**
 * Remove a directory tree. Windows releases a file handle a moment after its process exits, so a
 * busy directory (EBUSY, EPERM) is retried for a few seconds instead of failing the test run.
 */
export function removeDir(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
