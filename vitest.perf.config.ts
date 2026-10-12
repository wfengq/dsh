import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL('./vitest.global-setup.ts', import.meta.url))],
    include: ['packages/**/tests/**/*.perf.test.ts'],
  },
})
