import { Button, Input, Menu, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Budget, Currency } from 'dsh-tally-api'
import type { T } from '../labels.ts'
import { validateBudgetDraft } from './validate.ts'

/** Adds a budget (`editing` null) or edits one under its own id. The dialog stays open on a refusal. */
export function BudgetDialog({ open, editing, existing, workspaces, save, onClose, t }: {
  open: boolean
  editing: Budget | null
  existing: readonly Budget[]
  /** Workspaces seen in the ledger; `null` while loading. */
  workspaces: readonly string[] | null
  save: (budget: Budget) => Promise<RemoteResult<void>>
  onClose: () => void
  t: T
}): ReactNode {
  const [period, setPeriod] = useState<Budget['period']>('day')
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [scopeOpen, setScopeOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Every opening starts from the edited budget, or from an empty daily CNY draft.
  useEffect(() => {
    if (!open) return
    setPeriod(editing?.period ?? 'day')
    setWorkspaceId(editing?.scope.workspaceId ?? null)
    setAmount(editing?.limit.amount ?? '')
    setCurrency(editing?.limit.currency ?? 'CNY')
    setError(null)
    setBusy(false)
  }, [open, editing])

  const problem = validateBudgetDraft({ period, workspaceId, amount }, existing, editing?.id ?? null)
  const title = t(editing === null ? 'settings.budget.add' : 'settings.budget.edit')
  const allLabel = t('settings.budget.allWorkspaces')
  const choices = [...new Set([...(workspaces ?? []), ...(workspaceId === null ? [] : [workspaceId])])]

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await save({
        id: editing?.id ?? globalThis.crypto.randomUUID(),
        period,
        scope: workspaceId === null ? {} : { workspaceId },
        limit: { amount: amount.trim(), currency },
      })
      if (result.ok) onClose()
      else setError(result.error.message)
    } catch {
      setError(t('settings.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('settings.cancel')}
      footer={(
        <div className="dsh-tally-dialog-actions">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('settings.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={busy || problem !== null} onClick={() => { void submit() }}>{t('settings.save')}</Button>
        </div>
      )}
    >
      <div className="dsh-tally-dialog" data-tally="budget-dialog">
        <div className="dsh-tally-field">
          <span className="dsh-tally-field-label">{t('settings.budget.period')}</span>
          <SegmentedControl
            id="dsh-tally-budget-period"
            label={t('settings.budget.period')}
            value={period}
            options={[{ value: 'day', label: t('settings.budget.day') }, { value: 'month', label: t('settings.budget.month') }]}
            onChange={setPeriod}
          />
        </div>
        <div className="dsh-tally-field">
          <span className="dsh-tally-field-label">{t('settings.budget.scope')}</span>
          <Menu
            open={scopeOpen}
            onClose={() => { setScopeOpen(false) }}
            onSelect={(id) => { setWorkspaceId(id === '' ? null : id) }}
            items={[{ id: '', label: allLabel }, ...choices.map(w => ({ id: w, label: w }))]}
            anchor={(
              <Button variant="outline" size="sm" onClick={() => { setScopeOpen(o => !o) }}>
                {workspaceId ?? allLabel}
              </Button>
            )}
          />
        </div>
        <div className="dsh-tally-field">
          <label className="dsh-tally-field-label" htmlFor="dsh-tally-budget-amount">{t('settings.budget.amount')}</label>
          <div className="dsh-tally-amount">
            <Input id="dsh-tally-budget-amount" aria-label={t('settings.budget.amount')} inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value) }} />
            <SegmentedControl
              id="dsh-tally-budget-currency"
              label={t('settings.currency')}
              value={currency}
              options={[{ value: 'CNY', label: 'CNY' }, { value: 'USD', label: 'USD' }]}
              onChange={setCurrency}
            />
          </div>
          {amount.trim() !== '' && problem === 'invalid-amount' ? <p className="dsh-tally-field-error">{t('settings.budget.invalidAmount')}</p> : null}
          {problem === 'duplicate' ? <p className="dsh-tally-field-error">{t('settings.budget.duplicate')}</p> : null}
        </div>
        {error === null ? null : <p className="dsh-tally-error" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
