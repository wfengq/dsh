import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { loadCatalog } from 'dsh-pricing-data'
import { Config } from '../../src/index.js'
import { TallyPricing } from '../../src/pricing-service.js'
import { toUsage } from '../../src/query.js'
import { TallyStore, type StoredEntry } from '../../src/store.js'

/**
 * Smoke test against the real DeepSeek Harness: `dsh --profile headless` with the
 * official mock LLM server behind the shipped DeepSeek adapter, `dsh-tally` mounted
 * through `overlay.yml`. The overlay names the built entry by a path relative to the
 * overlay file: a bare `dsh-tally` only resolves from the dsh installation or the
 * profile's own `node_modules`, and the profile lives in the throwaway `DSH_HOME`.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const overlayPath = fileURLToPath(new URL('./overlay.yml', import.meta.url))
const balanceOverlayTemplate = fileURLToPath(new URL('./overlay-balance.yml', import.meta.url))
const tallyEntry = fileURLToPath(new URL('../../lib/index.js', import.meta.url))
const balanceEntry = fileURLToPath(new URL('../../../balance-deepseek/lib/index.js', import.meta.url))
const probeEntry = fileURLToPath(new URL('./fixtures/balance-probe.mjs', import.meta.url))
const API_KEY = 'mock-key'
const RUN_TIMEOUT = 120_000

/** The `dsh` bin of the installed CLI, run with this Node so no package-manager wrapper sits in between. */
const dshBin = (() => {
  const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { dsh: string } }
  return join(dirname(manifest), bin.dsh)
})()

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
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

/**
 * Run a command in its own process group. The group is killed on timeout and once the
 * direct child exited, so a lingering grandchild can neither outlive the test nor keep
 * stdio (and with it the result) open.
 */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      stderr += `\n[e2e: killed process group after ${RUN_TIMEOUT}ms]`
      killGroup(child)
    }, RUN_TIMEOUT)
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ code, signal, stdout, stderr })
    }
    child.on('error', (error) => {
      stderr += `\n[e2e: spawn failed: ${error.message}]`
      settle(null, null)
    })
    // Once the direct child exited, anything left in its group is a straggler holding stdio open.
    child.on('exit', () => killGroup(child))
    child.on('close', settle)
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

function describeRun(r: RunResult): string {
  return `exit ${r.code} signal ${r.signal}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`
}

