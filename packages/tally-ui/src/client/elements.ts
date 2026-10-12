/** The element switches of the Host Config (`elements.*` of `dsh-tally-ui`), as the browser reads them. */
import type { Snapshot } from './store.ts'

export type ElementName = 'composerDock' | 'turnTail' | 'headerUtilities' | 'sidebarTab' | 'budgetToast'
export type Elements = Readonly<Record<ElementName, boolean>>

export const ALL_ELEMENTS: Elements = {
  composerDock: true, turnTail: true, headerUtilities: true, sidebarTab: true, budgetToast: true,
}

/** The part of a `ConfigForm` snapshot this module reads. */
export interface ElementsFormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: { elements?: Partial<Record<ElementName, boolean>> } | undefined
}

/**
 * Derives the switches from the plugin's config form. While the form is loading or unavailable,
 * or a switch is missing, the element counts as enabled (the schema default). The result keeps
 * its identity until a switch actually changes.
 */
export function elementsOf(form: Snapshot<ElementsFormSnapshot>): Snapshot<Elements> {
  let source: ElementsFormSnapshot | undefined
  let current = ALL_ELEMENTS
  const read = (): Elements => {
    const next = form.getSnapshot()
    if (next === source) return current
    source = next
    const raw = next.status === 'ready' ? next.value?.elements ?? {} : {}
    const derived = { ...ALL_ELEMENTS }
    for (const name of Object.keys(ALL_ELEMENTS) as ElementName[]) derived[name] = raw[name] !== false
    if ((Object.keys(derived) as ElementName[]).some(name => derived[name] !== current[name])) current = derived
    return current
  }
  return { getSnapshot: read, subscribe: listener => form.subscribe(listener) }
}
