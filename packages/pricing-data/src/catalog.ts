import { readFileSync } from 'node:fs'
import type { PriceCatalog } from './types.js'
import { validateCatalog } from './validate.js'

/** Load and validate the bundled catalog. `../catalog.json` resolves from both `src/` and `lib/`. */
export function loadCatalog(): PriceCatalog {
  const data: unknown = JSON.parse(readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'))
  const errors = validateCatalog(data)
  if (errors.length) throw new Error(`Invalid price catalog:\n${errors.join('\n')}`)
  return data as PriceCatalog
}
