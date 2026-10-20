# Solar Prime RLM

An unreleased DSH V4 plugin that runs Prime Agent's original RLM and Continual Harness through its native ACP interface. Prime's Rust daemon, persistent Python kernel, recursive children, messaging, Factory, Harness state and refinement engine run unchanged. Solar supplies lifecycle controls, an existing DSH model route and traceable evidence.

The fixed Prime source is `7cbffa77b38facd7c87277fa3c82bcadbe816880` (CLI 0.10.0, MIT). This package targets macOS arm64 and published DSH `0.2.1-rc.2` / Cordis `4.0.5`. It neither rebuilds the official app nor imports `~/.prime`, DSH 3.x data or other plugins' credentials. There are no Prime source patches.

## Use

The conversation tools are:

| Tool | Purpose |
|---|---|
| `solar_rlm_run` | Start a task with explicit `task`, `cwd`, `maxModelRequests`, `maxWallTimeMs`, and optional `label` / relative `inputs` / `autonomous`. Returns an asynchronous receipt. |
| `solar_rlm_inspect` | Read the current session's task state and bounded result preview. |
| `solar_rlm_control` | Send one new text turn (`continue`), pass an original `/refine` command (`refine`), or stop the native process (`cancel`). |

Use the returned task reference for later inspection and controls. `idle` means Prime has settled the current round and retained its kernel; it is not an independent answer grade. Stop before disabling or unloading is also handled by plugin disposal. Unknown effects are fenced: inspection does not repeat work, and an unowned previous connection requires explicit stop/reconciliation. Explicit follow-up after a known stop uses Prime's own durable `--resume`, without resending the earlier task.

The **Prime RLM** conversation view and settings section show runtime/task status, explicit stop and a local keyless self-test. Opening a panel only reads state; it does not poll, run a test or call a real model. The local test uses deterministic scripted loopback responses. The UI omits internal runtime fingerprints and refinement record identifiers; complete identities remain in the saved diagnostic report. It is a mechanism check, not an experiment measuring model reasoning.

Normal tasks use the calling DSH Agent's actual provider/model and supported reasoning setting through `ctx.llm`. No new login is created. Model metadata or reasoning settings without a faithful Prime mapping fail explicitly. The bridge supports the inspected Chat Completions subset; it does not promise compatibility with every provider-private feature. Real-provider acceptance is separate from the local scripted test. Reasoning summaries are forwarded once their authoritative DSH block completes, so provisional deltas cannot conflict with the final text or replay identity. Tool calls likewise wait for their authoritative block, preserving its raw arguments rather than requiring them to extend provisional JSON fragments. Ordinary text still streams incrementally; original DSH chunks remain in the journal.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxInputBytes` | `16777216` | Maximum total selected file snapshot bytes; configurable up to `67108864`. |
| `maxModelRequests` | `100` | Maximum admitted logical model requests across the complete task tree; configurable up to `1000`. |
| `maxWallTimeMs` | `3600000` | Maximum wall time per explicitly admitted native round; configurable up to `86400000`. |
| `factoryEnabled` | `false` | Prime's original Factory opt-in gate. |
| `harnessRefinements` | `true` | Prime's original Continual Harness gate. |

Each run must supply request and time limits within the configured maxima. These are bounded admission defaults, not measured optimal settings. Original native settings are captured in a new run's private agent directory; resume preserves that run's state.

`solar_rlm_run` optionally accepts `autonomous: { maxTurns, maxTokens, gate? }`. This explicitly enables Prime's original `--autonomous` engine; omitting it retains the ordinary native mode. `maxTurns` bounds original assistant turns (including tool continuations), and `maxTokens` is Prime's accumulated native token budget, not a per-response output limit. The existing `maxWallTimeMs` is also passed as the native autonomous timeout. An optional `gate` is an original Prime shell acceptance command executed in the selected working directory. Native continuation and gate-retry defaults are unchanged. Autonomous mode can continue after an early textual answer when its native completion/gate checks require more work; it does not guarantee a correct answer.

