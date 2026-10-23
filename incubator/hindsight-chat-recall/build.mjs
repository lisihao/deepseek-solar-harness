import {build} from 'esbuild';
await build({entryPoints:['src/index.ts','src/recall.ts'],outdir:'lib',bundle:true,packages:'external',platform:'node',target:'node22',format:'esm'});
