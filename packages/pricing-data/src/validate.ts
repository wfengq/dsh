import { parseDecimal } from './decimal.js'

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const RANGE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/
const BANDS = ['flat', 'peak', 'offpeak']
const RATE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output']

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkDecimal(v: unknown, where: string, errors: string[]): void {
  try {
    parseDecimal(v as string)
  } catch {
    errors.push(`${where}: invalid decimal ${JSON.stringify(v)}`)
  }
}

function checkInstant(v: unknown, where: string, errors: string[]): number | undefined {
  if (typeof v !== 'string' || !ISO_INSTANT.test(v) || Number.isNaN(Date.parse(v))) {
    errors.push(`${where}: expected ISO 8601 timestamp with explicit offset, got ${JSON.stringify(v)}`)
    return undefined
  }
  return Date.parse(v)
}

function checkSource(v: unknown, where: string, errors: string[]): void {
  if (!isObj(v)) return void errors.push(`${where}: missing`)
  if (typeof v.url !== 'string' || !v.url) errors.push(`${where}.url: required`)
  if (typeof v.retrievedAt !== 'string' || !v.retrievedAt) errors.push(`${where}.retrievedAt: required`)
  if (v.note !== undefined && typeof v.note !== 'string') errors.push(`${where}.note: must be a string`)
}

function checkWindows(v: unknown, where: string, errors: string[]): void {
  if (!isObj(v)) return void errors.push(`${where}: must be an object`)
  if (typeof v.tz !== 'string') errors.push(`${where}.tz: required`)
  else {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: v.tz })
    } catch {
      errors.push(`${where}.tz: unknown time zone ${JSON.stringify(v.tz)}`)
    }
  }
  if (!Array.isArray(v.peak)) errors.push(`${where}.peak: must be an array`)
  else {
    v.peak.forEach((r, i) => {
      const m = typeof r === 'string' ? RANGE.exec(r) : null
      if (!m) return void errors.push(`${where}.peak[${i}]: expected "HH:MM-HH:MM", got ${JSON.stringify(r)}`)
      const [sh, sm, eh, em] = m.slice(1).map(Number)
      const start = sh * 60 + sm
      const end = eh * 60 + em
      if (sh > 23 || eh > 24 || sm > 59 || em > 59 || start >= end) errors.push(`${where}.peak[${i}]: invalid range ${r}`)
    })
  }
  if (!Array.isArray(v.days) || !v.days.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) {
    errors.push(`${where}.days: must be an array of ISO weekdays 1-7`)
  }
  if (v.excludeHolidays !== undefined && typeof v.excludeHolidays !== 'string') errors.push(`${where}.excludeHolidays: must be a string`)
}

function checkRates(v: unknown, where: string, errors: string[]): void {
  if (!isObj(v)) return void errors.push(`${where}: must be an object`)
  const keys = Object.keys(v)
  if (!keys.length) errors.push(`${where}: at least one band is required`)
  for (const band of keys) {
    if (!BANDS.includes(band)) {
      errors.push(`${where}.${band}: unknown band`)
      continue
    }
    const r = v[band]
    if (!isObj(r)) {
      errors.push(`${where}.${band}: must be an object`)
      continue
    }
    for (const k of Object.keys(r)) if (!RATE_KEYS.includes(k)) errors.push(`${where}.${band}.${k}: unknown field`)
    for (const k of ['input', 'output']) {
      if (r[k] === undefined) errors.push(`${where}.${band}.${k}: required`)
    }
    for (const k of RATE_KEYS) if (r[k] !== undefined) checkDecimal(r[k], `${where}.${band}.${k}`, errors)
  }
}

function checkTiers(v: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(v)) return void errors.push(`${where}: must be an array`)
  v.forEach((t, i) => {
    if (!isObj(t) || !Number.isSafeInteger(t.minInputTokens) || (t.minInputTokens as number) < 0) {
      return void errors.push(`${where}[${i}].minInputTokens: must be a non-negative integer`)
    }
    checkDecimal(t.multiplier, `${where}[${i}].multiplier`, errors)
  })
}

