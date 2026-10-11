import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { TallyStatusView } from 'dsh-tally-api'
import * as tally from '../src/index.js'
import { schemas, TALLY_REMOTE } from '../src/remote/contract.js'

/** Minimal stand-in for the official `sessionQuery` service: no sessions on disk. */
class EmptySessionQuery extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionQuery')
  }

  async listSessions() {
    return []
  }

  async readSession(id: string): Promise<never> {
    throw new Error('not found: ' + id)
  }
}

let dir: string
let ctx: Context
let fiber: { dispose(): Promise<void> }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tally-remote-'))
  ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin(EmptySessionQuery)
  const loading = ctx.plugin(tally, { dbPath: join(dir, 'tally.v1.sqlite'), budgetPath: join(dir, 'budgets.json') })
  fiber = loading
  await loading
  // Sub-services start once their injections are available, after the plugin itself resolved.
  await new Promise<void>(resolve => ctx.inject(['tallyRemote'], () => resolve()))
  ctx.tallyBalance.register('r1', async () => [])
})

afterEach(async () => {
  await fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('tally Remote namespace', () => {
  it('answers tally/status through the Gateway', async () => {
    const result = await ctx.typertGateway.invoke({ namespace: 'tally', method: 'status', args: {} }) as TallyStatusView
    expect(result.balanceRoutes).toEqual(['r1'])
    expect(result.catalogVersion).toBe(ctx.tallyPricing.catalogVersion())
    expect(result.pricingErrors).toEqual([])
    expect(result.budgetErrors).toEqual([])
    expect(() => schemas.status.result.parse(result)).not.toThrow()
  })

  it('describes status for the browser', () => {
    expect(TALLY_REMOTE.descriptors.map(d => d.method)).toContain('status')
  })
})
