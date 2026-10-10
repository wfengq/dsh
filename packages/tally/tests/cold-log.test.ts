import { describe, expect, it } from 'vitest'
import { interruptedTurnClosers, type SessionEvent } from '@deepseek-ai/dsh-session'
import { withoutInterruptedClosers } from '../src/cold-log.js'
import { ev, header, message, seqd, stepEnd, stepStart, turnEnd, turnStart, U1 } from './fixtures/events.ts'

const done = seqd([turnStart(1), header('deepseek-official', 'deepseek-flash'), stepStart(1, 1), message(1, 1, U1), stepEnd(1, 1), turnEnd(1)])

function cold(events: SessionEvent[]): SessionEvent[] {
  return [...events, ...interruptedTurnClosers(events)]
}

function toolCallMessage(turn: number, step: number): SessionEvent {
  return ev('assistant/message', {
    turn,
    step,
    message: {
      id: `message-${turn}-${step}`,
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
    },
    stream: [],
    usage: U1,
  })
}

describe('withoutInterruptedClosers', () => {
  it('keeps a balanced log unchanged', () => {
    expect(withoutInterruptedClosers(cold(done))).toEqual(done)
  })

  it('strips step/end and turn/end appended after an open step', () => {
    const open = seqd([...done, turnStart(2), stepStart(2, 1)])
    const read = cold(open)
    expect(read.length).toBe(open.length + 2)
    expect(withoutInterruptedClosers(read)).toEqual(open)
  })

  it('strips a turn/end appended between steps', () => {
    const open = seqd([...done, turnStart(2), stepStart(2, 1), stepEnd(2, 1)])
    expect(withoutInterruptedClosers(cold(open))).toEqual(open)
  })

  it('strips synthetic tool results for unanswered tool calls', () => {
    const open = seqd([...done, turnStart(2), stepStart(2, 1), toolCallMessage(2, 1)])
    const read = cold(open)
    expect(read.slice(open.length).map(e => e.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    expect(withoutInterruptedClosers(read)).toEqual(open)
  })

  it('keeps a real interrupted turn/end that is not a synthetic closer', () => {
    const real = seqd([...done, turnStart(2), stepStart(2, 1), stepEnd(2, 1), ev('turn/end', { turn: 2, reason: { kind: 'interrupted' } }), turnStart(3)])
    const tail = seqd([...done, turnStart(2), ev('turn/end', { turn: 7, reason: { kind: 'interrupted' } })])
    expect(withoutInterruptedClosers(real)).toEqual(real)
    expect(withoutInterruptedClosers(tail)).toEqual(tail)
  })
})
