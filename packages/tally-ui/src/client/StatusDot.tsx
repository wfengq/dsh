import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TallyStatusView } from 'dsh-tally-api'
import type { NS } from './locales.ts'
import './StatusDot.css'

/** What the registration hands the dot: the `tally/status` Remote call. */
export interface StatusDotInjected {
  status: () => Promise<RemoteResult<TallyStatusView>>
}

export type StatusDotProps = InjectFace<StatusDotInjected> & PropsLocale<typeof NS>

/**
 * Session header indicator proving the `tally` Remote namespace answers: a dot that turns
 * ready once `tally/status` succeeds. Renders nothing until the first answer arrives.
 */
export function StatusDot({ status, t }: StatusDotProps): ReactNode {
  const [ready, setReady] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let live = true
    status().then(
      (result) => { if (live) setReady(result.ok) },
      () => { if (live) setReady(false) },
    )
    return () => { live = false }
  }, [status])

  if (ready === undefined) return null
  const label = t(ready ? 'status.ready' : 'status.unavailable')
  return (
    <span
      className="dsh-tally-status-dot"
      data-tally="status"
      data-ready={ready ? 'true' : 'false'}
      role="img"
      aria-label={label}
      title={label}
    />
  )
}
