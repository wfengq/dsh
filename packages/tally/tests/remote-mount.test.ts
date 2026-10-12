import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { mountTallyRemote, TALLY_REMOTE } from '../src/remote/contract.js'

type Registry = { remotes: { register(c: TypertRemoteContribution): () => void; list(): unknown[] } }

async function registry(): Promise<Registry> {
  const root = new Context()
  await root.plugin(TypertRegistry)
  return (root as unknown as { typert: Registry }).typert
}

/**
 * Mirrors the browser's `ctx.remote` (`dsh-api-gateway/lib/client.js`, `$mount` → `mountContribution`):
 * mounts are serialized; `validateContribution` runs first and throws
 * `client api: direct method <ns>/<method> is already mounted` for a method a namespace already
 * has; only then is the contribution registered with the Typert registry (here the real one), and
 * each namespace becomes the service `remote.<namespace>`.
 */
function gatewayClient(typert: Registry) {
  const namespaces = new Map<string, Set<string>>()
  let mutations: Promise<unknown> = Promise.resolve()
  const mounts: string[] = []
  const remote = {
    $mount(contribution: TypertRemoteContribution) {
      const run = mutations.then(() => {
        for (const d of contribution.descriptors) {
          if (namespaces.get(d.namespace)?.has(d.method)) throw new Error(`client api: direct method ${d.namespace}/${d.method} is already mounted`)
        }
        typert.remotes.register(contribution)
        for (const d of contribution.descriptors) {
          const methods = namespaces.get(d.namespace) ?? new Set<string>()
          methods.add(d.method)
          namespaces.set(d.namespace, methods)
        }
        mounts.push(contribution.package)
      })
      mutations = run.catch(() => {})
      return run
    },
  }
  /** One plugin's context; `withGet: false` stands for a lookup that has not seen the namespace yet. */
  const plugin = (withGet = true) => ({
    remote,
    ...withGet ? { get: (name: string) => (name.startsWith('remote.') && namespaces.has(name.slice(7)) ? {} : undefined) } : {},
  })
  return { plugin, mounts }
}

describe('mountTallyRemote', () => {
  it('skips the mount when the tally namespace service already exists', async () => {
    const client = gatewayClient(await registry())
    expect(await mountTallyRemote(client.plugin())).toBe(true)
    expect(await mountTallyRemote(client.plugin())).toBe(false)
    expect(client.mounts).toEqual(['dsh-tally'])
  })

  it('tolerates the gateway client\'s duplicate-mount error, which comes before the registry check', async () => {
    const client = gatewayClient(await registry())
    expect(await mountTallyRemote(client.plugin(false))).toBe(true)
    // A plain second `$mount` fails with the gateway text, not the registry one.
    await expect(client.plugin(false).remote.$mount(TALLY_REMOTE)).rejects.toThrow(/^client api: direct method tally\/\w+ is already mounted$/)
    expect(await mountTallyRemote(client.plugin(false))).toBe(false)
  })

  it('tolerates two plugins mounting concurrently', async () => {
    const client = gatewayClient(await registry())
    expect(await Promise.all([mountTallyRemote(client.plugin()), mountTallyRemote(client.plugin())])).toEqual([true, false])
    expect(client.mounts).toEqual(['dsh-tally'])
  })

  it('tolerates the registry\'s duplicate-package error', async () => {
    const typert = await registry()
    const plugin = () => ({ remote: { $mount: async (c: TypertRemoteContribution) => typert.remotes.register(c) } })
    expect(await mountTallyRemote(plugin())).toBe(true)
    await expect(plugin().remote.$mount(TALLY_REMOTE)).rejects.toThrow('Remote package "dsh-tally" is already registered')
    expect(await mountTallyRemote(plugin())).toBe(false)
    expect(typert.remotes.list()).toHaveLength(TALLY_REMOTE.descriptors.length)
  })

  it('rethrows any other mount failure', async () => {
    const failing = { remote: { $mount: async () => { throw new Error('client api: direct method other/x is already mounted') } } }
    await expect(mountTallyRemote(failing)).rejects.toThrow('other/x')
    const sync = { remote: { $mount: () => { throw new Error('boom') } } }
    await expect(mountTallyRemote(sync)).rejects.toThrow('boom')
  })
})
