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

Each run must supply request and time limits within the configured maxima. These are bounded admission defaults, not measured optimal settings. Original native settings are captured in a new run's private agent directory; resume preserves that run's state. The internal evaluation host can additionally pass Prime's original `rlmMaxDepth` setting before session creation; the ARC panel sets it to zero because the author game protocol forbids subagents. Ordinary plugin configuration omits this override and retains Prime's native depth behavior. The separate [native recursion ablation pilot](../../docs/testing/prime-rlm-recursion-protocol.md) compares depth zero and one on identical dense semantic-aggregation inputs; its runner accounts for the entire tree and serializes child model requests. This evaluation does not change production defaults.

`solar_rlm_run` optionally accepts `autonomous: { maxTurns, maxTokens, gate?, gateMaxRetries?, maxContinuations? }`. This explicitly enables Prime's original `--autonomous` engine; omitting it retains the ordinary native mode. `maxTurns` bounds original assistant turns (including tool continuations), and `maxTokens` is Prime's accumulated native token budget, not a per-response output limit. The existing `maxWallTimeMs` is also passed as the native autonomous timeout. An optional `gate` is an original Prime shell acceptance command executed in the selected working directory. Optional `gateMaxRetries` (integer 1-1000) forwards Prime's original `--autonomous-gate-retries`; omission retains the pinned native default of three. Optional `maxContinuations` (integer 1-1000) forwards the separate original `--autonomous-max-continuations` limit; omission retains its native default of three. Raising `maxTurns` alone does not raise either default. Neither option increases the durable whole-tree request budget. Native gate failure remains a failure. Autonomous mode can continue after an early textual answer when its native completion/gate checks require more work; it does not guarantee a correct answer.

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

The later [fixed four-game ARC workflow panel](../../docs/testing/prime-rlm-arc-results.md) attempted all 12 B/R/S conditions once: all arms recorded 0/4 complete-game WIN, with mixed level progress, one invalid baseline control and retained resource/transport failures. It charged 325 new subscription requests (463 cumulative under 522). This author protocol forbids recursive children and disables learning; the panel establishes neither recursion nor Continual Harness benefit. Its evaluator fixes and post-panel plan closure are source-only and have not updated the earlier installed artifact.

The later [native recursion ablation](../../docs/testing/prime-rlm-recursion-results.md) completed one fair Q03 pair after retained transport failures: plugin depth zero scored F1 0.307692 and plugin depth one scored 0.240000. The recursive arm used four actual children and eight child model calls; all 438 child labels entered the final answer. Both arms completed, but this task showed no quality benefit. Cumulative experimental charges are 506/522, including 11 unknowns. This is source/evaluation evidence and does not update the installed plugin artifact.

The later [bare-model TREC pilot](../../docs/testing/prime-rlm-bare-quality-results.md) did not establish a quality gain: bare D completed, while S saved a worse draft and exhausted its allowance without a child request. A subsequent [retrospective Q03 bare supplement](../../docs/testing/prime-rlm-q03-bare-supplement-results.md) reused the completed recursive S result: primary pair F1 was S=0.240000 versus D=0.205882, while label accuracy was S=404/438 versus D=408/438. This is one mixed main-metric benefit, not a general or causal recursion claim. At that checkpoint cumulative usage is 523/600. Prime and installed plugin bytes remain separate from these evaluator changes.

The [original-question bare/Prime/plugin panel](../../docs/testing/prime-rlm-three-arm-results.md) closes the next checkpoint at 589/600: D completed with absolute count error five; both native arms used seven root and twenty-five child calls and wrote no answer. Their initial model envelopes match after owned-path/session-id normalization. Immediate child steering ran before the original spawn assignment, whose delivery is deferred until the parent turn ends. A local original/plugin reproduction confirms that ordering and later delivery; it does not show permanent task loss or quality benefit. An [eleven-call exploratory recovery](../../docs/testing/prime-rlm-quality-recovery-protocol.md) adds explicit operational instructions without changing Prime. Its outcome is separate from installed-app acceptance.

The eleven-call [operational recovery](../../docs/testing/prime-rlm-quality-recovery-results.md) closed at 600 = 586 confirmed + 14 unknown. Its timing policy was followed and both child files cover all 787 records, but no final answer was produced; offline child aggregation is worse than the completed bare answer. Raw and reference answers remain local and private. The user's subsequent additional 100-request authorization raises the cumulative ceiling to 700; it does not erase any prior outcome.

The earlier [four-condition control protocol](../../docs/testing/prime-rlm-controlled-protocol.md) fixed bare D / original Prime R / recursive plugin S / depth-zero plugin S0 on the same original task. It started from the actual 600-call closure with a planned maximum of 97 additional calls (cumulative at most 697 under the then-700 cap). Its completed outcome is recorded below. Public reports omit raw/reference answers and private labels.

The [fixed original-question four-condition result](../../docs/testing/prime-rlm-controlled-results.md) closed at 676 = 662 confirmed + 14 retained unknown: D scored 0.75, S0 scored 0.5625, while R/S failed native completion. The user later raised the cumulative cap to 800. Explicit native gate retry and continuation configuration passed strict zero-model original/plugin and recursion controls; installed bytes remain the earlier artifact.

The latest [native-limit panel and fresh paired repeat](../../docs/testing/prime-rlm-gate-results.md) observed S=0.75 versus bare D=0.5625 and D=0.177978515625 on one reused original question. The recursive runs completed with 11 and 12 actual child requests. Main S0 also scored 0.75, so this demonstrates a whole-plugin gain for these paired outputs, not a recursion-specific or general reasoning improvement. R exhausted its 32-request tree budget without a final answer. Independent grading, ledger/source/runtime checks and closure passed; cumulative usage is 769 = 755 confirmed + 14 retained unknown under 800, with 31 unspent. These source experiments do not update the earlier installed artifact, reproduce the original paper or test Continual Harness learning benefit.

The subsequent [reproduction-gap review and upstream request](../../docs/testing/prime-rlm-gap-review.md) clarifies that both the original-host comparator and plugin use the same custom Solar/Codex bridge. Their initial-request equality does not certify official-provider conformance or a complete published-benchmark reproduction. The scheme, retained results and protocol questions were sent to Prime Discussion #3709; this documentation-only handoff made no new model request or runtime change.
