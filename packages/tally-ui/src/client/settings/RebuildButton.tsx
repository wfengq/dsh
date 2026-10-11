import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TallyStatusView } from 'dsh-tally-api'
import type { T } from '../labels.ts'
import { useSnapshot } from './form.ts'
import type { Snapshot } from '../store.ts'

/** Longest wait for the first status frame after an accepted rebuild call, milliseconds. */
const AWAIT_FRAME_MS = 5000

/** Rebuilds the ledger after a confirmation; progress comes from the `status` frames of the watch stream. */
export function RebuildButton({ rebuild, status, t }: { rebuild: () => Promise<RemoteResult<void>>; status: Snapshot<TallyStatusView | null>; t: T }): ReactNode {
  const backfill = useSnapshot(status)?.usage.backfill ?? null
  const [confirming, setConfirming] = useState(false)
  const [calling, setCalling] = useState(false)
  const [failed, setFailed] = useState(false)
  // After an accepted call the rebuild may not have shown up in the status yet: stay busy until a
  // frame reports a backfill and then none, or until the bounded wait runs out.
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'running'>('idle')
  useEffect(() => {
    if (phase === 'waiting' && backfill !== null) setPhase('running')
    else if (phase === 'running' && backfill === null) setPhase('idle')
  }, [phase, backfill])
  useEffect(() => {
    if (phase !== 'waiting') return
    const timer = setTimeout(() => { setPhase('idle') }, AWAIT_FRAME_MS)
    return () => { clearTimeout(timer) }
  }, [phase])
  const run = async () => {
    setConfirming(false)
    setCalling(true)
    setFailed(false)
    try {
      const result = await rebuild()
      if (result.ok) setPhase('waiting')
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setCalling(false)
    }
  }
  return (
    <section className="dsh-tally-settings-part" data-tally="rebuild">
      <h3>{t('settings.rebuild')}</h3>
      <Button variant="outline" size="sm" disabled={calling || backfill !== null || phase !== 'idle'} onClick={() => { setConfirming(true) }}>{t('settings.rebuildAction')}</Button>
      {backfill !== null ? <p className="dsh-tally-hint" role="status">{t('settings.rebuildProgress', { done: backfill.done, total: backfill.total })}</p> : null}
      {failed ? <p className="dsh-tally-error" role="alert">{t('settings.rebuildFailed')}</p> : null}
      <Modal
        open={confirming}
        onClose={() => { setConfirming(false) }}
        title={t('settings.rebuild')}
        closeLabel={t('settings.cancel')}
        description={t('settings.rebuildConfirm')}
        footer={(
          <div className="dsh-tally-actions">
            <Button variant="ghost" size="sm" onClick={() => { setConfirming(false) }}>{t('settings.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => { void run() }}>{t('settings.confirm')}</Button>
          </div>
        )}
      />
    </section>
  )
}
