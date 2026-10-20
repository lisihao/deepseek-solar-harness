# Upgrade boundary

## Pins and adapter ownership

Harness peers and dev packages are pinned to `0.2.1-rc.2` in `package.json` and the root development lockfile. Shared Cordis/Harness modules remain host peers. Ego Lite is a user-installed external prerequisite, not redistributed code: the inspected CLI is `0.5.1.13`, public browser API v2. No browser binary, cookies, credentials or upstream source is included in this package. The executable path is profile configuration.

The `./operator` export is for trusted JavaScript callers and trusted external adapters; it is not an arbitrary-code model tool. `src/process.ts` owns stdin-only CLI transport and bounded process cleanup. `src/ego-adapter.ts` is the thin public TaskSpace/Page adapter. `src/page-observation.ts` owns the visible DOM selectors and Markdown projection. `src/controller.ts` owns durable admission/submission state, polling and unknown-effect handling. `src/conversation-runtime.ts` and `src/conversation-adapter.ts` bind the public model catalog, immutable per-request preferences, normal assistant chunks, captured source flows and known completion delivery. `src/studio-provider.ts` owns editable Web/Insight phase execution; `src/studio-bindings.ts` binds Native, ChatGPT and Gemini effects. `src/gemini-port.ts` / `src/gemini-page.ts` own the Gemini public page adapter; unobserved Deep Research controls remain explicitly unconfigured. `src/insight-preset.ts` uses the public preset and request waterfall, without private model-selection registries. UI uses the official rc.2 module loader, conversation/settings slots and Typert Remote services, with actual `--dsw-alias-*` theme tokens.

## Upgrade procedure

1. Read the new public Ego API and Harness release changes before running them. Verify CLI version/API independently; do not silently run a browser upgrader or replace authentication.
2. Inspect the actual empty ChatGPT page and model/effort/send controls without submitting. Update selectors only from observed markup, preserve ambiguity/login/draft/ownership checks, and record requested versus observed labels.
3. Run focused keyless transport, observer, store, controller, provider and built-client tests, then the built-package scratch-profile CLI probe. Repeat only affected checks during repair.
4. At the stable delivery boundary run the repository gate, pack the identified commit, and install only after explicit authorization. Verify the rendered normal/narrow UI and separately cost-authorized requests for the changed provider behavior. The former one-shot ChatGPT canary does not accept the new Insight chain. Confirm Gemini plan/start/report semantics and exact requested model availability before enabling real research. A fake DOM or registered provider does not prove website compatibility.
5. Observe an existing unknown run against its original TaskSpace; never upgrade by replaying it. Refuse unknown durable format versions. A format migration needs its own explicit design and evidence.

## Carried patches

None. This plugin does not patch, vendor or monkey-patch Harness or Ego Lite. Its own DOM adapter replaces the legacy V3 private browser/physical-operator seams. Missing website controls cause a named failure, not a hidden provider/API fallback.
