import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL('./vitest.global-setup.ts', import.meta.url))],
    include: ['packages/*/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    // End-to-end runs (`pnpm test:e2e`) and timing benchmarks (`pnpm test:perf`) have their own scripts.
    exclude: [...configDefaults.exclude, '**/e2e/**', '**/*.perf.test.ts'],
    typecheck: { enabled: true, include: ['packages/**/*.test-d.ts'] },
  },
})
