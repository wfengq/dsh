// Session event builders for fold tests. Official event payloads carry fields that
// are irrelevant to billing (message ids, retry policy keys, failures, ...), so the
// builders cast through `unknown` like the official token-meter specs do.
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const T0 = Date.parse('2026-10-14T10:00:00+08:00')

export const U1: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 }
export const U2: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }

export const DEFAULT_ROUTE = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-flash'

/** Builds an event with placeholder `seq`/`time`; `seqd` assigns the real ones. */
export function ev(type: string, data: unknown): SessionEvent {
  return { type, seq: 0, time: 0, data } as unknown as SessionEvent
}

function usageStream(usage: TokenUsage | undefined): unknown[] {
  return [
    { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    ...usage === undefined ? [] : [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
  ]
}

export function turnStart(turn: number): SessionEvent {
  return ev('turn/start', { turn })
}

export function turnEnd(turn: number): SessionEvent {
  return ev('turn/end', { turn, reason: { kind: 'completed' } })
}

export function stepStart(turn: number, step: number): SessionEvent {
  return ev('step/start', { turn, step })
}

export function stepEnd(turn: number, step: number): SessionEvent {
  return ev('step/end', { turn, step })
}

export function header(provider: string, model: string): SessionEvent {
  return ev('request/header', { header: { config: { provider, model } }, reason: 'initial' })
}

/**
 * `usage` goes to `data.usage`; `streamUsage` (optional) becomes the stream's
 * usage chunk, which the fold reads only when `data.usage` is absent.
 */
export function message(
  turn: number,
  step: number,
  usage: TokenUsage | undefined,
  source: { provider: string; model: string } = { provider: DEFAULT_ROUTE, model: DEFAULT_MODEL },
  streamUsage?: TokenUsage,
): SessionEvent {
  return ev('assistant/message', {
    turn,
    step,
    message: {
      id: `message-${turn}-${step}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', ...source },
    },
    stream: usageStream(streamUsage),
    ...usage === undefined ? {} : { usage },
  })
}

export function attempt(turn: number, step: number, usage: TokenUsage | undefined): SessionEvent {
  return ev('assistant/attempt', { turn, step, stream: usageStream(usage) })
}

export function retry(turn: number, step: number): SessionEvent {
  return ev('llm/retry', {
    retryId: `retry-${turn}-${step}`,
    turn,
    step,
    provider: DEFAULT_ROUTE,
    mode: 'normal',
    policyKey: 'default',
    retry: 1,
    maxRetries: 3,
    delayMs: 1000,
    failure: { message: 'overloaded', code: 'overloaded' },
  })
}

export function retryStarted(turn: number, step: number, n: number): SessionEvent {
  return ev('llm/retry-started', { retryId: `retry-${turn}-${step}`, turn, step, retry: n })
}

/** Assigns `seq = index` and `time = T0 + index * 1000` in array order. */
export function seqd(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: index, time: T0 + index * 1000 }) as SessionEvent)
}
