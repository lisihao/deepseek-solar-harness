# Model catalogue browser fixture

This local fixture serves the real `PreferencesPanel` with in-memory fake preference and catalogue APIs. It never opens Ego Lite, reads browser state, or submits a model request.

From the repository root, run:

```sh
node tools/fixtures/model-catalog-browser/serve.mjs
```

Open `http://127.0.0.1:4173/`. The page shows read/save/refresh counters so an explicit catalogue refresh can be distinguished from the cache read performed by the settings panel. The initial cache contains only `GPT-6`; an explicit refresh adds `GPT-6.1 Future` and exposes `Pro`. Ordinary Web fields start empty, and the Insight critique stage starts with the unmatched exact `GPT-6 Astra Pro` / `Pro` labels so the preservation note is visible.


The fixture supplies the host theme variables locally so the real component is legible outside Harness. Its `node:crypto` shim is fixture-only and does not validate production template hashes.
