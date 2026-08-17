/**
 * Build the browser half as a DSH module-loader factory artifact at
 * lib/client.js. Mirrors the dsh-browser-bridge client bundle: CJS-shaped
 * code wrapped in `window.__ModuleLoader__.load({ id, factory })`, with React
 * and the official DSH client bundles left external (the web shell provides
 * them).
 */
import { build } from 'tsdown'

await build({
  name: '@ycp424c/dsh-luna-vision-bridge/client',
  entry: { client: 'src/client/index.tsx' },
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  outDir: 'lib',
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
    ],
    alwaysBundle: () => false,
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "@ycp424c/dsh-luna-vision-bridge", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
