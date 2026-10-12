import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL('./vitest.global-setup.ts', import.meta.url))],
    include: ['packages/**/tests/e2e/*.e2e.test.ts'],
    // Each file drives a real dsh process against the built `lib` (built once by `pretest:e2e`);
    // running them one at a time keeps them from competing for CPU and ports.
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 180000,
  },
})
