import { useCallback, type ReactNode } from 'react'
import type { CatalogView, Money, TallyStatusView } from 'dsh-tally-api'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { T } from '../labels.ts'
import type { Snapshot } from '../store.ts'
import { BudgetsCard, type BudgetsRemote } from './BudgetsCard.tsx'
import { CatalogInfo } from './CatalogInfo.tsx'
import { ElementSwitches, type ElementsFace } from './ElementSwitches.tsx'
import { useSnapshot } from './form.ts'
import { OverridesEditor, type OverridesFace } from './OverridesEditor.tsx'
import { Problems } from './Problems.tsx'
import { RebuildButton } from './RebuildButton.tsx'
import './settings.css'

/** The `tally` Remote methods the settings page calls. */
export interface SettingsRemote extends BudgetsRemote {
  catalog(): Promise<RemoteResult<CatalogView>>
  rebuild(): Promise<RemoteResult<void>>
}

/** What the registration hands the section. */
export interface SectionInjected {
  remote: SettingsRemote
  overridesForm: OverridesFace
  elementsForm: ElementsFace
  status: Snapshot<TallyStatusView | null>
  /** The store's `hello` count: the catalog and budgets are read again when it changes. */
  generation: Snapshot<number>
  /** The store's per-budget spend over each budget's current period. */
  budgetSpend: Snapshot<Readonly<Record<string, Money>>>
}

export type SectionProps = SectionInjected & { close: () => void; t: T }

/** Usage and cost page of the settings panel. */
export function Section({ remote, overridesForm, elementsForm, status, generation, budgetSpend, t }: SectionProps): ReactNode {
  const hello = useSnapshot(generation)
  // A new `hello` gives a new loader, which CatalogInfo and BudgetsCard key their loads on.
  const load = useCallback(async () => {
    const result = await remote.catalog()
    return result.ok ? result.value : null
  }, [remote, hello])
  return (
    <div className="dsh-tally-settings" data-tally="settings">
      <BudgetsCard remote={remote} generation={hello} budgetSpend={budgetSpend} t={t} />
      <ElementSwitches form={elementsForm} t={t} />
      <Problems status={status} t={t} />
      <CatalogInfo load={load} t={t} />
      <OverridesEditor form={overridesForm} t={t} />
      <RebuildButton rebuild={() => remote.rebuild()} status={status} t={t} />
    </div>
  )
}
