/** Text helpers shared by the conversation elements. */
import type { UsageGroup } from 'dsh-tally-api'
import { formatMoneyList, type Locale } from './format.ts'
import type { TallyLocaleKey } from './locales.ts'

/** Formatting follows the currency, not the UI language (see `format.ts`), so one locale serves all. */
export const FORMAT_LOCALE: Locale = 'zh'

export type T = (key: TallyLocaleKey, params?: Record<string, unknown>) => string

/**
 * Cost of a usage group: the priced amounts, with an "unpriced" marker when some requests have no
 * price. A group whose requests are all unpriced shows only the marker, never a zero.
 */
export function costLabel(group: UsageGroup, t: T): string {
  if (group.cost.length === 0) return group.requestCount > 0 ? t('money.unpriced') : formatMoneyList([], FORMAT_LOCALE)
  const amount = formatMoneyList(group.cost, FORMAT_LOCALE)
  return group.unpricedCount > 0 ? `${amount} + ${t('money.unpriced')}` : amount
}
