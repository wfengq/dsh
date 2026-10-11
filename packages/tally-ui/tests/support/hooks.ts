import { useSyncExternalStore } from 'react'

/** A writable observable, like a store snapshot. */
export function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The `use<Name>` selector hook the slot renderer derives from an observable. */
export function hookOf<T>(source: { getSnapshot(): T; subscribe(listener: () => void): () => void }) {
  return <S>(selector: (value: T) => S): S => selector(useSyncExternalStore(source.subscribe, source.getSnapshot))
}