function checkModel(model: string, versions: unknown, where: string, ids: Set<string>, errors: string[]): void {
  if (!Array.isArray(versions) || !versions.length) return void errors.push(`${where}: must be a non-empty array`)
  const spans: { from: number; to: number; id: string }[] = []
  versions.forEach((v, i) => {
    const w = `${where}[${i}]`
    if (!isObj(v)) return void errors.push(`${w}: must be an object`)
    if (typeof v.id !== 'string' || !v.id) errors.push(`${w}.id: required`)
    else if (ids.has(v.id)) errors.push(`${w}.id: duplicate version id ${v.id}`)
    else ids.add(v.id)
    const from = checkInstant(v.effectiveFrom, `${w}.effectiveFrom`, errors)
    const to = v.effectiveTo === undefined ? Infinity : checkInstant(v.effectiveTo, `${w}.effectiveTo`, errors)
    if (from !== undefined && to !== undefined) {
      if (to <= from) errors.push(`${w}: effectiveTo must be after effectiveFrom`)
      spans.push({ from, to, id: String(v.id) })
    }
    if (v.windows !== undefined) checkWindows(v.windows, `${w}.windows`, errors)
    checkRates(v.rates, `${w}.rates`, errors)
    if (v.tiers !== undefined) checkTiers(v.tiers, `${w}.tiers`, errors)
    checkSource(v.source, `${w}.source`, errors)
  })
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from < spans[i - 1].from) errors.push(`${where}: versions must be sorted by effectiveFrom ascending`)
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i].from < spans[j].to && spans[j].from < spans[i].to) {
        errors.push(`${where}: versions ${spans[i].id} and ${spans[j].id} of model ${model} overlap`)
      }
    }
  }
}

/** Returns a list of problems; an empty list means the catalog is valid. */
export function validateCatalog(c: unknown): string[] {
  const errors: string[] = []
  if (!isObj(c)) return ['catalog: must be an object']
  if (c.schemaVersion !== 1) errors.push('schemaVersion: must be 1')
  if (typeof c.generatedAt !== 'string') errors.push('generatedAt: required')

  if (!isObj(c.providers)) errors.push('providers: must be an object')
  else {
    const ids = new Set<string>()
    for (const [name, p] of Object.entries(c.providers)) {
      const where = `providers.${name}`
      if (!isObj(p)) {
        errors.push(`${where}: must be an object`)
        continue
      }
      if (p.currency !== 'CNY' && p.currency !== 'USD') errors.push(`${where}.currency: must be CNY or USD`)
      if (p.unit !== 'per_million_tokens') errors.push(`${where}.unit: must be per_million_tokens`)
      if (p.reasoningBilledAs === 'separate') {
        // Reasoning tokens are already part of outputTokens, so billing them again would
        // double-count; a separate reasoning rate needs its own semantics first.
        errors.push(`${where}.reasoningBilledAs: "separate" is not supported yet (reasoning tokens are part of outputTokens and would be billed twice); use "output" or "free"`)
      } else if (!['output', 'free'].includes(p.reasoningBilledAs as string)) {
        errors.push(`${where}.reasoningBilledAs: must be output or free`)
      }
      const models = isObj(p.models) ? p.models : undefined
      if (!models) errors.push(`${where}.models: must be an object`)
      else for (const [m, versions] of Object.entries(models)) checkModel(m, versions, `${where}.models.${m}`, ids, errors)
      if (p.aliases !== undefined) {
        if (!isObj(p.aliases)) errors.push(`${where}.aliases: must be an object`)
        else {
          for (const [alias, target] of Object.entries(p.aliases)) {
            if (typeof target !== 'string' || !models || !Object.hasOwn(models, target)) {
              errors.push(`${where}.aliases.${alias}: target ${JSON.stringify(target)} is not a model of this provider`)
            }
            if (models && Object.hasOwn(models, alias)) errors.push(`${where}.aliases.${alias}: shadows a model of the same name`)
          }
        }
      }
    }
  }

  if (!isObj(c.holidays)) errors.push('holidays: must be an object')
  else {
    for (const [id, cal] of Object.entries(c.holidays)) {
      if (!isObj(cal) || !isObj(cal.years)) {
        errors.push(`holidays.${id}.years: must be an object`)
        continue
      }
      for (const [year, y] of Object.entries(cal.years)) {
        const where = `holidays.${id}.years.${year}`
        if (!isObj(y)) {
          errors.push(`${where}: must be an object`)
          continue
        }
        if (!Array.isArray(y.dates) || !y.dates.every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d.startsWith(`${year}-`))) {
          errors.push(`${where}.dates: must be YYYY-MM-DD strings within ${year}`)
        }
        checkSource(y.source, `${where}.source`, errors)
      }
    }
  }
  return errors
}
