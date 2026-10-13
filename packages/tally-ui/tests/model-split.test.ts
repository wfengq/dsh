import { schemas } from 'dsh-tally/remote'
import { describe, expect, it } from 'vitest'
import { modelSplitQuery } from '../src/client/model-split.ts'

describe('modelSplitQuery', () => {
  it('asks for the session split by model in a range the server accepts', () => {
    const now = Date.UTC(2026, 9, 13, 3, 0, 0)
    const query = modelSplitQuery('s1', now)
    expect(schemas.query.request.safeParse(query).success).toBe(true)
    expect(query).toMatchObject({ groupBy: 'model', filter: { rootSessionId: 's1' } })
    expect(query.to).toBeGreaterThan(now)
  })
})
