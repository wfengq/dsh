import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    typecheck: { enabled: true, include: ['packages/**/*.test-d.ts'] },
    poolOptions: {
      // node:sqlite is still flagged experimental on Node 22; mute only that one warning in test workers.
      forks: { execArgv: ['--disable-warning=ExperimentalWarning'] },
    },
  },
})
