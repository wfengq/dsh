import type { ReactNode } from 'react'
import { formatMoney } from '../format.ts'
import { FORMAT_LOCALE, type T } from '../labels.ts'
import { stackedBars } from './chart.ts'
import type { CurrencyChart } from './data.ts'
import './dashboard.css'

const WIDTH = 320
const HEIGHT = 110

/** Daily stacked bars of one currency: peak on top of off-peak (flat counts as off-peak). */
export function DailyChart({ chart, t }: { chart: CurrencyChart; t: T }): ReactNode {
  const bars = stackedBars(chart.days, WIDTH, HEIGHT)
  return (
    <figure className="dsh-tally-chart" data-tally="daily-chart" data-currency={chart.currency}>
      <figcaption>{t('tab.dailyCost', { currency: chart.currency })}</figcaption>
      <p className="dsh-tally-total" data-tally="range-total">
        {t('tab.rangeTotal', { total: formatMoney({ amount: chart.total, currency: chart.currency }, FORMAT_LOCALE) })}
      </p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t('tab.chartLabel', { currency: chart.currency })} preserveAspectRatio="none">
        {bars.map(bar => (
          <rect
            key={`${bar.key}-${bar.band}`}
            className={`dsh-tally-bar dsh-tally-bar-${bar.band}`}
            x={bar.x}
            y={bar.y}
            width={bar.w}
            height={bar.h}
          >
            <title>
              {t('tab.barTitle', {
                day: bar.key,
                band: bar.band === 'peak' ? t('band.peak') : t('band.offpeak'),
                amount: formatMoney({ amount: bar.amount, currency: chart.currency }, FORMAT_LOCALE),
              })}
            </title>
          </rect>
        ))}
      </svg>
      <div className="dsh-tally-legend">
        <span className="dsh-tally-swatch dsh-tally-bar-peak" />{t('band.peak')}
        <span className="dsh-tally-swatch dsh-tally-bar-offpeak" />{t('band.offpeak')}
      </div>
    </figure>
  )
}
