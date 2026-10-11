/** Shared helpers of the settings section: reading a config form and the reasons it can be read-only. */
import { useSyncExternalStore } from 'react'
import type { TallyLocaleKey } from '../locales.ts'
import type { Snapshot } from '../store.ts'

/** The part of a `ConfigFormSnapshot` the settings section reads. */
export interface FormView<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/** The part of a `ConfigForm` the settings section uses. */
export interface FormFace<T> extends Snapshot<FormView<T>> {
  set(field: string, value: unknown): Promise<boolean>
}

export function useSnapshot<T>(source: Snapshot<T>): T {
  return useSyncExternalStore(source.subscribe, source.getSnapshot)
}

/** Why a form cannot be edited, or `null` when it can. Memory mode is the most specific cause. */
export function readonlyReason(view: FormView<unknown>, memoryKey: TallyLocaleKey = 'settings.readonly.memoryGeneric'): TallyLocaleKey | null {
  if (view.mode === 'memory') return memoryKey
  if (view.status !== 'ready') return 'settings.readonly.unavailable'
  if (!view.writable) return 'settings.readonly.notWritable'
  return null
}

/** Runs a form write; a refusal or a transport failure both count as failed. */
export async function writeField(form: FormFace<unknown>, field: string, value: unknown): Promise<boolean> {
  try {
    return await form.set(field, value)
  } catch {
    return false
  }
}