The immutable versioned `runs/<run-id>/execution.json` records this choice. Cold `--resume` restores the same configuration. Prime itself starts fresh autonomous counters on a cold resume; the plugin's durable complete-tree `maxModelRequests` count does **not** reset. A legacy run without this snapshot resumes in ordinary mode only when its existing versioned journal proves every native launch omitted autonomous flags; missing or ambiguous evidence fences resume.

The logical request count includes children and refinement. DSH adapter-internal retries remain provider-owned, so this count is not a hard billable-attempt or monetary cap. Usage/cache fields and errors are retained without inventing missing billing values.

## Data and execution

All plugin state is under `$DSH_HOME/solar/rlm`: versioned `runs`, immutable selected `inputs`, journals, native Prime state, explicit `checks`, short owned sockets, and fingerprinted `runtimes`. Selected inputs must be files inside the admitted working directory. Their names, bytes and hashes are retained; Prime reads the exact snapshot paths programmatically instead of receiving the whole file in the prompt.

Prime executes code with its normal process permissions in the selected working directory. It is not a Python sandbox. Local refinement may affect Prime's applicable project files; `--global` refinement is scoped by the private Prime agent directory. No ordinary `~/.prime` state is imported or overwritten.

The parent DSH session contains ordinary tool receipts. Full inner model intents, translated requests, chunks and settlements are in the linked plugin journal; Prime also retains its native session log. Raw `ctx.llm` calls do not automatically become ordinary DSH Agent steps, and the plugin does not fabricate custom Session events. Result previews are bounded; the original evidence is retained on disk.

Prime's live Factory executor is kernel-memory-only. Cold restart restores native durable state as Prime implements it; it does not recreate live asyncio tasks/watchers.

## Build and install artifact

The development source records source pins, hashes and Python dependency locks in `runtime-lock/`. Generated binary payloads stay outside Git. Assemble an installable local package with:

```sh
pnpm build:rlm
node tools/rlm-capsule.mjs --source <clean-pinned-prime-checkout> --binary <verified-arm64-prime-agent> --python-prefix <prepared-offline-prefix> --output incubator/rlm/assets
```

The capsule script performs no dependency installation or source build. It verifies the fixed source and binary, compares loaded Prime Python files with their originals, and creates `assets/runtime.tar.gz` plus its manifest. The packed package must include those assets, built `lib/`, licenses and locks. The web entry is CommonJS inside the published DSH `window.__ModuleLoader__.load` factory, with host React shared through its scoped `require`. Build and plugin checks execute the shipped entry without ambient Node globals and verify registration, activation and disposal. Startup extracts/verifies them under the plugin namespace and uses `PRIME_AGENT_KERNEL_PYTHON` directly. Normal installation needs no pip, uv, Cargo or build hook.

This candidate has no public release, tag, market index entry or general installation URL. Authorized local installation uses a fixed packed artifact path, never a removable task worktree. See [UPGRADING.md](UPGRADING.md) for dependency provenance and the upgrade procedure.

## Verification

The official app has exercised the normal conversation and Settings panels, local native self-test, enable/disable behavior and wide/narrow rendering. This is zero-cost fixture acceptance, not real-provider or efficacy acceptance. See the [verification record](../../docs/testing/prime-rlm-verification.md) for actual source, scratch-profile and installed-app results. The [evaluation specification](../../docs/testing/prime-rlm-evaluation.md) defines the separate fidelity, quality, paper and held-out Continual Harness gates.

The bounded Codex subscription pilot and four-corpus MultiNLI follow-up with independent answer grading are tracked in the verification record. The latter attempted all 12 fixed conditions: eight completed, four failed; the complete S/D pairs gave one lower-error RLM result and two higher-error results. Two E failures included adapter serialization errors, now repaired with keyless checks, so they cannot establish an RLM benefit. These runs use an isolated evaluator and do not replace real-provider acceptance inside the installed app. Original-paper reproduction and held-out adaptation-effect evaluation remain **not run**. Neither this pilot nor implementation and installation establish a general reasoning-quality improvement.
