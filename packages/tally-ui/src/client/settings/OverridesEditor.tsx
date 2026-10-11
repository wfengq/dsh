import { Button, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ReactNode } from 'react'
import type { Currency, ProviderPriceOverride } from 'dsh-tally-api'
import type { T } from '../labels.ts'
import { readonlyReason, useSnapshot, writeField, type FormFace } from './form.ts'

export type OverridesFace = FormFace<{ overrides?: ProviderPriceOverride[] }>

/** A rate is a plain non-negative decimal with at most twelve fraction digits. */
export const RATE_PATTERN = /^\d+(\.\d{1,12})?$/

type Kind = 'alias' | 'manual'

interface ModelRow {
  model: string
  input: string
  cacheRead: string
  cacheWrite: string
  output: string
}

const emptyRow = (): ModelRow => ({ model: '', input: '', cacheRead: '', cacheWrite: '', output: '' })

/** Builds the override from the form, or `null` when it is incomplete or a rate is malformed. */
function build(kind: Kind, route: string, alias: { provider: string; model: string }, currency: Currency, rows: ModelRow[]): ProviderPriceOverride | null {
  const provider = route.trim()
  if (provider === '') return null
  if (kind === 'alias') {
    const target = alias.provider.trim()
    if (target === '') return null
    const model = alias.model.trim()
    return { provider, kind, target: model === '' ? { provider: target } : { provider: target, model } }
  }
  const models: Record<string, { input: string; cacheRead?: string; cacheWrite?: string; output: string }> = {}
  for (const row of rows) {
    const name = row.model.trim()
    if (name === '' || name in models) return null
    if (!RATE_PATTERN.test(row.input) || !RATE_PATTERN.test(row.output)) return null
    if ((row.cacheRead !== '' && !RATE_PATTERN.test(row.cacheRead)) || (row.cacheWrite !== '' && !RATE_PATTERN.test(row.cacheWrite))) return null
    models[name] = {
      input: row.input,
      ...(row.cacheRead === '' ? {} : { cacheRead: row.cacheRead }),
      ...(row.cacheWrite === '' ? {} : { cacheWrite: row.cacheWrite }),
      output: row.output,
    }
  }
  return Object.keys(models).length === 0 ? null : { provider, kind, currency, models }
}

function summary(override: ProviderPriceOverride, t: T): string {
  if (override.kind === 'alias') {
    const { provider, model } = override.target
    return t('settings.override.aliasSummary', { route: override.provider, target: model === undefined ? provider : `${provider}/${model}` })
  }
  return t('settings.override.manualSummary', { route: override.provider, currency: override.currency, models: Object.keys(override.models).join(', ') })
}

