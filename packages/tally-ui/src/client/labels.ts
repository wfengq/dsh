/** Text helpers shared by the conversation elements. */
import type { Budget, Money, UsageGroup } from 'dsh-tally-api'
import { formatMoney, formatMoneyList, type Locale } from './format.ts'
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

/** Whether `url` is a plain http(s) link; anything else (`javascript:`, `data:`, ...) must never become an `href`. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//.test(url)
}

/**
 * How a budget is named to the user: `每日预算 · ¥10[ · workspace]`. Budget ids are opaque (the
 * settings page makes UUIDs), so they are never shown; an unknown budget is named by its limit only.
 */
export function budgetName(budget: Budget | undefined, limit: Money, t: T): string {
  if (budget === undefined) return t('budget.name', { period: t('budget.any'), limit: formatMoney(limit, FORMAT_LOCALE) })
  const period = t(budget.period === 'day' ? 'budget.day' : 'budget.month')
  const amount = formatMoney(budget.limit, FORMAT_LOCALE)
  const workspace = budget.scope.workspaceId
  return workspace === undefined
    ? t('budget.name', { period, limit: amount })
    : t('budget.nameWorkspace', { period, limit: amount, workspace })
}
