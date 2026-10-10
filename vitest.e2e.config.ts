import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/tests/e2e/*.e2e.test.ts'],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
})
