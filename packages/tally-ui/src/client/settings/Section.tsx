import { useCallback, type ReactNode } from 'react'
import type { CatalogView, TallyStatusView } from 'dsh-tally-api'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { T } from '../labels.ts'
import type { Snapshot } from '../store.ts'
import { BudgetsEditor, type BudgetsRemote } from './BudgetsEditor.tsx'
import { CatalogInfo } from './CatalogInfo.tsx'
import { ElementSwitches, type ElementsFace } from './ElementSwitches.tsx'
import { OverridesEditor, type OverridesFace } from './OverridesEditor.tsx'
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
}

export type SectionProps = SectionInjected & { close: () => void; t: T }

/** Usage and cost page of the settings panel. */
export function Section({ remote, overridesForm, elementsForm, status, t }: SectionProps): ReactNode {
  const load = useCallback(async () => {
    const result = await remote.catalog()
    return result.ok ? result.value : null
  }, [remote])
  return (
    <div className="dsh-tally-settings" data-tally="settings">
      <CatalogInfo load={load} t={t} />
      <OverridesEditor form={overridesForm} t={t} />
      <BudgetsEditor remote={remote} t={t} />
      <ElementSwitches form={elementsForm} t={t} />
      <RebuildButton rebuild={() => remote.rebuild()} status={status} t={t} />
    </div>
  )
}