/** Lists, adds and removes price overrides. Read-only, with the reason, when the config form cannot be written. */
export function OverridesEditor({ form, t }: { form: OverridesFace; t: T }): ReactNode {
  const view = useSnapshot(form)
  const reason = readonlyReason(view, 'settings.readonly.memory')
  const locked = reason !== null
  const current = view.value?.overrides ?? []
  const [kind, setKind] = useState<Kind>('alias')
  const [route, setRoute] = useState('')
  const [alias, setAlias] = useState({ provider: '', model: '' })
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [rows, setRows] = useState<ModelRow[]>([emptyRow()])
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const candidate = build(kind, route, alias, currency, rows)
  const write = async (next: ProviderPriceOverride[]): Promise<boolean> => {
    setBusy(true)
    setFailed(false)
    const accepted = await writeField(form, 'overrides', next)
    setBusy(false)
    if (!accepted) setFailed(true)
    return accepted
  }
  const save = async () => {
    if (candidate === null) return
    const accepted = await write([...current.filter(o => o.provider !== candidate.provider), candidate])
    if (accepted) {
      setRoute('')
      setAlias({ provider: '', model: '' })
      setRows([emptyRow()])
    }
  }
  const patchRow = (index: number, patch: Partial<ModelRow>) => { setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row))) }
  const rateField = (index: number, field: 'input' | 'cacheRead' | 'cacheWrite' | 'output', key: Parameters<T>[0], optional: boolean) => {
    const value = rows[index]![field]
    const invalid = value !== '' ? !RATE_PATTERN.test(value) : !optional
    return (
      <Input
        key={field}
        inputMode="decimal"
        aria-label={t(key)}
        placeholder={t(key)}
        aria-invalid={value !== '' && invalid}
        disabled={locked}
        value={value}
        onChange={event => { patchRow(index, { [field]: event.target.value }) }}
      />
    )
  }

  return (
    <section className="dsh-tally-settings-part" data-tally="overrides">
      <h3>{t('settings.overrides')}</h3>
      {reason !== null ? <p className="dsh-tally-hint" role="status">{t(reason)}</p> : null}
      {current.length === 0
        ? <p className="dsh-tally-hint">{t('settings.none')}</p>
        : (
            <ul className="dsh-tally-list">
              {current.map(override => (
                <li key={override.provider}>
                  <span>{summary(override, t)}</span>
                  <Button variant="ghost" size="sm" disabled={locked || busy} onClick={() => { void write(current.filter(o => o !== override)) }}>{t('settings.remove')}</Button>
                </li>
              ))}
            </ul>
          )}
      <div className="dsh-tally-form">
        <SegmentedControl
          id="dsh-tally-override-kind"
          label={t('settings.override.kind')}
          value={kind}
          disabled={locked}
          options={[{ value: 'alias', label: t('settings.override.alias') }, { value: 'manual', label: t('settings.override.manual') }]}
          onChange={setKind}
        />
        <Input aria-label={t('settings.override.route')} placeholder={t('settings.override.route')} disabled={locked} value={route} onChange={event => { setRoute(event.target.value) }} />
        {kind === 'alias'
          ? (
              <>
                <Input aria-label={t('settings.override.targetProvider')} placeholder={t('settings.override.targetProvider')} disabled={locked} value={alias.provider} onChange={event => { setAlias({ ...alias, provider: event.target.value }) }} />
                <Input aria-label={t('settings.override.targetModel')} placeholder={t('settings.override.targetModel')} disabled={locked} value={alias.model} onChange={event => { setAlias({ ...alias, model: event.target.value }) }} />
              </>
            )
          : (
              <>
                <SegmentedControl
                  id="dsh-tally-override-currency"
                  label={t('settings.currency')}
                  value={currency}
                  disabled={locked}
                  options={[{ value: 'CNY', label: 'CNY' }, { value: 'USD', label: 'USD' }]}
                  onChange={setCurrency}
                />
                <p className="dsh-tally-hint">{t('settings.override.rateHint')}</p>
                {rows.map((row, index) => (
                  <div key={index} className="dsh-tally-model-row">
                    <Input aria-label={t('settings.override.model')} placeholder={t('settings.override.model')} disabled={locked} value={row.model} onChange={event => { patchRow(index, { model: event.target.value }) }} />
                    {rateField(index, 'input', 'settings.override.rateInput', false)}
                    {rateField(index, 'cacheRead', 'settings.override.rateCacheRead', true)}
                    {rateField(index, 'cacheWrite', 'settings.override.rateCacheWrite', true)}
                    {rateField(index, 'output', 'settings.override.rateOutput', false)}
                    {rows.length > 1
                      ? <Button variant="ghost" size="sm" disabled={locked} onClick={() => { setRows(rows.filter((_, i) => i !== index)) }}>{t('settings.override.removeModel')}</Button>
                      : null}
                  </div>
                ))}
                <Button variant="outline" size="sm" disabled={locked} onClick={() => { setRows([...rows, emptyRow()]) }}>{t('settings.override.addModel')}</Button>
              </>
            )}
        <Button variant="primary" size="sm" disabled={locked || busy || candidate === null} onClick={() => { void save() }}>{t('settings.save')}</Button>
        {failed ? <p className="dsh-tally-error" role="alert">{t('settings.saveFailed')}</p> : null}
      </div>
    </section>
  )
}
