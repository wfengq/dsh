import fs from 'node:fs'
const cat = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).plugins
const out = process.argv[3]
const names = [...new Set(cat.filter(p => p.npm).map(p => p.npm))]
const res = {}
let i = 0
async function worker() {
  while (i < names.length) {
    const n = names[i++]
    try {
      const r = await fetch('https://registry.npmjs.org/' + n.replace('/', '%2F') + '/latest', { signal: AbortSignal.timeout(20000) })
      if (!r.ok) { res[n] = { err: r.status }; continue }
      const j = await r.json()
      res[n] = { version: j.version, deps: j.dependencies || {}, peer: j.peerDependencies || {}, dsh: j.dsh || null, unpacked: j.dist?.unpackedSize ?? null }
    } catch (e) { res[n] = { err: String(e).slice(0, 80) } }
  }
}
await Promise.all(Array.from({ length: 24 }, worker))
fs.writeFileSync(out, JSON.stringify(res))
console.log('fetched', Object.keys(res).length, 'errors', Object.values(res).filter(v => v.err).length)
