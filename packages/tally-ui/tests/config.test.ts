import { describe, expect, it } from 'vitest'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { Config } from '../src/index.js'

const ELEMENTS = ['composerDock', 'turnTail', 'headerUtilities', 'sidebarTab', 'budgetToast'] as const

describe('dsh-tally-ui Host config', () => {
  it('turns every UI element on by default, each as a volatile switch', () => {
    const config = Config({})
    for (const key of ELEMENTS) {
      const value = config.elements[key]
      expect(isVolatile(value), key).toBe(true)
      expect(value.get(), key).toBe(true)
    }
    expect(Object.keys(config.elements).sort()).toEqual([...ELEMENTS].sort())
  })

  it('declares each switch volatile in the schema, so the settings page can edit it live', () => {
    for (const key of ELEMENTS) expect(Config.dict!.elements!.dict![key]!.meta.volatile, key).toBe(true)
  })

  it('keeps an explicit off', () => {
    expect(Config({ elements: { turnTail: false } }).elements.turnTail.get()).toBe(false)
  })
})
