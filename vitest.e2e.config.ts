import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/tests/e2e/*.e2e.test.ts'],
    testTimeout: 180000,
    hookTimeout: 180000,
    poolOptions: {
      // node:sqlite is still flagged experimental on Node 22; mute only that one warning in test workers.
      forks: { execArgv: ['--disable-warning=ExperimentalWarning'] },
    },
  },
})
