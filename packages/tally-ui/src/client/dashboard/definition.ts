/** Identity of the dashboard sidebar tab and the time ranges it offers. */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { T } from '../labels.ts'

export const TAB_ID = 'tally.dashboard'
export const TAB_KIND = 'tally.dashboard'

/** The sidebar tab type: a page opened by kind, listed on the guide page. */
export function tabDefinition(t: T): SidebarRightTabDefinition {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => t('tab.title'),
    guide: [{ id: TAB_ID, order: 50, title: () => t('tab.title') }],
  }
}

export type RangeId = 'today' | '7d' | '30d' | 'month'
/** Today is always in the overview, so the range switch starts at a week. */
export const RANGES: readonly RangeId[] = ['7d', '30d', 'month']

export interface DateRange {
  /** Epoch milliseconds, inclusive. */
  from: number
  /** Epoch milliseconds, exclusive. */
  to: number
}

/** Local midnight `offset` days from the day containing `at`, in the browser time zone. */
function midnight(at: number, offset: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime()
}

/** Bounds of a range in the browser time zone: whole local days ending with today (or the whole current month). */
export function rangeBounds(range: RangeId, now: number): DateRange {
  switch (range) {
    case 'today': return { from: midnight(now, 0), to: midnight(now, 1) }
    case '7d': return { from: midnight(now, -6), to: midnight(now, 1) }
    case '30d': return { from: midnight(now, -29), to: midnight(now, 1) }
    case 'month': {
      const d = new Date(now)
      return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() }
    }
  }
}

/** `YYYY-MM-DD` keys of every local day in the range, matching the Host's day grouping keys. */
export function dayKeys(range: DateRange): string[] {
  const keys: string[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  for (let at = range.from; at < range.to;) {
    const d = new Date(at)
    keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    at = midnight(at, 1)
  }
  return keys
}
