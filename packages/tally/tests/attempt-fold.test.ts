import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { foldEvent, initialFoldState, type BilledAttempt, type FoldState } from '../src/attempt-fold.ts'
import { normalizeUsage } from '../src/normalize.ts'
import {
  attempt, ev, header, message, retry, retryStarted, seqd, stepEnd, stepStart, turnEnd, turnStart, U1, U2,
} from './fixtures/events.ts'

function foldAll(events: readonly SessionEvent[], state: FoldState = initialFoldState()) {
  const settled: BilledAttempt[] = []
  for (const event of events) {
    const result = foldEvent(state, event)
    state = result.state
    settled.push(...result.settled)
  }
  return { state, settled }
}

function run(events: readonly SessionEvent[]): BilledAttempt[] {
  return foldAll(events).settled
}

const singleStep = seqd([
  turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), message(1, 1, U1), stepEnd(1, 1),
  turnEnd(1),
])

const retried = seqd([
  turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), attempt(1, 1, U2), retry(1, 1),
  retryStarted(1, 1, 1), message(1, 1, U1), stepEnd(1, 1), turnEnd(1),
])

const twoSteps = seqd([
  turnStart(1), header('deepseek-official', 'deepseek-flash'),
  stepStart(1, 1), message(1, 1, U1), stepEnd(1, 1),
  header('deepseek-official', 'deepseek-flash'),
  stepStart(1, 2), message(1, 2, U2), stepEnd(1, 2),
  turnEnd(1),
])

describe('attempt fold', () => {
  it('single step', () => {
    const settled = run(singleStep)
    expect(settled).toEqual([{
      seq: singleStep[3]!.seq,
      at: singleStep[2]!.time,
      route: 'deepseek-official',
      model: 'deepseek-flash',
      turn: 1,
      step: 1,
      usage: U1,
    }])
  })

  it('retry bills both attempts', () => {
    const settled = run(retried)
    expect(settled).toHaveLength(2)
    expect(settled[0]).toEqual({
      seq: retried[3]!.seq,
      at: retried[2]!.time,
      route: 'deepseek-official',
      model: 'deepseek-flash',
      turn: 1,
      step: 1,
      usage: U2,
    })
    expect(settled[1]).toMatchObject({ seq: retried[6]!.seq, at: retried[5]!.time, usage: U1 })
  })

  it('matches deriveTurnTokenUsage', () => {
    for (const events of [singleStep, retried, twoSteps]) {
      const official = deriveTurnTokenUsage(events)
      expect(official).toBeDefined()
      const ours = { input: 0, output: 0, cacheRead: 0 }
      for (const { usage } of run(events)) {
        expect(usage).not.toBeNull()
        const normalized = normalizeUsage(usage!)
        expect(normalized.known).toBe(true)
        ours.input += normalized.tokens.input
        ours.output += normalized.tokens.output
        ours.cacheRead += normalized.tokens.cacheRead
      }
      expect(ours).toEqual({
        input: official!.uncachedInputTokens,
        output: official!.outputTokens,
        cacheRead: official!.cacheReadTokens,
      })
    }
  })

  it('truncated turn', () => {
    const events = seqd([turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1)])
    expect(() => run(events)).not.toThrow()
    expect(run(events)).toEqual([])
  })

  it('ignores unknown event types', () => {
    const unknown = { ...ev('x-plugin/whatever', { turn: 1, step: 1 }), seq: 1000, time: 0 } as SessionEvent
    const withUnknown = [...retried.slice(0, 4), unknown, ...retried.slice(4)]
    expect(run(withUnknown)).toEqual(run(retried))
    expect(foldEvent(initialFoldState(), unknown)).toEqual({ state: initialFoldState(), settled: [] })
  })

  it('state is JSON-serializable', () => {
    const all = seqd([...retried, ...twoSteps.map(event => renumberTurn(event, 2))])
    const expected = run(all)
    for (let cut = 0; cut <= all.length; cut++) {
      const head = foldAll(all.slice(0, cut))
      const revived = JSON.parse(JSON.stringify(head.state)) as FoldState
      expect(revived).toEqual(head.state)
      const tail = foldAll(all.slice(cut), revived)
      expect([...head.settled, ...tail.settled]).toEqual(expected)
    }
  })
})

