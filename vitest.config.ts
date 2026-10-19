import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['incubator/*/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    maxWorkers: 4,
  },
})
