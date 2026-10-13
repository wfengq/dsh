import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

/**
 * End-to-end acceptance against the real DeepSeek Harness web profile. `dsh-tally`,
 * `dsh-tally-balance-deepseek` and `dsh-tally-ui` are installed with `dsh plugin --profile web add
 * <dir>` (the browser half only attaches to a Loader row named by the bare package name), a
 * `--patch` overlay points the balance plugin at a local stub, and `dsh --profile web` serves the
 * UI to a real Chromium on loopback (so settings writes go to the Host document). The cases run in
 * order on one page: conversation elements, balance, dashboard, settings (budget toast and the
 * `turnTail` switch), then a reload. Every step leaves a screenshot in `screenshots/`.
 */

const tallyDir = fileURLToPath(new URL('../../../tally/', import.meta.url))
const balanceDir = fileURLToPath(new URL('../../../balance-deepseek/', import.meta.url))
const tallyUiDir = fileURLToPath(new URL('../../', import.meta.url))
const screenshotDir = fileURLToPath(new URL('./screenshots/', import.meta.url))
const API_KEY = 'mock-key'
const RUN_TIMEOUT = 120_000
const READY_TIMEOUT = 90_000
/** Longest wait for something a finished turn causes (recording, watch frame, render). */
const TURN_TIMEOUT = 30_000

/**
 * The `dsh` bin of the installed CLI, run with this Node so no package-manager wrapper sits in between.
 * `DSH_E2E_BIN` points it at a separately installed dsh instead, to check the linked install path.
 */
