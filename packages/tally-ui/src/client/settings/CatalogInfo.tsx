import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'
import type { CatalogView } from 'dsh-tally-api'
import { isWebUrl, type T } from '../labels.ts'
import { SettingsCard, SettingsRow } from './Card.tsx'

/** Price data version and, per model, the date its price took effect and its source; the price version is a tooltip. */
export function CatalogInfo({ load, t }: { load: () => Promise<CatalogView | null>; t: T }): ReactNode {
  const [view, setView] = useState<CatalogView | null | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setView(undefined)
    load().then(next => { if (current) setView(next) }, () => { if (current) setView(null) })
    return () => { current = false }
  }, [load, attempt])
  const description = view
    ? <><span className="dsh-tally-block">{t('settings.catalogVersion', { version: view.version })}</span><span className="dsh-tally-block">{t('disclaimer')}</span></>
    : undefined
  return (
    <SettingsCard title={t('settings.catalog')} tally="catalog" description={description}>
      {view === undefined ? <SettingsRow label={<span className="dsh-tally-row-muted" role="status">{t('tab.loading')}</span>} /> : null}
      {view === null
        ? (
            <SettingsRow
              label={<span className="dsh-tally-error" role="alert">{t('settings.loadFailed')}</span>}
              control={<button type="button" className="dsh-tally-link" onClick={() => { setAttempt(n => n + 1) }}>{t('tab.retry')}</button>}
            />
          )
        : null}
      {view?.providers.flatMap(provider => provider.models.map(model => (
        <div key={`${provider.id}/${model.model}`} data-tally="catalog-row">
          <SettingsRow
            label={(
              <Tooltip label={`${t('settings.priceVersion')} ${model.priceVersion}`}>
                <span className="dsh-tally-model-name" tabIndex={0}>{model.model}</span>
              </Tooltip>
            )}
            hint={`${provider.id} · ${provider.currency}`}
            control={(
              <>
                <span className="dsh-tally-row-muted">{t('settings.effectiveOn', { date: model.effectiveFrom })}</span>
                {isWebUrl(model.source.url)
                  ? <a className="dsh-tally-link" href={model.source.url} target="_blank" rel="noreferrer noopener">{t('settings.source')}</a>
                  : <span className="dsh-tally-row-muted">{`${t('settings.source')}: ${model.source.url}`}</span>}
              </>
            )}
          />
        </div>
      )))}
    </SettingsCard>
  )
}
