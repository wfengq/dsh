import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

/**
 * Smoke test against the real DeepSeek Harness web profile: `dsh-tally` and `dsh-tally-ui` are
 * installed with `dsh plugin --profile web add <dir>` (the browser half only attaches to a
 * Loader row named by the bare package name), `dsh --profile web` serves the UI, and a real
 * Chromium checks that the browser bundle mounts the `tally` Remote namespace and renders the
 * session total in the session header and the cost dock below the composer.
 */

const tallyDir = fileURLToPath(new URL('../../../tally/', import.meta.url))
const tallyUiDir = fileURLToPath(new URL('../../', import.meta.url))
const API_KEY = 'mock-key'
const RUN_TIMEOUT = 120_000
const READY_TIMEOUT = 90_000

/** The `dsh` bin of the installed CLI, run with this Node so no package-manager wrapper sits in between. */
const dshBin = (() => {
  const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { dsh: string } }
  return join(dirname(manifest), bin.dsh)
})()

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

const children = new Set<ChildProcess>()

/** SIGKILL the child's whole process group, so grandchildren holding stdio open die with it. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH: the group is already gone.
  }
}

/** Spawn a command in its own process group, collecting its output. */
function start(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  const output = { stdout: '', stderr: '' }
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output.stdout += chunk })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { output.stderr += chunk })
  return { child, output }
}

/** Run a command to completion; its group is killed on timeout and once the direct child exited. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const { child, output } = start(command, args, env, cwd)
    const timer = setTimeout(() => {
      output.stderr += `\n[e2e: killed process group after ${RUN_TIMEOUT}ms]`
      killGroup(child)
    }, RUN_TIMEOUT)
    child.on('error', (error) => { output.stderr += `\n[e2e: spawn failed: ${error.message}]` })
    child.on('exit', () => killGroup(child))
    child.on('close', (code) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ code, ...output })
    })
  })
}

/** The inherited environment without proxies (the mock is on loopback) and without telemetry. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of Object.keys(env)) {
    if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key]
  }
  return env
}

function describeRun(r: { code?: number | null; stdout: string; stderr: string }): string {
  return `exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`
}

describe('dsh-tally-ui in the real dsh web profile', () => {
  let home: string
  let server: MockLlmServer
  let env: NodeJS.ProcessEnv
  let web: ReturnType<typeof start>
  let url: string
  let browser: Browser

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tally-ui-e2e-'))
    server = await startMockLlmServer({ port: 0, apiKey: API_KEY, sequence: ['success'], repeatLast: true })
    env = {
      ...baseEnv(),
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: server.baseURL + '/v1',
      DEEPSEEK_API_KEY: API_KEY,
    }

    for (const dir of [tallyDir, tallyUiDir]) {
      const add = await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', dir], env, home)
      expect(add.code, describeRun(add)).toBe(0)
    }

    // A new client bundle is only picked up at startup, so dsh starts after both installs.
    web = start(process.execPath, [dshBin, '--profile', 'web', '--no-open', '--port', '0'], env, home)
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dsh web not ready in ${READY_TIMEOUT}ms\n${describeRun(web.output)}`)), READY_TIMEOUT)
      const check = () => {
        const match = /dsh web: (http:\/\/[^\s]+)/.exec(web.output.stdout + web.output.stderr)
        if (match === null) return
        clearTimeout(timer)
        resolve(match[1]!)
      }
      web.child.stdout!.on('data', check)
      web.child.stderr!.on('data', check)
      web.child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`dsh web exited early (code ${code})\n${describeRun(web.output)}`))
      })
      check()
    })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    for (const child of children) killGroup(child)
    children.clear()
    await server?.close()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  /** Connect a fresh workspace directory through the picker of the blank session. */
  async function connectWorkspace(page: Page): Promise<void> {
    const workspace = join(home, 'workspace')
    mkdirSync(workspace, { recursive: true })
    await page.getByRole('textbox', { name: 'Choose workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
    await pathInput.fill(workspace)
    await pathInput.press('Enter')
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  }

  it('mounts the tally namespace and shows the session total and the cost dock in a new session', async () => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
    const consoleErrors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', (error) => { consoleErrors.push(error.message) })

    await page.goto(url)
    await page.getByRole('dialog', { name: 'Preview Notice' }).getByRole('button', { name: 'Continue' }).click()
    await connectWorkspace(page)
    // The blank session only becomes a session (with its header) once its first message is sent.
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await composer.click()
    await page.keyboard.type('say hi')
    await page.keyboard.press('Enter')

    await page.locator('[data-tally="total"]').waitFor({ timeout: 30_000 })
    await page.locator('[data-tally="dock"] [data-tally="today"]').waitFor({ timeout: 30_000 })

    expect(consoleErrors).toEqual([])
    expect(web.output.stderr, describeRun(web.output)).not.toContain('ExperimentalWarning')
    expect(web.output.stderr, describeRun(web.output)).not.toContain('failed to import')
  })
})
