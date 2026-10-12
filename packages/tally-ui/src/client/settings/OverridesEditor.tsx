import { Button, Input, Menu, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { CatalogView, Currency, ProviderPriceOverride, TallyStatusView } from 'dsh-tally-api'
import type { T } from '../labels.ts'
import type { Snapshot } from '../store.ts'
import { SettingsCard, SettingsRow } from './Card.tsx'
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

/** A button that opens a menu of choices; `items` are `{ id, label }`. */
function Picker({ value, placeholder, items, onPick, disabled }: {
  value: string | null
  placeholder: string
  items: readonly { id: string; label: string }[]
  onPick: (id: string) => void
  disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      onSelect={onPick}
      items={items}
      anchor={<Button variant="outline" size="sm" disabled={disabled} onClick={() => { setOpen(o => !o) }}>{value ?? placeholder}</Button>}
    />
  )
}

/** Adds one override; saving replaces an override of the same route. Stays open, with the reason, on a refusal. */
function OverrideDialog({ open, onClose, routes, catalog, save, t }: {
  open: boolean
  onClose: () => void
  routes: readonly string[]
  catalog: CatalogView | null
  save: (override: ProviderPriceOverride) => Promise<boolean>
  t: T
}): ReactNode {
  const [kind, setKind] = useState<Kind>('alias')
  const [route, setRoute] = useState('')
  const [alias, setAlias] = useState({ provider: '', model: '' })
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [rows, setRows] = useState<ModelRow[]>([emptyRow()])
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setKind('alias')
    setRoute('')
    setAlias({ provider: '', model: '' })
    setCurrency('CNY')
    setRows([emptyRow()])
    setFailed(false)
  }, [open])

  const candidate = build(kind, route, alias, currency, rows)
  const providers = catalog?.providers ?? []
  const models = providers.find(p => p.id === alias.provider)?.models ?? []
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
        value={value}
        onChange={event => { patchRow(index, { [field]: event.target.value }) }}
      />
    )
  }
  const submit = async () => {
    if (candidate === null) return
    setBusy(true)
    setFailed(false)
    const accepted = await save(candidate)
    setBusy(false)
    if (accepted) onClose()
    else setFailed(true)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('settings.override.add')}
      closeLabel={t('settings.cancel')}
      footer={(
        <div className="dsh-tally-dialog-actions">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('settings.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={busy || candidate === null} onClick={() => { void submit() }}>{t('settings.save')}</Button>
        </div>
      )}
    >
      <div className="dsh-tally-dialog" data-tally="override-dialog">
        <p className="dsh-tally-card-description">{t('settings.override.purpose')}</p>
        <div className="dsh-tally-field">
          <span className="dsh-tally-field-label">{t('settings.override.route')}</span>
          {routes.length === 0
            ? <p className="dsh-tally-row-muted">{t('settings.override.noRoutes')}</p>
            : <Picker value={route === '' ? null : route} placeholder={t('settings.override.pickRoute')} items={routes.map(r => ({ id: r, label: r }))} onPick={setRoute} />}
        </div>
        <SegmentedControl
          id="dsh-tally-override-kind"
          label={t('settings.override.kind')}
          value={kind}
          options={[{ value: 'alias', label: t('settings.override.alias') }, { value: 'manual', label: t('settings.override.manual') }]}
          onChange={setKind}
        />
        {kind === 'alias'
          ? (
              <div className="dsh-tally-field">
                <span className="dsh-tally-field-label">{t('settings.override.targetProvider')}</span>
                <div className="dsh-tally-amount">
                  <Picker
                    value={alias.provider === '' ? null : alias.provider}
                    placeholder={t('settings.override.pickProvider')}
                    items={providers.map(p => ({ id: p.id, label: p.id }))}
                    onPick={(id) => { setAlias({ provider: id, model: '' }) }}
                  />
                  <Picker
                    value={alias.model === '' ? null : alias.model}
                    placeholder={t('settings.override.anyModel')}
                    disabled={alias.provider === ''}
                    items={[{ id: '', label: t('settings.override.anyModel') }, ...models.map(m => ({ id: m.model, label: m.model }))]}
                    onPick={(id) => { setAlias({ ...alias, model: id }) }}
                  />
                </div>
              </div>
            )
          : (
              <div className="dsh-tally-field">
                <SegmentedControl
                  id="dsh-tally-override-currency"
                  label={t('settings.currency')}
                  value={currency}
                  options={[{ value: 'CNY', label: 'CNY' }, { value: 'USD', label: 'USD' }]}
                  onChange={setCurrency}
                />
                <p className="dsh-tally-row-muted">{t('settings.override.rateHint')}</p>
                {rows.map((row, index) => (
                  <div key={index} className="dsh-tally-model-row">
                    <Input aria-label={t('settings.override.model')} placeholder={t('settings.override.model')} value={row.model} onChange={event => { patchRow(index, { model: event.target.value }) }} />
                    {rateField(index, 'input', 'settings.override.rateInput', false)}
                    {rateField(index, 'cacheRead', 'settings.override.rateCacheRead', true)}
                    {rateField(index, 'cacheWrite', 'settings.override.rateCacheWrite', true)}
                    {rateField(index, 'output', 'settings.override.rateOutput', false)}
                    {rows.length > 1
                      ? <Button variant="ghost" size="sm" onClick={() => { setRows(rows.filter((_, i) => i !== index)) }}>{t('settings.override.removeModel')}</Button>
                      : null}
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => { setRows([...rows, emptyRow()]) }}>{t('settings.override.addModel')}</Button>
              </div>
            )}
        {failed ? <p className="dsh-tally-error" role="alert">{t('settings.saveFailed')}</p> : null}
      </div>
    </Modal>
  )
}

function OverrideRow({ override, onRemove, disabled, t }: { override: ProviderPriceOverride; onRemove: () => void; disabled: boolean; t: T }): ReactNode {
  const [menu, setMenu] = useState(false)
  return (
    <div data-tally="override-row">
      <SettingsRow
        label={summary(override, t)}
        control={(
          <Menu
            open={menu}
            onClose={() => { setMenu(false) }}
            align="end"
            onSelect={(id) => { if (id === 'delete') onRemove() }}
            items={[{ id: 'delete', label: t('settings.remove'), danger: true }]}
            anchor={<Button variant="ghost" size="sm" disabled={disabled} aria-label={t('settings.more')} onClick={() => { setMenu(m => !m) }}>⋯</Button>}
          />
        )}
      />
    </div>
  )
}

/** Lists price overrides and adds them through a dialog. Read-only, with the reason, when the config form cannot be written. */
export function OverridesEditor({ form, status, loadCatalog, t }: {
  form: OverridesFace
  status: Snapshot<TallyStatusView | null>
  loadCatalog: () => Promise<CatalogView | null>
  t: T
}): ReactNode {
  const view = useSnapshot(form)
  const routes = useSnapshot(status)?.routes ?? []
  const reason = readonlyReason(view, 'settings.readonly.memory')
  const locked = reason !== null
  const current = view.value?.overrides ?? []
  const [dialog, setDialog] = useState(false)
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!dialog) return
    let live = true
    loadCatalog().then(next => { if (live) setCatalog(next) }, () => { if (live) setCatalog(null) })
    return () => { live = false }
  }, [dialog, loadCatalog])

  const write = async (next: ProviderPriceOverride[]): Promise<boolean> => {
    setBusy(true)
    setFailed(false)
    const accepted = await writeField(form, ['overrides'], next)
    setBusy(false)
    if (!accepted) setFailed(true)
    return accepted
  }

  return (
    <SettingsCard
      title={t('settings.overrides')}
      tally="overrides"
      description={reason === null ? undefined : <span role="status">{t(reason)}</span>}
    >
      {current.length === 0 ? <SettingsRow label={<span className="dsh-tally-row-muted">{t('settings.none')}</span>} /> : null}
      {current.map(override => (
        <OverrideRow key={override.provider} override={override} disabled={locked || busy} onRemove={() => { void write(current.filter(o => o !== override)) }} t={t} />
      ))}
      <div className="dsh-tally-card-footer">
        <Button variant="outline" size="sm" disabled={locked} onClick={() => { setDialog(true) }}>{t('settings.override.add')}</Button>
        {failed && !dialog ? <span className="dsh-tally-error" role="alert">{t('settings.saveFailed')}</span> : null}
      </div>
      <OverrideDialog
        open={dialog}
        onClose={() => { setDialog(false) }}
        routes={routes}
        catalog={catalog}
        save={candidate => write([...current.filter(o => o.provider !== candidate.provider), candidate])}
        t={t}
      />
    </SettingsCard>
  )
}
