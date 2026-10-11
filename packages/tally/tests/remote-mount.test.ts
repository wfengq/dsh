import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { mountTallyRemote, TALLY_REMOTE } from '../src/remote/contract.js'

/**
 * The browser's `ctx.remote.$mount` registers the contribution with the client copy of the Typert
 * registry, which shares this registry's package bookkeeping and error text. A plugin context whose
 * `$mount` registers with the real (Host) registry therefore behaves like a second client plugin.
 */
async function registryContext() {
  const root = new Context()
  await root.plugin(TypertRegistry)
  const typert = (root as unknown as { typert: { remotes: { register(c: TypertRemoteContribution): () => void; list(): unknown[] } } }).typert
  const pluginContext = () => ({ remote: { $mount: async (c: TypertRemoteContribution) => typert.remotes.register(c) } })
  return { typert, pluginContext }
}

describe('mountTallyRemote', () => {
  it('mounts the namespace once and tolerates a second plugin mounting it again', async () => {
    const { typert, pluginContext } = await registryContext()
    const first = pluginContext()
    const second = pluginContext()
    expect(await mountTallyRemote(first)).toBe(true)
    // A plain second `$mount` fails exactly the way the helper tolerates.
    await expect(second.remote.$mount(TALLY_REMOTE)).rejects.toThrow('Remote package "dsh-tally" is already registered')
    expect(await mountTallyRemote(second)).toBe(false)
    expect(typert.remotes.list()).toHaveLength(TALLY_REMOTE.descriptors.length)
  })

  it('rethrows any other mount failure', async () => {
    const failing = { remote: { $mount: async () => { throw new Error('typert: Remote package name is invalid') } } }
    await expect(mountTallyRemote(failing)).rejects.toThrow('is invalid')
    const sync = { remote: { $mount: () => { throw new Error('boom') } } }
    await expect(mountTallyRemote(sync)).rejects.toThrow('boom')
  })
})
