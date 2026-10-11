import { useEffect, useState, type ReactNode } from 'react'
import type { CatalogView } from 'dsh-tally-api'
import { isWebUrl, type T } from '../labels.ts'

/** Price data version and, per model, the price version in effect with its date and source. */
export function CatalogInfo({ load, t }: { load: () => Promise<CatalogView | null>; t: T }): ReactNode {
  const [view, setView] = useState<CatalogView | null | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setView(undefined)
    load().then(next => { if (current) setView(next) }, () => { if (current) setView(null) })
    return () => { current = false }
  }, [load, attempt])
  return (
    <section className="dsh-tally-settings-part" data-tally="catalog">
      <h3>{t('settings.catalog')}</h3>
      {view === undefined ? <p className="dsh-tally-hint" role="status">{t('tab.loading')}</p> : null}
      {view === null
        ? (
            <p className="dsh-tally-error" role="alert">
              {t('settings.loadFailed')}
              {' '}
              <button type="button" className="dsh-tally-link" onClick={() => { setAttempt(n => n + 1) }}>{t('tab.retry')}</button>
            </p>
          )
        : null}
      {view
        ? (
            <>
              <p>{t('settings.catalogVersion', { version: view.version })}</p>
              {view.providers.map(provider => (
                <div key={provider.id} className="dsh-tally-catalog-provider">
                  <h4>{`${provider.id} (${provider.currency})`}</h4>
                  <ul className="dsh-tally-list">
                    {provider.models.map(model => (
                      <li key={model.model}>
                        <strong>{model.model}</strong>
                        <span className="dsh-tally-meta">
                          {t('settings.priceVersion')}
                          {' '}
                          <span>{model.priceVersion}</span>
                        </span>
                        <span className="dsh-tally-meta">
                          {t('settings.effectiveFrom')}
                          {' '}
                          <span>{model.effectiveFrom}</span>
                        </span>
                        {isWebUrl(model.source.url)
                          ? <a className="dsh-tally-meta" href={model.source.url} target="_blank" rel="noreferrer noopener">{t('settings.source')}</a>
                          : <span className="dsh-tally-meta">{`${t('settings.source')}: ${model.source.url}`}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="dsh-tally-hint">{t('disclaimer')}</p>
            </>
          )
        : null}
    </section>
  )
}
