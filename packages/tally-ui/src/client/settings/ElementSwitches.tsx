import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ReactNode } from 'react'
import { ALL_ELEMENTS, type ElementName } from '../elements.ts'
import type { T } from '../labels.ts'
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
    <section className="dsh-tally-settings-part" data-tally="elements">
      <h3>{t('settings.elements')}</h3>
      {reason !== null ? <p className="dsh-tally-hint" role="status">{t(reason)}</p> : null}
      <ul className="dsh-tally-list">
        {NAMES.map(name => (
          <li key={name}>
            <span>{t(`settings.element.${name}`)}</span>
            <Switch
              checked={view.value?.elements?.[name] !== false}
              label={t(`settings.element.${name}`)}
              disabled={reason !== null || pending === name}
              title={reason === null ? undefined : t(reason)}
              onChange={next => { void toggle(name, next) }}
            />
          </li>
        ))}
      </ul>
      {failed ? <p className="dsh-tally-error" role="alert">{t('settings.saveFailed')}</p> : null}
    </section>
  )
}
