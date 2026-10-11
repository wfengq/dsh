import { Button, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Budget, Currency } from 'dsh-tally-api'
import { compareDecimal } from '../dashboard/decimal.ts'
import { budgetName, type T } from '../labels.ts'

/** The `tally` Remote methods this editor calls. */
export interface BudgetsRemote {
  budgets(): Promise<RemoteResult<Budget[]>>
  setBudget(request: Budget): Promise<RemoteResult<void>>
  removeBudget(request: { id: string }): Promise<RemoteResult<void>>
}

/** A positive plain decimal. */
function validAmount(amount: string): boolean {
  return /^\d+(\.\d+)?$/.test(amount) && compareDecimal(amount, '0') > 0
}

/** Lists, adds and removes budgets; a refusal shows the server's own message. */
export function BudgetsEditor({ remote, generation = 0, t }: { remote: BudgetsRemote; generation?: number; t: T }): ReactNode {
  const [budgets, setBudgets] = useState<Budget[] | null | undefined>(undefined)
  const [period, setPeriod] = useState<Budget['period']>('day')
  const [workspace, setWorkspace] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const result = await remote.budgets()
      setBudgets(result.ok ? result.value : null)
    } catch {
      setBudgets(null)
    }
  }, [remote])
  // Reloaded on every `hello`: another window may have changed the budgets.
  useEffect(() => { void reload() }, [reload, generation])

  const run = async (call: () => Promise<RemoteResult<void>>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const result = await call()
      if (!result.ok) { setError(result.error.message); return false }
      await reload()
      return true
    } catch {
      setError(t('settings.saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    const id = globalThis.crypto.randomUUID()
    const scope = workspace.trim() === '' ? {} : { workspaceId: workspace.trim() }
    const saved = await run(() => remote.setBudget({ id, period, scope, limit: { amount, currency } }))
    if (saved) { setAmount(''); setWorkspace('') }
  }

  return (
    <section className="dsh-tally-settings-part" data-tally="budgets">
      <h3>{t('settings.budgets')}</h3>
      {budgets === null ? <p className="dsh-tally-error" role="alert">{t('settings.loadFailed')}</p> : null}
      {budgets && budgets.length === 0 ? <p className="dsh-tally-hint">{t('settings.none')}</p> : null}
      {budgets && budgets.length > 0
        ? (
            <ul className="dsh-tally-list">
              {budgets.map(budget => (
                <li key={budget.id}>
                  <span>{budgetName(budget, budget.limit, t)}</span>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run(() => remote.removeBudget({ id: budget.id })) }}>{t('settings.remove')}</Button>
                </li>
              ))}
            </ul>
          )
        : null}
      <div className="dsh-tally-form">
        <SegmentedControl
          id="dsh-tally-budget-period"
          label={t('settings.budget.period')}
          value={period}
          options={[{ value: 'day', label: t('settings.budget.day') }, { value: 'month', label: t('settings.budget.month') }]}
          onChange={setPeriod}
        />
        <Input aria-label={t('settings.budget.workspace')} placeholder={t('settings.budget.workspace')} value={workspace} onChange={event => { setWorkspace(event.target.value) }} />
        <Input aria-label={t('settings.budget.amount')} placeholder={t('settings.budget.amount')} inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value) }} />
        <SegmentedControl
          id="dsh-tally-budget-currency"
          label={t('settings.currency')}
          value={currency}
          options={[{ value: 'CNY', label: 'CNY' }, { value: 'USD', label: 'USD' }]}
          onChange={setCurrency}
        />
        <Button variant="primary" size="sm" disabled={busy || !validAmount(amount)} onClick={() => { void add() }}>{t('settings.budget.add')}</Button>
        {error !== null ? <p className="dsh-tally-error" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
