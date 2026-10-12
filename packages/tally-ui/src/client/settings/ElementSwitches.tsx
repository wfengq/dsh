import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ReactNode } from 'react'
import { ALL_ELEMENTS, type ElementName } from '../elements.ts'
import type { T } from '../labels.ts'
import { SettingsCard, SettingsRow } from './Card.tsx'
import { readonlyReason, useSnapshot, writeField, type FormFace } from './form.ts'

export type ElementsFace = FormFace<{ elements?: Partial<Record<ElementName, boolean>> }>

const NAMES = Object.keys(ALL_ELEMENTS) as ElementName[]

/** One switch per conversation element, read from and written to `elements.*` of the plugin's config. */
export function ElementSwitches({ form, t }: { form: ElementsFace; t: T }): ReactNode {
  const view = useSnapshot(form)
  const reason = readonlyReason(view)
  const [pending, setPending] = useState<ElementName | null>(null)
  const [failed, setFailed] = useState(false)
  const toggle = async (name: ElementName, next: boolean) => {
    setPending(name)
    setFailed(false)
    const accepted = await writeField(form, ['elements', name], next)
    setPending(null)
    if (!accepted) setFailed(true)
  }
  return (
    <SettingsCard
      title={t('settings.elements')}
      tally="elements"
      description={reason === null ? undefined : <span role="status">{t(reason)}</span>}
    >
      {NAMES.map(name => (
        <SettingsRow
          key={name}
          label={t(`settings.element.${name}`)}
          hint={t(`settings.element.${name}.hint`)}
          control={(
            <Switch
              checked={view.value?.elements?.[name] !== false}
              label={t(`settings.element.${name}`)}
              disabled={reason !== null || pending === name}
              title={reason === null ? undefined : t(reason)}
              onChange={next => { void toggle(name, next) }}
            />
          )}
        />
      ))}
      {failed ? <SettingsRow label={<span className="dsh-tally-error" role="alert">{t('settings.saveFailed')}</span>} /> : null}
    </SettingsCard>
  )
}
