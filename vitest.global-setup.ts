import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Points `DSH_HOME` at a fresh directory for the whole run, so a test that mounts a plugin with a
 * default path (`dshHomePath(...)`) can never touch the developer's real `~/.dsh`. Workers are
 * spawned after this runs and inherit the variable.
 */
export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}
