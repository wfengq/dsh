import { describe, expect, it } from 'vitest'
import { resolveRoot } from '../src/root.js'

type H = Parameters<typeof resolveRoot>[0]

function table(...headers: H[]): (id: string) => H | undefined {
  const m = new Map(headers.map(h => [h.id, h]))
  return id => m.get(id)
}

describe('resolveRoot', () => {
  it('walks a subagent chain up to the root', () => {
    const lookup = table(
      { id: 'root' },
      { id: 'c1', origin: 'subagent', parentSession: 'root' },
      { id: 'c2', origin: 'subagent', parentSession: 'c1' },
    )
    expect(resolveRoot(lookup('c2')!, lookup)).toBe('root')
    expect(resolveRoot(lookup('c1')!, lookup)).toBe('root')
    expect(resolveRoot(lookup('root')!, lookup)).toBe('root')
  })

  it('treats a fork as its own root', () => {
    const lookup = table({ id: 'root' }, { id: 'f', parentSession: 'root' })
    expect(resolveRoot(lookup('f')!, lookup)).toBe('f')
  })

  it('stops at the last known id when a parent is missing', () => {
    const lookup = table(
      { id: 'c1', origin: 'subagent', parentSession: 'gone' },
      { id: 'c2', origin: 'subagent', parentSession: 'c1' },
    )
    expect(resolveRoot(lookup('c2')!, lookup)).toBe('c1')
  })

  it('stops at a fork encountered along a subagent chain', () => {
    const lookup = table(
      { id: 'f', parentSession: 'root' },
      { id: 'c1', origin: 'subagent', parentSession: 'f' },
    )
    expect(resolveRoot(lookup('c1')!, lookup)).toBe('f')
  })

  it('breaks cycles and returns the id before re-entering the loop', () => {
    const lookup = table(
      { id: 'a', origin: 'subagent', parentSession: 'b' },
      { id: 'b', origin: 'subagent', parentSession: 'a' },
    )
    expect(resolveRoot(lookup('a')!, lookup)).toBe('a')
  })
})