describe('attempt fold: settlement details', () => {
  it('message usage falls back to the stream usage chunk', () => {
    const events = seqd([turnStart(1), stepStart(1, 1), message(1, 1, undefined, undefined, U2), stepEnd(1, 1), turnEnd(1)])
    expect(run(events).map(a => a.usage)).toEqual([U2])
  })

  it('message data.usage wins over the stream usage chunk', () => {
    const events = seqd([turnStart(1), stepStart(1, 1), message(1, 1, U1, undefined, U2), stepEnd(1, 1), turnEnd(1)])
    expect(run(events).map(a => a.usage)).toEqual([U1])
  })

  it('message without any usage settles as unknown (usage null)', () => {
    const events = seqd([turnStart(1), stepStart(1, 1), message(1, 1, undefined), stepEnd(1, 1), turnEnd(1)])
    expect(run(events)).toMatchObject([{ seq: 2, usage: null }])
  })

  it('message route comes from message.source, not the header', () => {
    const events = seqd([
      turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1),
      message(1, 1, U1, { provider: 'deepseek-account', model: 'deepseek-v4-pro' }), stepEnd(1, 1), turnEnd(1),
    ])
    expect(run(events)).toMatchObject([{ route: 'deepseek-account', model: 'deepseek-v4-pro' }])
  })

  it('attempt and retry settlements use the latest request/header', () => {
    const events = seqd([
      turnStart(1), header('a-route', 'a-model'), stepStart(1, 1), header('b-route', 'b-model'),
      attempt(1, 1, U2), retry(1, 1), retryStarted(1, 1, 1), header('c-route', 'c-model'), retry(1, 1),
      stepEnd(1, 1), turnEnd(1),
    ])
    expect(run(events)).toEqual([
      { seq: 4, at: events[2]!.time, route: 'b-route', model: 'b-model', turn: 1, step: 1, usage: U2 },
      { seq: 8, at: events[6]!.time, route: 'c-route', model: 'c-model', turn: 1, step: 1, usage: null },
    ])
  })

  it('attempt without a usage chunk settles as unknown (usage null)', () => {
    const events = seqd([turnStart(1), stepStart(1, 1), attempt(1, 1, undefined), stepEnd(1, 1), turnEnd(1)])
    expect(run(events)).toEqual([{ seq: 2, at: events[1]!.time, route: '', model: '', turn: 1, step: 1, usage: null }])
  })

  it('llm/retry after an attempt settlement does not bill twice', () => {
    const settled = run(retried)
    expect(settled.map(a => a.seq)).toEqual([3, 6])
  })

  it('step/end settles an open attempt only when it has a sample', () => {
    const events = seqd([turnStart(1), stepStart(1, 1), stepEnd(1, 1), turnEnd(1)])
    expect(run(events)).toEqual([])
  })

  it('a message after step/end in another turn still settles', () => {
    const events = seqd([...singleStep, ...singleStep.map(event => renumberTurn(event, 2))])
    expect(run(events).map(a => [a.turn, a.seq])).toEqual([[1, 3], [2, 9]])
  })
})

