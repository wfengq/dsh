import { describe, expect, it } from 'vitest'
import type { TallyStatusView } from 'dsh-tally-api'
import { groupProblems } from '../src/client/settings/problem-summary.ts'

const status = (patch: Partial<TallyStatusView> = {}, errors: TallyStatusView['usage']['errors'] = []): TallyStatusView => ({
  usage: { backfill: null, errors }, catalogVersion: 'v', pricingErrors: [], budgetErrors: [], balanceRoutes: [], routes: [], ...patch,
})

describe('groupProblems', () => {
  it('turns six session errors into one row with count 6', () => {
    const rows = groupProblems(status({}, Array.from({ length: 6 }, (_, i) => ({ sessionId: `s${i}`, message: 'm' }))))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'sessions', count: 6 })
    expect(rows[0]!.kind === 'sessions' && rows[0]!.items[5]).toEqual({ sessionId: 's5', message: 'm' })
  })

  it('keeps session and budget errors on separate rows, sessions first', () => {
    const rows = groupProblems(status({ budgetErrors: ['b'] }, [{ sessionId: 's', message: 'm' }, { message: 'ledger' }]))
    expect(rows.map(r => r.kind)).toEqual(['sessions', 'usage', 'budget'])
  })

  it('gives no rows without errors', () => {
    expect(groupProblems(status())).toEqual([])
  })
})
