import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    typecheck: { enabled: true, include: ['packages/**/*.test-d.ts'] },
  },
})
