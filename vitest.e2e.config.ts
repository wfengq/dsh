import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL('./vitest.global-setup.ts', import.meta.url))],
    include: ['packages/**/tests/e2e/*.e2e.test.ts'],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
})
