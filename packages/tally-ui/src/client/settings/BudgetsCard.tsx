import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Budget, Money, UsageGroup, UsageQuery } from 'dsh-tally-api'
import { budgetRatio, budgetTone } from '../budget-progress.ts'
import { addDecimal } from '../dashboard/decimal.ts'
import { formatMoney } from '../format.ts'
import { FORMAT_LOCALE, type T } from '../labels.ts'
import type { Snapshot } from '../store.ts'
import { BudgetDialog } from './BudgetDialog.tsx'
import { SettingsCard, SettingsRow } from './Card.tsx'
import { useSnapshot } from './form.ts'

/** The `tally` Remote methods this card calls. */
export interface BudgetsRemote {
  budgets(): Promise<RemoteResult<Budget[]>>
  setBudget(request: Budget): Promise<RemoteResult<void>>
  removeBudget(request: { id: string }): Promise<RemoteResult<void>>
  query(request: UsageQuery): Promise<RemoteResult<UsageGroup[]>>
}

/** "每日 · 全部工作区": the budget's name without its amount. */
function budgetTitle(budget: Budget, t: T): string {
  const period = t(budget.period === 'day' ? 'settings.budget.day' : 'settings.budget.month')
  return `${period} · ${budget.scope.workspaceId ?? t('settings.budget.allWorkspaces')}`
}

function BudgetRow({ budget, spent, onEdit, onRemove, busy, t }: {
  budget: Budget
  spent: Money
  onEdit: () => void
  onRemove: () => void
  busy: boolean
  t: T
}): ReactNode {
  const [menu, setMenu] = useState(false)
  const ratio = budgetRatio(spent, budget.limit)
  const tone = budgetTone(ratio)
  const over = addDecimal(spent.amount, `-${budget.limit.amount}`)
  const progress = tone === 'over'
    ? t('settings.budget.over', { amount: formatMoney({ amount: over, currency: budget.limit.currency }, FORMAT_LOCALE) })
    : `${Math.floor(ratio * 100)}%`
  return (
    <SettingsRow
      tally="budget-row"
      label={budgetTitle(budget, t)}
      hint={t('settings.budget.spent', { spent: formatMoney(spent, FORMAT_LOCALE), limit: formatMoney(budget.limit, FORMAT_LOCALE) })}
      control={(
        <>
          <span className="dsh-tally-progress" data-tone={tone}>
            <span className="dsh-tally-progress-text">{progress}</span>
            <span className="dsh-tally-progress-track" aria-hidden="true">
              <span className="dsh-tally-progress-fill" style={{ '--dsh-tally-progress': String(Math.min(ratio, 1)) } as CSSProperties} />
            </span>
          </span>
          <Menu
            open={menu}
            onClose={() => { setMenu(false) }}
            align="end"
            onSelect={(id) => { if (id === 'edit') onEdit(); else if (id === 'delete') onRemove() }}
            items={[{ id: 'edit', label: t('settings.budget.edit') }, { id: 'delete', label: t('settings.remove'), danger: true }]}
            anchor={<Button variant="ghost" size="sm" disabled={busy} aria-label={t('settings.more')} onClick={() => { setMenu(m => !m) }}>⋯</Button>}
          />
        </>
      )}
    />
  )
}

/** Budgets as rows with their progress; adding and editing happen in a dialog. */
export function BudgetsCard({ remote, generation = 0, budgetSpend, t }: {
  remote: BudgetsRemote
  generation?: number
  budgetSpend: Snapshot<Readonly<Record<string, Money>>>
  t: T
}): ReactNode {
  const spend = useSnapshot(budgetSpend)
  const [budgets, setBudgets] = useState<Budget[] | null | undefined>(undefined)
  const [dialog, setDialog] = useState<{ editing: Budget | null } | null>(null)
  const [workspaces, setWorkspaces] = useState<string[] | null>(null)
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

  // Workspaces seen in the ledger, read each time the dialog opens.
  useEffect(() => {
    if (dialog === null) return
    let live = true
    setWorkspaces(null)
    remote.query({ from: 0, to: Date.now() + 1, groupBy: 'workspace' }).then(
      (result) => { if (live) setWorkspaces(result.ok ? result.value.map(g => g.key).filter(k => k !== '') : []) },
      () => { if (live) setWorkspaces([]) },
    )
    return () => { live = false }
  }, [dialog, remote])

  const save = async (budget: Budget) => {
    const result = await remote.setBudget(budget)
    if (result.ok) await reload()
    return result
  }
  const remove = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await remote.removeBudget({ id })
      if (result.ok) await reload()
      else setError(result.error.message)
    } catch {
      setError(t('settings.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const list = budgets ?? []
  return (
    <SettingsCard title={t('settings.budgets')} tally="budgets">
      {budgets === null ? <SettingsRow label={<span className="dsh-tally-error" role="alert">{t('settings.loadFailed')}</span>} /> : null}
      {budgets !== undefined && budgets !== null && budgets.length === 0
        ? <SettingsRow label={<span className="dsh-tally-row-muted">{t('settings.budget.empty')}</span>} />
        : null}
      {list.map(budget => (
        <BudgetRow
          key={budget.id}
          budget={budget}
          spent={spend[budget.id] ?? { amount: '0', currency: budget.limit.currency }}
          busy={busy}
          onEdit={() => { setDialog({ editing: budget }) }}
          onRemove={() => { void remove(budget.id) }}
          t={t}
        />
      ))}
      <div className="dsh-tally-card-footer">
        <Button variant="outline" size="sm" onClick={() => { setDialog({ editing: null }) }}>{t('settings.budget.add')}</Button>
        {error === null ? null : <span className="dsh-tally-error" role="alert">{error}</span>}
      </div>
      <BudgetDialog
        open={dialog !== null}
        editing={dialog?.editing ?? null}
        existing={list}
        workspaces={workspaces}
        save={save}
        onClose={() => { setDialog(null) }}
        t={t}
      />
    </SettingsCard>
  )
}
