import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Pin discovery and TypeScript resolution to this managed package. Without
  // a local config, nested execution can capture the Solar core Vitest config.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.vitest.json'] })],
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
