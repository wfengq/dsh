// Test-only Cordis plugin: asks `ctx.tallyBalance` for the DeepSeek API-key balance as soon as it
// is applied and writes the snapshot to `$DSH_HOME/probe-balance.json`.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'tally-balance-probe'

export const inject = ['tallyBalance']

const ROUTE = 'deepseek-official'
const DEADLINE_MS = 15_000
const RETRY_MS = 100

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The balance plugin registers its fetcher once the `credentials` service exists, which can be
 * after this plugin was applied. Until then `refresh` answers `null` (no fetcher for the route),
 * so retry until a snapshot without an error arrives or the deadline passes.
 */
async function probe(ctx) {
  const deadline = Date.now() + DEADLINE_MS
  let snapshot = null
  while (Date.now() < deadline) {
    snapshot = await ctx.tallyBalance.refresh(ROUTE)
    if (snapshot && !snapshot.error) break
    await sleep(RETRY_MS)
  }
  writeFileSync(join(process.env.DSH_HOME, 'probe-balance.json'), JSON.stringify(snapshot))
}

export async function apply(ctx) {
  await probe(ctx)
}
