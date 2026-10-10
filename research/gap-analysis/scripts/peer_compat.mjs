// Share of npm-published catalog plugins whose declared @deepseek-ai peer ranges
// exclude the versions shipped by the current stable dsh (0.2.0-rc.2 on 2026-10-10).
// Usage: node peer_compat.mjs deps.json   (needs `semver` installed next to this script)
import fs from 'node:fs'
import { createRequire } from 'node:module'
const semver = createRequire(import.meta.url)('semver')
const manifests = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
// Versions bundled with @deepseek-ai/dsh@0.2.0-rc.2 (npm view @deepseek-ai/dsh@0.2.0-rc.2 dependencies).
const shipped = name => name === '@deepseek-ai/cordis' ? '4.0.4'
  : name === '@deepseek-ai/schemastery' ? '3.18.4'
  : name.startsWith('@deepseek-ai/dsh') ? '0.2.0-rc.2' : null
let ok = 0, blocked = 0
const ranges = {}
for (const m of Object.values(manifests)) {
  if (m.err) continue
  const peers = Object.entries(m.peer).filter(([k]) => shipped(k))
  if (!peers.length) continue
  let fine = true
  for (const [k, r] of peers) {
    let s
    try { s = r === '*' || semver.satisfies(shipped(k), r, { includePrerelease: true }) } catch { s = false }
    if (!s) { fine = false; ranges[r] = (ranges[r] || 0) + 1 }
  }
  fine ? ok++ : blocked++
}
console.log({ satisfies: ok, excludes: blocked, share: `${(blocked / (ok + blocked) * 100).toFixed(0)}%` })
console.log(Object.entries(ranges).sort((a, b) => b[1] - a[1]).slice(0, 6))
