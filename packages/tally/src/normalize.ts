import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { TallyTokens } from 'dsh-tally-api'

export type NormalizedUsage =
  | { known: true; tokens: TallyTokens }
  | { known: false; tokens: TallyTokens }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

/**
 * Validity rules mirrored exactly from the official `normalizeUsage` in
 * `@deepseek-ai/dsh-token-meter` (`src/turn-usage.ts`): every reported count is a
 * non-negative safe integer, reasoning never exceeds output, prompt sums stay
 * safe, a reported `totalTokens` is consistent with the prompt buckets, and
 * without `totalTokens` both cache buckets must be reported.
 */
function isExact(usage: TokenUsage): boolean {
  const {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
  } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return false
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return false
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return false
  if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) return false

  const knownPrompt = safeSum([
    inputTokens,
    ...cacheReadTokens === undefined ? [] : [cacheReadTokens],
    ...cacheWriteTokens === undefined ? [] : [cacheWriteTokens],
  ])
  if (knownPrompt === undefined) return false

  if (totalTokens !== undefined) {
    if (!isCount(totalTokens)) return false
    const exactPrompt = totalTokens - outputTokens
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return false
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) return false
    return true
  }
  if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return false
  return safeSum([knownPrompt, outputTokens]) !== undefined
}

/**
 * Map a provider `TokenUsage` sample to ledger token buckets.
 *
 * `known: false` means the official token-meter would refuse this sample as
 * exact accounting; its `tokens` are best-effort display values only (absent or
 * invalid counts become 0) and must never be priced.
 */
export function normalizeUsage(u: TokenUsage): NormalizedUsage {
  const count = (value: number | undefined): number => isCount(value) ? value : 0
  const tokens: TallyTokens = {
    input: count(u.inputTokens),
    cacheRead: count(u.cacheReadTokens),
    cacheWrite: count(u.cacheWriteTokens),
    output: count(u.outputTokens),
    ...isCount(u.reasoningTokens) ? { reasoning: u.reasoningTokens } : {},
  }
  return isExact(u) ? { known: true, tokens } : { known: false, tokens }
}