describe('attempt fold: invalid lifecycle keeps settled attempts', () => {
  it('a duplicate message for a settled attempt is ignored', () => {
    const events = seqd([
      turnStart(1), stepStart(1, 1), message(1, 1, U1), message(1, 1, U2), stepEnd(1, 1),
      stepStart(1, 2), message(1, 2, U2), stepEnd(1, 2), turnEnd(1),
    ])
    expect(run(events).map(a => [a.step, a.seq])).toEqual([[1, 2], [2, 6]])
  })

  it('a message for a different step than the open attempt is ignored', () => {
    const events = seqd([turnStart(1), stepStart(1, 1), message(1, 2, U1), message(1, 1, U2), stepEnd(1, 1), turnEnd(1)])
    expect(run(events)).toMatchObject([{ step: 1, seq: 3, usage: U2 }])
  })

  it('settlement events with no open attempt are ignored', () => {
    const events = seqd([message(1, 1, U1), attempt(1, 1, U1), retry(1, 1), stepEnd(1, 1), turnEnd(1)])
    expect(run(events)).toEqual([])
  })

  it('llm/retry after a message settlement is ignored', () => {
    const events = seqd([turnStart(1), stepStart(1, 1), message(1, 1, U1), retry(1, 1), stepEnd(1, 1), turnEnd(1)])
    expect(run(events).map(a => a.seq)).toEqual([2])
  })

  it('a truncated turn followed by a new turn still bills the new turn', () => {
    const events = seqd([
      turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1),
      turnStart(2), stepStart(2, 1), message(2, 1, U1), stepEnd(2, 1), turnEnd(2),
    ])
    expect(run(events)).toEqual([
      { seq: 5, at: events[4]!.time, route: 'deepseek-official', model: 'deepseek-flash', turn: 2, step: 1, usage: U1 },
    ])
  })

  it('a step/start without the previous step/end opens the new attempt', () => {
    const events = seqd([
      turnStart(1), stepStart(1, 1), message(1, 1, U1),
      stepStart(1, 2), message(1, 2, U2), stepEnd(1, 2), turnEnd(1),
    ])
    expect(run(events).map(a => [a.step, a.usage])).toEqual([[1, U1], [2, U2]])
  })

  it('llm/retry-started without a preceding llm/retry opens the new attempt', () => {
    const events = seqd([
      turnStart(1), stepStart(1, 1), attempt(1, 1, U2), retryStarted(1, 1, 1), message(1, 1, U1), stepEnd(1, 1),
      turnEnd(1),
    ])
    expect(run(events).map(a => [a.seq, a.at, a.usage])).toEqual([
      [2, events[1]!.time, U2],
      [4, events[3]!.time, U1],
    ])
  })
})

describe('normalizeUsage', () => {
  it('missing cache buckets is unknown usage', () => {
    expect(normalizeUsage({ inputTokens: 3, outputTokens: 7 })).toStrictEqual({
      known: false,
      tokens: { input: 3, cacheRead: 0, cacheWrite: 0, output: 7 },
    })
  })

  it('both cache buckets present is known', () => {
    expect(normalizeUsage(U1)).toStrictEqual({
      known: true,
      tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
    })
  })

  it('an exact total makes usage known without both cache buckets', () => {
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 170, cacheReadTokens: 50 }))
      .toStrictEqual({ known: true, tokens: { input: 100, cacheRead: 50, cacheWrite: 0, output: 20 } })
  })

  it('keeps reasoning tokens when reported', () => {
    expect(normalizeUsage({ ...U1, reasoningTokens: 30 })).toStrictEqual({
      known: true,
      tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, reasoning: 30 },
    })
  })

  it.each([
    ['negative input', { inputTokens: -1, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    ['fractional output', { inputTokens: 1, outputTokens: 0.5, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    ['reasoning above output', { ...U2, reasoningTokens: 6 }],
    ['total below prompt plus output', { ...U1, totalTokens: 10 }],
    ['total contradicting both buckets', { ...U1, totalTokens: 1051 }],
    ['unsafe prompt sum', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 }],
  ])('%s is unknown usage', (_name, usage) => {
    expect(normalizeUsage(usage).known).toBe(false)
  })

  it('unknown usage zeroes invalid counts for display', () => {
    expect(normalizeUsage({ inputTokens: -1, outputTokens: 5, cacheReadTokens: 2 })).toStrictEqual({
      known: false,
      tokens: { input: 0, cacheRead: 2, cacheWrite: 0, output: 5 },
    })
  })

  it('agrees with the official exact total for a consistent total', () => {
    expect(normalizeUsage({ ...U1, totalTokens: 1050 }).known).toBe(true)
  })
})

function renumberTurn(event: SessionEvent, turn: number): SessionEvent {
  const data = event.data as object
  return ('turn' in data ? { ...event, data: { ...data, turn } } : event) as SessionEvent
}
