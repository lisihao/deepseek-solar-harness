import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Keep the managed plugin's test discovery local when this repository is
  // embedded below the Solar monorepo (Vitest otherwise walks up to the DSH
  // core configuration and applies its unrelated package inventory).
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    pool: 'forks',
  },
})
