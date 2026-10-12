import type { ReactNode } from 'react'
import type { T } from '../labels.ts'
import { lineSegments } from './chart.ts'
import './dashboard.css'

const WIDTH = 320
const HEIGHT = 60

/** Daily cache hit rate as a line; days without input leave a gap. */
export function HitRateTrend({ rates, t }: { rates: readonly { key: string; rate: number | null }[]; t: T }): ReactNode {
  const segments = lineSegments(rates.map(r => r.rate), WIDTH, HEIGHT)
  return (
    <section className="dsh-tally-section" data-tally="hit-rate">
      <h3>{t('tab.hitRateTrend')}</h3>
      <svg className="dsh-tally-line" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t('tab.hitRateLabel')} preserveAspectRatio="none">
        {segments.map((points, i) => (
          points.length === 1
            ? <circle key={i} className="dsh-tally-dot" cx={points[0]!.x} cy={points[0]!.y} r={2} />
            : <polyline key={i} className="dsh-tally-polyline" points={points.map(p => `${p.x},${p.y}`).join(' ')} />
        ))}
      </svg>
    </section>
  )
}
