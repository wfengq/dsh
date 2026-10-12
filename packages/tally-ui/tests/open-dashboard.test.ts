import { describe, expect, it, vi } from 'vitest'
import { makeOpenDashboard } from '../src/client/open-dashboard.ts'

describe('openDashboard', () => {
  it('does nothing without the right sidebar or while the usage tab is switched off', () => {
    expect(() => makeOpenDashboard(() => undefined, () => true)()).not.toThrow()
    const openTab = vi.fn()
    makeOpenDashboard(() => ({ openTab }), () => false)('s1')
    expect(openTab).not.toHaveBeenCalled()
  })

  it('opens the usage tab, focused on a session when one is given', () => {
    const openTab = vi.fn()
    const open = makeOpenDashboard(() => ({ openTab }), () => true)
    open()
    expect(openTab).toHaveBeenLastCalledWith('tally.dashboard', undefined)
    open('s1')
    expect(openTab).toHaveBeenLastCalledWith('tally.dashboard', { params: { sessionId: 's1' } })
  })

  it('swallows a sidebar that refuses the kind', () => {
    const open = makeOpenDashboard(() => ({ openTab: () => { throw new Error('unknown kind') } }), () => true)
    expect(() => open()).not.toThrow()
  })
})
