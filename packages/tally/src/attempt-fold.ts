import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
// Merges the `llm/retry` and `llm/retry-started` events into SessionEventMap.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * One billed request attempt: the ledger's unit of accounting.
 *
 * `seq` is the settling event's seq (the idempotency key together with the
 * session id). `at` is the time of the event that opened the attempt
 * (`step/start` or `llm/retry-started`). `usage` is the attempt's last usage
 * sample, or `null` when the attempt settled without one.
 */
export interface BilledAttempt {
  seq: number
  at: number
  route: string
  model: string
  turn: number
  step: number
  usage: TokenUsage | null
}

declare const opaque: unique symbol

/** Opaque, JSON-serializable fold state. Persist it with `JSON.stringify`; never read its fields. */
export interface FoldState {
  readonly [opaque]: 'dsh-tally/fold-state'
}

interface Route {
  readonly provider: string
  readonly model: string
}

/**
 * Attempt lifecycle, mirroring `AttemptState` in the official token-meter
 * `deriveTurnTokenUsage`. `open.sample` is kept for parity with the official
 * fold even though no durable event currently sets it before settlement.
 */
type AttemptState =
  | { readonly kind: 'idle' }
  | {
    readonly kind: 'open'
    readonly turn: number
    readonly step: number
    readonly at: number
    readonly sample: TokenUsage | null
  }
  | { readonly kind: 'finishClosed'; readonly turn: number; readonly step: number }
  | { readonly kind: 'settled'; readonly turn: number; readonly step: number; readonly by: 'message' | 'retry' }

interface State {
  readonly v: 1
  readonly attempt: AttemptState
  /** Route of the latest `request/header`, used for settlements without `message.source`. */
  readonly header: Route | null
}

type FoldResult = { state: FoldState; settled: BilledAttempt[] }

const IDLE: AttemptState = { kind: 'idle' }

export function initialFoldState(): FoldState {
  return wrap({ v: 1, attempt: IDLE, header: null })
}

function wrap(state: State): FoldState {
  return state as unknown as FoldState
}

function unwrap(state: FoldState): State {
  return state as unknown as State
}

function streamUsage(stream: SessionEvent<'assistant/attempt'>['data']['stream']): TokenUsage | undefined {
  return lastAssistantStreamChunk(stream, 'usage')?.usage
}

function isOpenFor(
  attempt: AttemptState,
  turn: number,
  step: number,
): attempt is Extract<AttemptState, { kind: 'open' }> {
  return attempt.kind === 'open' && attempt.turn === turn && attempt.step === step
}

function headerRoute(state: State): Route {
  return state.header ?? { provider: '', model: '' }
}

function bill(
  open: Extract<AttemptState, { kind: 'open' }>,
  event: SessionEvent,
  usage: TokenUsage | null,
  route: Route,
): BilledAttempt {
  return {
    seq: event.seq,
    at: open.at,
    route: route.provider,
    model: route.model,
    turn: open.turn,
    step: open.step,
    usage,
  }
}

/**
 * Fold one session event into the per-attempt billing state.
 *
 * Settlement follows the official `deriveTurnTokenUsage` rules: `assistant/message`
 * and `assistant/attempt` settle the open attempt, `llm/retry` settles an attempt
 * that is still open, `step/end` settles an open attempt only when it holds a
 * usage sample, and `llm/retry-started` opens the next attempt. An attempt is
 * settled at most once, so no event sequence can bill an attempt twice.
 *
 * Unlike the official fold, which discards a whole Turn on any invalid lifecycle,
 * a settlement event that does not match the open attempt is ignored on its own
 * and earlier settlements stand. Opening events (`turn/start`, `step/start`,
 * `llm/retry-started`) are authoritative: they drop an unsettled attempt (which
 * has no usage to bill) and resynchronize, so one missing boundary in a
 * truncated or crashed log cannot suppress billing for the rest of the session.
 */
export function foldEvent(state: FoldState, event: SessionEvent): FoldResult {
  const current = unwrap(state)
  const { attempt } = current
  const next = (patch: Partial<State>, settled: BilledAttempt[] = []): FoldResult => ({
    state: wrap({ ...current, ...patch }),
    settled,
  })
  const unchanged: FoldResult = { state, settled: [] }

  switch (event.type) {
    case 'request/header': {
      const { provider, model } = event.data.header.config
      return next({ header: { provider, model } })
    }
    case 'turn/start':
      return next({ attempt: IDLE })
    case 'turn/end':
      if (attempt.kind !== 'idle' && attempt.turn !== event.data.turn) return unchanged
      return next({ attempt: IDLE })
    case 'step/start':
      return next({
        attempt: { kind: 'open', turn: event.data.turn, step: event.data.step, at: event.time, sample: null },
      })
    case 'llm/retry-started':
      return next({
        attempt: { kind: 'open', turn: event.data.turn, step: event.data.step, at: event.time, sample: null },
      })
    case 'assistant/attempt': {
      const { turn, step, stream } = event.data
      if (!isOpenFor(attempt, turn, step)) return unchanged
      const usage = streamUsage(stream) ?? attempt.sample
      return next(
        { attempt: { kind: 'finishClosed', turn, step } },
        [bill(attempt, event, usage, headerRoute(current))],
      )
    }
    case 'assistant/message': {
      const { turn, step, stream, message } = event.data
      if (!isOpenFor(attempt, turn, step)) return unchanged
      const usage = event.data.usage ?? streamUsage(stream) ?? attempt.sample
      const { provider, model } = message.source
      const route = provider.length > 0 && model.length > 0 ? { provider, model } : headerRoute(current)
      return next(
        { attempt: { kind: 'settled', turn, step, by: 'message' } },
        [bill(attempt, event, usage, route)],
      )
    }
    case 'llm/retry': {
      const { turn, step } = event.data
      if (attempt.kind === 'idle' || attempt.kind === 'settled') return unchanged
      if (attempt.turn !== turn || attempt.step !== step) return unchanged
      const settled = attempt.kind === 'open' ? [bill(attempt, event, attempt.sample, headerRoute(current))] : []
      return next({ attempt: { kind: 'settled', turn, step, by: 'retry' } }, settled)
    }
    case 'step/end': {
      const { turn, step } = event.data
      if (attempt.kind === 'idle' || attempt.turn !== turn || attempt.step !== step) return unchanged
      const settled = attempt.kind === 'open' && attempt.sample !== null
        ? [bill(attempt, event, attempt.sample, headerRoute(current))]
        : []
      return next({ attempt: IDLE }, settled)
    }
    default:
      return unchanged
  }
}
