/** Shared helpers of the settings section: reading a config form and the reasons it can be read-only. */
import { useCallback, useSyncExternalStore } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { TallyLocaleKey } from '../locales.ts'
import type { Snapshot } from '../store.ts'

/** The part of a `ConfigFormSnapshot` the settings section reads. */
export interface FormView<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/** One field write of a `ConfigForm` mutation: `path` walks into nested objects of the section. */
export type SetOp = Extract<SettingsPathOpView, { op: 'set' }>

/** The part of a `ConfigForm` the settings section uses. */
export interface FormFace<T> extends Snapshot<FormView<T>> {
  mutate(ops: readonly SetOp[]): Promise<boolean>
}

/**
 * Reads a snapshot source. The host's `ConfigForm` is a class whose methods use `this`, so they
 * are called on the source rather than handed to React unbound.
 */
export function useSnapshot<T>(source: Snapshot<T>): T {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const getSnapshot = useCallback(() => source.getSnapshot(), [source])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Why a form cannot be edited, or `null` when it can. Memory mode is the most specific cause. */
export function readonlyReason(view: FormView<unknown>, memoryKey: TallyLocaleKey = 'settings.readonly.memoryGeneric'): TallyLocaleKey | null {
  if (view.mode === 'memory') return memoryKey
  if (view.status !== 'ready') return 'settings.readonly.unavailable'
  if (!view.writable) return 'settings.readonly.notWritable'
  return null
}

/**
 * Writes one field; a refusal or a transport failure both count as failed. A nested field is
 * named by its path segments (`['elements', 'turnTail']`): the host's `set(field)` takes a single
 * key and would treat a dotted name as one literal key.
 */
export async function writeField(form: FormFace<unknown>, path: readonly string[], value: unknown): Promise<boolean> {
  try {
    // Every value written here is plain JSON (booleans, decimal strings, objects of them).
    return await form.mutate([{ op: 'set', path: [...path], value: value as SetOp['value'] }])
  } catch {
    return false
  }
}
