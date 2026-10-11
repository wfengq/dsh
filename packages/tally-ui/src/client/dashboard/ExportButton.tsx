import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ReactNode } from 'react'
import type { T } from '../labels.ts'
import type { DateRange } from './definition.ts'
import type { DashboardRemote } from './data.ts'
import './dashboard.css'

/** How long the object URL outlives the click that starts the download. */
const REVOKE_DELAY_MS = 1000

function stamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Downloads the range as `tally-<from>-<to>.csv`; the end date is the last included day. */
export function ExportButton({ remote, range, tz, t }: { remote: DashboardRemote; range: DateRange; tz: string; t: T }): ReactNode {
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const result = await remote.exportCsv({ from: range.from, to: range.to, tz })
      if (!result.ok) { setFailed(true); return }
      const url = URL.createObjectURL(new Blob([result.value], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `tally-${stamp(range.from)}-${stamp(range.to - 1)}.csv`
      link.hidden = true
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Some browsers start the download only after the click handler returns; revoking at once can cancel it.
      setTimeout(() => { URL.revokeObjectURL(url) }, REVOKE_DELAY_MS)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dsh-tally-export">
      <Button variant="outline" size="sm" disabled={busy} data-tally="export" onClick={() => { void run() }}>{t('tab.export')}</Button>
      {failed ? <span className="dsh-tally-error" role="alert">{t('tab.error')}</span> : null}
    </div>
  )
}
