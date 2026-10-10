import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { loadCatalog } from 'dsh-pricing-data'
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
const API_KEY = 'mock-key'
const RUN_TIMEOUT = 120_000

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

const children = new Set<ChildProcess>()

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: repoRoot, env, timeout: RUN_TIMEOUT, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        children.delete(child)
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, signal: error?.signal ?? null, stdout, stderr })
      })
    children.add(child)
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
    const build = await run('pnpm', ['-F', 'dsh-tally', 'build'], baseEnv())
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
    for (const child of children) child.kill('SIGKILL')
    children.clear()
    await server?.close()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  const headless = (task: string) =>
    run('pnpm', ['exec', 'dsh', '--profile', 'headless', '--patch', overlayPath, task], env)

  function readEntries(): StoredEntry[] {
    const store = TallyStore.open(dbPath)
    try {
      return store.entries({ from: 0, to: Date.now() + 1 })
    } finally {
      store.close()
    }
  }

  let firstIds: Set<string>

  it('records the attempt of a headless turn with route, model and tokens', async () => {
    const result = await headless('say hi')
    expect(result.code, describeRun(result)).toBe(0)
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
    const pricing = new TallyPricing(loadCatalog(), {
      providerRoutes: { 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' },
      overrides: [],
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

    const ids = new Set(readEntries().map(e => e.id))
    for (const id of firstIds) expect(ids.has(id), `backfilled ${id}`).toBe(true)
    expect(ids.size).toBeGreaterThanOrEqual(firstIds.size + 1)
  })
})