describe('dsh-tally in the real dsh headless profile', () => {
  let home: string
  let server: MockLlmServer
  let env: NodeJS.ProcessEnv
  let dbPath: string

  beforeAll(async () => {
    const build = await run('pnpm', ['-F', 'dsh-tally', '-F', 'dsh-tally-balance-deepseek', 'build'], baseEnv())
    expect(build.code, describeRun(build)).toBe(0)
    home = mkdtempSync(join(tmpdir(), 'dsh-tally-e2e-'))
    dbPath = join(home, 'tally', 'tally.v1.sqlite')
    server = await startMockLlmServer({ port: 0, apiKey: API_KEY, sequence: ['success'], repeatLast: true })
    env = {
      ...baseEnv(),
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: server.baseURL + '/v1',
      DEEPSEEK_API_KEY: API_KEY,
    }
  })

  afterAll(async () => {
    for (const child of children) killGroup(child)
    children.clear()
    await server?.close()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  const headless = (task: string) =>
    run(process.execPath, [dshBin, '--profile', 'headless', '--patch', overlayPath, task], env)

  function readEntries(): StoredEntry[] {
    const store = TallyStore.open(dbPath)
    try {
      return store.entries({ from: 0, to: Date.now() + 1 }).sort((x, y) => x.at - y.at)
    } finally {
      store.close()
    }
  }

  let firstIds: Set<string>

  it('records the attempt of a headless turn with route, model and tokens', async () => {
    const result = await headless('say hi')
    expect(result.code, describeRun(result)).toBe(0)
    // Loading the plugin (and node:sqlite) must not print Node warnings into a dsh run.
    expect(result.stderr, describeRun(result)).not.toContain('ExperimentalWarning')
    expect(server.requests.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(dbPath), describeRun(result)).toBe(true)

    const entries = readEntries()
    expect(entries.length, describeRun(result)).toBeGreaterThanOrEqual(1)
    const [first] = entries
    expect(first!.route).toBe('deepseek-official')
    expect(first!.model).toBe('deepseek-flash')
    // The mock server reports a fixed `input_tokens: 3`.
    expect(first!.tokens.input).toBe(3)

    // Known usage must be priceable by the same catalog and route mapping the plugin uses.
    // The plugin's own schema defaults (`providerRoutes`, `overrides`), as the overlay mounts it without config.
    const defaults = Config({} as Config)
    const pricing = new TallyPricing(loadCatalog(), {
      providerRoutes: defaults.providerRoutes,
      overrides: defaults.overrides,
    })
    for (const e of entries) {
      if (e.usageKnown) expect(pricing.quoteRoute(e.route, e.model, toUsage(e.tokens), e.at), e.id).not.toBeNull()
    }
    firstIds = new Set(entries.map(e => e.id))
  })

  it('backfills the first session into a fresh ledger and records the second one live', async () => {
    expect(firstIds?.size, 'first run must have recorded entries').toBeGreaterThan(0)
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

    const result = await headless('say hi again')
    expect(result.code, describeRun(result)).toBe(0)
    expect(result.stderr, describeRun(result)).not.toContain('ExperimentalWarning')

    const ids = new Set(readEntries().map(e => e.id))
    for (const id of firstIds) expect(ids.has(id), `backfilled ${id}`).toBe(true)
    expect(ids.size).toBeGreaterThanOrEqual(firstIds.size + 1)
  })

  describe('balance through dsh-tally-balance-deepseek', () => {
    let stub: Server
    let stubURL: string
    const authorizations: Array<string | undefined> = []

    beforeAll(async () => {
      stub = createServer((req, res) => {
        authorizations.push(req.headers.authorization)
        if (req.url === '/user/balance') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            is_available: true,
            balance_infos: [{
              currency: 'CNY',
              total_balance: '110.00',
              granted_balance: '10.00',
              topped_up_balance: '100.00',
            }],
          }))
        } else {
          res.writeHead(404).end()
        }
      })
      await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve))
      const address = stub.address()
      if (address === null || typeof address === 'string') throw new Error('stub server has no port')
      stubURL = `http://127.0.0.1:${address.port}`
    })

    afterAll(async () => {
      stub?.closeAllConnections()
      await new Promise<void>(resolve => stub ? stub.close(() => resolve()) : resolve())
    })

    it('reads the API-key balance of a headless run through ctx.tallyBalance', async () => {
      // The generated copy lives in DSH_HOME, so the plugin entries are named by absolute path.
      const overlay = join(home, 'overlay-balance.yml')
      const text = readFileSync(balanceOverlayTemplate, 'utf8')
        .replaceAll('__TALLY_ENTRY__', tallyEntry)
        .replaceAll('__BALANCE_ENTRY__', balanceEntry)
        .replaceAll('__PROBE_ENTRY__', probeEntry)
        .replaceAll('__BASE_URL__', stubURL)
      writeFileSync(overlay, text)
      const probeFile = join(home, 'probe-balance.json')
      rmSync(probeFile, { force: true })

      const result = await run(process.execPath, [dshBin, '--profile', 'headless', '--patch', overlay, 'say hi'], env)
      expect(result.code, describeRun(result)).toBe(0)
      expect(result.stderr, describeRun(result)).not.toContain('ExperimentalWarning')
      expect(result.stderr, describeRun(result)).not.toContain('failed to import')

      expect(existsSync(probeFile), describeRun(result)).toBe(true)
      const snapshot = JSON.parse(readFileSync(probeFile, 'utf8')) as {
        provider: string
        stale: boolean
        error?: string
        wallets: Array<{ kind: string; money: { amount: string; currency: string } }>
      }
      expect(snapshot.provider).toBe('deepseek-official')
      expect(snapshot.stale, describeRun(result)).toBe(false)
      expect(snapshot.error).toBeUndefined()
      const amounts = Object.fromEntries(snapshot.wallets.map(w => [w.kind, w.money.amount]))
      expect(amounts).toEqual({ topup: '100', granted: '10', total: '110' })
      expect(snapshot.wallets.every(w => w.money.currency === 'CNY')).toBe(true)

      expect(authorizations.length).toBeGreaterThanOrEqual(1)
      expect(authorizations.every(a => a === 'Bearer ' + API_KEY), JSON.stringify(authorizations)).toBe(true)
    })
  })
})
