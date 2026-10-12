import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BalanceSnapshot } from 'dsh-tally-api'
import { formatMoneyList } from './format.ts'
import { FORMAT_LOCALE, type T } from './labels.ts'
import './BalanceText.css'

/** Longest a refresh shows its loading state, even if the Host never answers. */
export const REFRESH_TIMEOUT_MS = 10_000

export interface BalanceTextProps {
  /** Latest snapshot of the shown route; `undefined` before the first answer. */
  snapshot: BalanceSnapshot | undefined
  /** Asks the Host to query the balance now. */
  onRefresh: () => Promise<void>
  t: T
}

/**
 * Text of a balance snapshot. A balance that loaded at least once shows its `total` wallets, marked
 * stale after a failed refresh; one that never loaded shows why. Never shows a made-up zero.
 */
export function balanceLabel(snapshot: BalanceSnapshot | undefined, t: T): { text: string; stale: boolean } {
  if (snapshot === undefined) return { text: formatMoneyList([], FORMAT_LOCALE), stale: false }
  const totals = snapshot.wallets.filter(w => w.kind === 'total').map(w => w.money)
  if (totals.length > 0) return { text: formatMoneyList(totals, FORMAT_LOCALE), stale: snapshot.stale }
  if (snapshot.errorCode === 'not-configured') return { text: t('balance.notConfigured'), stale: false }
  if (snapshot.errorCode === 'signed-out') return { text: t('balance.signedOut'), stale: false }
  return { text: t('balance.failed', { reason: snapshot.error ?? snapshot.errorCode ?? '' }), stale: false }
}

/** The clickable balance of the cost dock; clicking refreshes it. */
export function BalanceText({ snapshot, onRefresh, t }: BalanceTextProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const refresh = () => {
    if (busy) return
    setBusy(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, REFRESH_TIMEOUT_MS) })
    void Promise.race([onRefresh().catch(() => {}), timeout]).then(() => {
      clearTimeout(timer)
      if (live.current) setBusy(false)
    })
  }

  const { text, stale } = balanceLabel(snapshot, t)
  return (
    <button
      type="button"
      className="dsh-tally-balance"
      data-tally="balance"
      aria-busy={busy ? 'true' : 'false'}
      title={t(busy ? 'balance.refreshing' : 'balance.refresh')}
      onClick={refresh}
    >
      <span className="dsh-tally-label">{t('dock.balance')}</span>
      <span className="dsh-tally-num">{text}</span>
      {stale ? <span className="dsh-tally-balance-stale">{t('balance.stale')}</span> : null}
    </button>
  )
}
