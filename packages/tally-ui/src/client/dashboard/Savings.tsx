import type { ReactNode } from 'react'
import type { PeakSavings } from 'dsh-tally-api'
import { formatMoneyList } from '../format.ts'
import { FORMAT_LOCALE, type T } from '../labels.ts'
import './dashboard.css'

/** The peak-versus-off-peak fact for the period; nothing when no peak-hour usage was priced. */
export function Savings({ savings, t }: { savings: PeakSavings | null; t: T }): ReactNode {
  if (savings === null || savings.peak.length === 0) return null
  return (
    <section className="dsh-tally-section" data-tally="savings">
      <h3>{t('tab.savings')}</h3>
      <p className="dsh-tally-fact">
        {t('tab.savingsFact', {
          peak: formatMoneyList(savings.peak, FORMAT_LOCALE),
          offpeak: formatMoneyList(savings.offpeakEquivalent, FORMAT_LOCALE),
        })}
      </p>
    </section>
  )
}