const dshBin = process.env.DSH_E2E_BIN ?? (() => {
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

/** The DeepSeek balance endpoint as the stub answers it: 110 CNY, or the status the test sets. */
function balanceStub(state: { status: number; calls: number }): Server {
  return createServer((req, res) => {
    if (req.url !== '/user/balance') {
      res.writeHead(404).end()
      return
    }
    state.calls += 1
    if (state.status !== 200) {
      res.writeHead(state.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Authentication Fails', type: 'authentication_error' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
    }))
  })
}

describe('dsh-tally-ui in the real dsh web profile', () => {
  let home: string
  let server: MockLlmServer
  let stub: Server
  const stubState = { status: 200, calls: 0 }
  let env: NodeJS.ProcessEnv
  let web: ReturnType<typeof start>
  let url: string
  let browser: Browser
  let page: Page
  const consoleErrors: string[] = []

  beforeAll(async () => {
    rmSync(screenshotDir, { recursive: true, force: true })
    mkdirSync(screenshotDir, { recursive: true })
    home = mkdtempSync(join(tmpdir(), 'dsh-tally-ui-e2e-'))
    server = await startMockLlmServer({ port: 0, apiKey: API_KEY, sequence: ['success'], repeatLast: true })
    stub = balanceStub(stubState)
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve))
    const address = stub.address()
    if (address === null || typeof address === 'string') throw new Error('balance stub has no port')
    env = {
      ...baseEnv(),
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: server.baseURL + '/v1',
      DEEPSEEK_API_KEY: API_KEY,
    }

    for (const dir of [tallyDir, balanceDir, tallyUiDir]) {
      const add = await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', dir], env, home)
      expect(add.code, describeRun(add)).toBe(0)
    }
    // The overlay replaces the config of the installed balance row (bare name kept), pointing it at the stub.
    const overlay = join(home, 'overlay-balance.yml')
    writeFileSync(overlay, `- id: tally-balance-deepseek\n  config:\n    baseURL: http://127.0.0.1:${address.port}\n`)

    // A new client bundle is only picked up at startup, so dsh starts after all installs.
    web = start(process.execPath, [dshBin, '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], env, home)
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
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', acceptDownloads: true })
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', (error) => { consoleErrors.push(error.message) })
  })

  afterAll(async () => {
    await browser?.close()
    for (const child of children) killGroup(child)
    children.clear()
    await server?.close()
    stub?.closeAllConnections()
    await new Promise<void>(resolve => stub ? stub.close(() => resolve()) : resolve())
    if (home) rmSync(home, { recursive: true, force: true })
  })

  const shot = (name: string) => page.screenshot({ path: join(screenshotDir, `${name}.png`) })
  const tally = (name: string) => page.locator(`[data-tally="${name}"]`)
  const dockItem = (name: string) => tally('dock').locator(`[data-tally-item="${name}"]`)
  /** Clicks the cost pill so its details (session, budgets, balance) show, whole and inside the window. */
  async function openDock(): Promise<void> {
    if (await page.locator('.dsh-tally-dock-card').isVisible()) await page.keyboard.press('Escape')
    await tally('dock').locator('.dsh-tally-pill').click()
    const card = page.locator('.dsh-tally-dock-card')
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    const panel = await card.boundingBox()
    const viewport = page.viewportSize()!
    expect(panel).not.toBeNull()
    expect(panel!.x).toBeGreaterThanOrEqual(0)
    expect(panel!.y).toBeGreaterThanOrEqual(0)
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width)
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport.height)
  }
  /** Screenshots in the light and the dark theme. */
  async function themedShots(name: string): Promise<void> {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(300)
      await shot(`${name}-${scheme}`)
    }
    await page.emulateMedia({ colorScheme: 'light' })
  }
  const finishedTurns = () => page.locator('[data-turn-tail]').count()

  /** Connect a fresh workspace directory through the picker of the blank session. */
  async function connectWorkspace(): Promise<void> {
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

  /** Sends a message and waits until its turn has finished (one more turn tail, nothing streaming). */
  async function sendAndFinish(text: string): Promise<void> {
    const before = await finishedTurns()
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await composer.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await expect.poll(finishedTurns, { timeout: TURN_TIMEOUT }).toBeGreaterThan(before)
    await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: TURN_TIMEOUT }).toBe(0)
  }

  /** Opens the settings dialog on the tally section. */
  async function openTallySettings(): Promise<Locator> {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Usage and cost' }).click()
    await dialog.locator('[data-tally="settings"]').waitFor({ timeout: 10_000 })
    return dialog
  }

  async function closeSettings(): Promise<void> {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached', timeout: 10_000 })
  }

  /** The values of the cost dock and the session total that must survive a reconnect (the band countdown ticks, so it is left out). */
  async function dockValues(): Promise<Record<string, string>> {
    const read = async (name: string) => (await dockItem(name).count()) === 0 ? '<absent>' : await dockItem(name).innerText()
    const total = (await tally('total').count()) === 0 ? '<absent>' : await tally('total').innerText()
    // The budget item is left out: the previous case shrank the limit in the file behind the page's back,
    // which this window only rereads on its next hello (the reload).
    return { total, today: await read('today'), month: await read('month'), budget: (await dockItem('budget').count()) === 0 ? '<absent>' : 'present' }
  }

  it('shows a priced session cost, the turn cost with its hit rate and the session total after a mocked turn', async () => {
    await page.goto(url)
    await page.getByRole('dialog', { name: 'Preview Notice' }).getByRole('button', { name: 'Continue' }).click()
    await connectWorkspace()
    // The blank session only becomes a session (with its header) once its first message is sent.
    await sendAndFinish('say hi')

    await tally('turn').first().waitFor({ timeout: TURN_TIMEOUT })
    const session = tally('total').locator('.dsh-tally-num')
    // The mocked usage is priced (route deepseek-official, model deepseek-flash): neither unpriced nor zero.
    await expect.poll(() => session.innerText(), { timeout: TURN_TIMEOUT }).toMatch(/¥/)
    const cost = await session.innerText()
    expect(cost).not.toContain('Unpriced')
    expect(cost).not.toBe('¥0')
    // The dock reads today, then this month; the session cost lives in the header.
    await expect.poll(() => dockItem('today').innerText(), { timeout: TURN_TIMEOUT }).toMatch(/¥/)
    expect(await dockItem('month').innerText()).toMatch(/¥/)
    expect(await dockItem('session').count()).toBe(0)
    await shot('01-conversation')

    await tally('turn').first().click()
    const details = page.locator('.dsh-tally-turn-details')
    await details.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await details.innerText()).toMatch(/Hit rate\s+\d+%/)
    await shot('02-turn-details')
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden', timeout: 10_000 })

    // The turn cost looks like dsh's own turn usage button beside it.
    const look = (locator: ReturnType<typeof page.locator>) => locator.evaluate((node) => {
      const style = getComputedStyle(node)
      return { fontSize: style.fontSize, height: node.getBoundingClientRect().height, padding: style.padding, radius: style.borderTopLeftRadius, color: style.color }
    })
    const nativeUsage = page.locator('button[aria-haspopup="dialog"]').filter({ hasText: /^Usage / }).last()
    expect(await look(tally('turn').first())).toEqual(await look(nativeUsage))

    // The header total opens its details below it.
    await tally('total').click()
    const sessionDetails = page.getByRole('dialog', { name: 'Session total' })
    await sessionDetails.waitFor({ timeout: 10_000 })
    // The split by model really loads (the query stays inside the server's 400-day limit).
    await tally('model-row').first().waitFor({ timeout: 10_000 })
    expect(await sessionDetails.innerText()).not.toContain('Could not load')
    await shot('02b-session-details')
    await page.keyboard.press('Escape')
    await page.mouse.move(0, 0)
  })

  it('shows the stub balance in the dock details, and after a refused refresh keeps it marked as stale', async () => {
    await openDock()
    const balance = tally('balance')
    await expect.poll(() => balance.innerText(), { timeout: TURN_TIMEOUT }).toContain('¥110')
    expect(await balance.locator('.dsh-tally-balance-stale').count()).toBe(0)
    await shot('03-balance')

    stubState.status = 401
    const calls = stubState.calls
    await balance.click()
    await expect.poll(() => stubState.calls, { timeout: 10_000 }).toBeGreaterThan(calls)
    await balance.locator('.dsh-tally-balance-stale').waitFor({ timeout: 15_000 })
    expect(await balance.innerText()).toContain('¥110')
    await shot('04-balance-stale')
    await themedShots('dock')
    await page.keyboard.press('Escape')
    await page.mouse.move(0, 0)
  })

  it('makes the cost pill look and act like the native stat pills beside it', async () => {
    const pill = tally('dock').locator('.dsh-tally-pill')
    const native = page.locator('[data-composer-stats] button').first()
    await native.waitFor({ timeout: 10_000 })
    const look = (locator: typeof pill) => locator.evaluate((node) => {
      const style = getComputedStyle(node)
      return { fontSize: style.fontSize, height: node.getBoundingClientRect().height, padding: style.padding, radius: style.borderTopLeftRadius, color: style.color, cursor: style.cursor }
    })
    expect(await look(pill)).toEqual(await look(native))
    await native.hover()
    const nativeHover = await native.evaluate(node => getComputedStyle(node).backgroundColor)
    await pill.hover()
    await page.waitForTimeout(800)
    expect(await pill.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(nativeHover)
    // Hovering opens nothing; a click opens the details, a press elsewhere closes them.
    expect(await page.locator('.dsh-tally-dock-card').isVisible()).toBe(false)
    await pill.click()
    await page.locator('.dsh-tally-dock-card').waitFor({ state: 'visible', timeout: 10_000 })
    expect(await pill.getAttribute('aria-expanded')).toBe('true')
    await shot('dock-open')
    await page.mouse.click(5, 5)
    await page.locator('.dsh-tally-dock-card').waitFor({ state: 'hidden', timeout: 10_000 })
    await page.mouse.move(0, 0)
  })

  it('opens the usage dashboard from the right sidebar, draws the daily bars and exports a CSV', async () => {
    await page.locator('[data-sidebar-right-expand]').click()
    await page.locator('[data-sidebar-right-guide-entry="tally.dashboard"]').click()
    const chart = tally('daily-chart')
    await chart.waitFor({ timeout: 15_000 })
    await expect.poll(() => chart.locator('rect.dsh-tally-bar-peak, rect.dsh-tally-bar-offpeak').count()).toBeGreaterThan(0)
    expect(await tally('overview-today').innerText()).toMatch(/¥/)
    expect(await tally('rank-row').count()).toBeGreaterThan(0)
    await shot('05-dashboard')
    await themedShots('dashboard')

    const download = page.waitForEvent('download', { timeout: 15_000 })
    await tally('export').click()
    await page.getByRole('menuitem', { name: 'Export CSV' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^tally-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/)
    const csv = readFileSync(await file.path(), 'utf8').trim().split('\n')
    expect(csv[0]).toMatch(/^time,session,/)
    expect(csv.length).toBeGreaterThan(1)
  })

  it('raises a budget toast in the overlay once a tiny daily budget is exceeded', async () => {
    const dialog = await openTallySettings()
    const budgets = dialog.locator('[data-tally="budgets"]')
    await budgets.getByRole('button', { name: 'Add budget' }).click()
    const add = page.getByRole('dialog', { name: 'Add budget' })
    await add.getByRole('textbox', { name: 'Amount' }).fill('0.01')
    await add.getByRole('button', { name: 'Save' }).click()
    await add.waitFor({ state: 'detached', timeout: 10_000 })
    // Budgets are named by period and scope, never by their UUID.
    await budgets.getByText('Daily · All workspaces').waitFor({ timeout: 10_000 })
    await shot('06-settings-budget')
    await closeSettings()
    // The dock now carries the budget.
    await dockItem('budget').waitFor({ timeout: TURN_TIMEOUT })
    // The settings page only takes cents; mocked turns cost far less. Shrink the limit in the budget
    // file itself (the Host rereads it on change) so one more turn crosses it.
    const file = join(home, 'tally', 'budgets.json')
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(/"amount":\s*"0\.01"/)
    writeFileSync(file, text.replace(/("amount":\s*)"0\.01"/, '$1"0.000001"'))

    const toast = page.getByRole('alert').filter({ hasText: /Today's budget (\d+% used|exceeded)/ })
    const shown = toast.first().waitFor({ timeout: TURN_TIMEOUT })
    await sendAndFinish('say hi again')
    await shown
    await shot('07-budget-toast')
  })

  it('hides the turn cost on new turns once the turnTail switch is off', async () => {
    expect(await tally('turn').count()).toBeGreaterThan(0)
    const dialog = await openTallySettings()
    const toggle = dialog.locator('[data-tally="elements"]').getByRole('switch', { name: 'Cost of each turn' })
    expect(await toggle.isDisabled()).toBe(false)
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('false')
    expect(await dialog.locator('[data-tally="elements"] [role="alert"]').count()).toBe(0)
    await shot('08-settings-elements')
    await closeSettings()
    // Positive signal that the switch reached the conversation: the existing turn costs go away.
    await expect.poll(() => tally('turn').count(), { timeout: 10_000 }).toBe(0)

    await sendAndFinish('one more turn')
    // A turn cost renders once the turn's entries are recorded and announced, well within a second
    // of the turn's end when the switch is on (see the first case); give it a margin to show up.
    await page.waitForTimeout(3000)
    expect(await tally('turn').count()).toBe(0)
    await shot('09-turn-tail-off')
  })

  it('shows the same cost dock values after a page reload', async () => {
    // Let the last turn's frames settle: the values must read the same twice in a row.
    let before = await dockValues()
    await expect.poll(async () => {
      const next = await dockValues()
      const stable = JSON.stringify(next) === JSON.stringify(before)
      before = next
      return stable
    }, { timeout: TURN_TIMEOUT, intervals: [1000] }).toBe(true)
    expect(before.total).not.toBe('<absent>')
    expect(before.budget).not.toBe('<absent>')

    await page.reload()
    await dockItem('budget').waitFor({ timeout: TURN_TIMEOUT })
    await expect.poll(dockValues, { timeout: TURN_TIMEOUT }).toEqual(before)
    await shot('10-after-reload')
  })

  it('keeps the advanced settings collapsed and shows the price catalog once opened', async () => {
    const dialog = await openTallySettings()
    expect(await dialog.locator('[data-tally="catalog"]').count()).toBe(0)
    await dialog.getByRole('button', { name: 'Advanced' }).click()
    await dialog.locator('[data-tally="catalog-row"]').first().waitFor({ timeout: 10_000 })
    expect(await dialog.locator('[data-tally="catalog-row"]').first().innerText()).toContain('Effective')
    await themedShots('settings')
    await closeSettings()
  })

  it('drops the band, then the month, then the budget as the window narrows', async () => {
    const visible = async () => {
      const out: string[] = []
      for (const name of ['today', 'month', 'budget', 'band']) if (await dockItem(name).isVisible()) out.push(name)
      return out
    }
    const at = async (width: number) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.waitForTimeout(200)
      return visible()
    }
    // The items drop out by window width; an open right sidebar would narrow the column on top of that.
    const collapse = page.getByRole('button', { name: 'Collapse right sidebar' })
    if (await collapse.isVisible()) await collapse.click()
    expect(await at(1280)).toEqual(['today', 'month', 'budget', 'band'])
    expect(await at(1000)).toEqual(['today', 'month', 'budget'])
    expect(await at(800)).toEqual(['today', 'budget'])
    expect(await at(600)).toEqual(['today'])
    await page.setViewportSize({ width: 1600, height: 1000 })
  })

  it('keeps the dock details inside the window when the dock sits at its right edge, as in the desktop client', async () => {
    const collapse = page.getByRole('button', { name: 'Collapse right sidebar' })
    if (await collapse.isVisible()) await collapse.click()
    // The desktop client lays the dock out at the right end of the composer's bottom row; pin it there.
    const pin = await page.addStyleTag({ content: '[data-tally="dock"] { position: fixed; right: 8px; bottom: 8px; }' })
    for (const width of [1600, 800]) {
      await page.setViewportSize({ width, height: 900 })
      await openDock()
      await shot(`dock-details-right-edge-${width}`)
      await page.keyboard.press('Escape')
    }
    await page.mouse.move(0, 0)
    await pin.evaluate(node => { node.remove() })
    await page.setViewportSize({ width: 1600, height: 1000 })
  })

  it('logged no console errors and dsh printed no warnings or import failures', () => {
    expect(consoleErrors).toEqual([])
    expect(web.output.stderr, describeRun(web.output)).not.toContain('ExperimentalWarning')
    expect(web.output.stderr, describeRun(web.output)).not.toContain('failed to import')
  })
})
