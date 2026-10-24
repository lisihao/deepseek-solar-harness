import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts', 'src/graph-memory.ts', 'src/hindsight.ts', 'src/hindsight-session.ts'],
  outdir: 'lib',
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
})
