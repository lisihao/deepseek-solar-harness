# Prime Agent RLM and Continual Harness integration

Status (2026-10-23): the ordinary operator is frozen as an installed, unreleased development candidate. Installed executable-source commit `817d6a998ed4b0c7d120590404efe146d71bd6b5` passed the recorded local GUI/native-scripted checks; installed ordinary real-provider acceptance remains unrun. See the [candidate closeout and Argon/Opus research handoff](../testing/prime-rlm-closeout.md). Historical source/evaluation checkpoints below remain separate evidence. The latest [native-limit panel and paired repeat](../testing/prime-rlm-gate-results.md) closed at **769 = 755 confirmed + 14 retained unknown**, zero in flight, under the **800** cap. On one reused original question, recursive-plugin scores were 0.75 versus paired bare scores 0.5625 and 0.177978515625. Main S0 also scored 0.75. This is an observed whole-plugin gain in these outputs; recursion-specific or general reasoning benefit remains unestablished.

The [retrospective Q03 result](../testing/prime-rlm-q03-bare-supplement-results.md) shows one mixed primary-F1 gain while label accuracy favors bare D and S0 outperforms S. The original-task [three-arm panel](../testing/prime-rlm-three-arm-results.md) and [operational recovery](../testing/prime-rlm-quality-recovery-results.md) did not produce a completed native-versus-bare quality pair. Spawn/steer timing is confirmed and its instruction workaround was followed in the last attempt; semantic improvement remains unestablished there. Prime's original host and mechanisms remain unmodified. Those evaluations included no paid API fallback, credit purchase, installed-app update, merge or release; the later ordinary-operator installation has its own verification record.

The [reproduction-gap review](../testing/prime-rlm-gap-review.md) records the shared custom provider bridge, task/model/runtime/protocol differences, ruled-out prompt-rule hypothesis and upstream Discussion #3709. Original binary preservation is not a certification of official-provider or benchmark equivalence.

This is a separately commissioned RLM plugin. It does not change the scope, ownership or runtime of native-collaboration or native-resident. OpenHuman, TinyJuice and Jev are not dependencies.

## Outcome and reference boundary

The plugin is `@lisihao/dsh-solar-rlm`, currently an unreleased candidate under `incubator/rlm`. The official DeepSeek Harness Desktop app and its installed runtime remain unchanged. No application build, upstream patch, second provider login or market publication is part of this task.

The integrated project is [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/tree/7cbffa77b38facd7c87277fa3c82bcadbe816880), pinned to commit `7cbffa77b38facd7c87277fa3c82bcadbe816880` (CLI 0.10.0), under the MIT license. The current implementation is Rust (`pa-core`, `pa-daemon`, `pa-cli`) plus the Python runtime and skills. Historical TypeScript host descriptions do not define this pin.

The DSH baseline is published `@deepseek-ai/dsh@0.2.1-rc.2`, Cordis 4.0.5, upstream commit `687f282e8625c6b8d11ff58211a90524be2e4317`. All imported DSH/Cordis modules are shared host peers, with the development versions fixed in the root lockfile.

“Original mechanisms preserved” means the original binary, runtime and skills implement the operations below. It is not proof of universal model compatibility, comparative reasoning improvement, paper reproduction or successful recovery of every live OS object.

| Mechanism | Execution owner |
|---|---|
| Persistent IPython cells, output projection, bash and file operations | Original Prime Python kernel and Rust session engine |
| Recursive spawn, collect, retained child identity, follow-up, messaging, cancellation and ledger | Original Prime daemon and RLM host |
| Harness objects, prompts, skills and declarative machine definitions | Original `rlm.harness` and Prime persistence |
| Factory admission, execution, status and stop | Original `rlm.factory`, behind Prime's opt-in setting |
| `refine.run`, turn-boundary planning, application, history and rollback | Original Prime Continual Harness engine |
| Optional autonomous continuation, native shell gates and native turn/token/time limits | Original Prime autonomous engine; explicitly admitted per task |
| DSH tool admission, owned inputs, model route, loopback transport, evidence and UI | Solar adapter |

## Composition

```text
DSH conversation tools / owner UI
  -> Solar run journal and controls
  -> original prime-agent --mode acp
     -> original daemon, session engine and Python kernel
     -> original recursive children / Factory / refinement
     -> private OpenAI Chat Completions endpoint
        -> existing ctx.llm provider/model registration
```

The adapter does not substitute DSH Agents for Prime children and does not reimplement the scheduler, checkpoint engine, Factory executor or refinement planner. Each run owns an isolated Prime agent directory and daemon socket. No user's `~/.prime` configuration, credentials or sessions are imported. The selected working directory remains the native process cwd, including the original project's applicable local files.

The original ACP interface is the supported process boundary:

1. Launch the pinned CLI in ACP mode with a private daemon socket, agent directory, session directory and offline interpreter.
2. Initialize protocol version 1, then create one ACP session on that connection.
3. Send admitted text through `session/prompt`; send original `/refine` commands unchanged through that same native path.
4. Record namespaced Prime metadata and wait for the original terminal quiescence envelope. `end_turn` alone is not completion evidence.
5. Keep the native connection/kernel after a settled round for explicit follow-up. Explicit stop and plugin disposal use Prime's own shutdown command scoped to that run's state root.

The optional `autonomous` task object enables the original CLI's `--autonomous` mode with explicit `maxTurns`, accumulated `maxTokens`, optional shell `gate`, and the admitted wall timeout. Omission preserves ordinary native mode. `execution.json` captures this choice immutably and is strictly validated before cold resume. Prime's native counters restart on cold resume; Solar's durable complete-tree request count remains cumulative. Missing legacy configuration is accepted only with journal proof of non-autonomous native launches.

Prime's `terminalQuiescence` barrier already drains queued native work. Its `remainingAutonomousContinuations` field reports unused continuation capacity, not queued continuations; positive capacity therefore does not invalidate an otherwise complete terminal. Outstanding children, invalid metadata, missing current causal envelopes and non-`end_turn` stops remain fenced or failed.

`session/cancel` is a notification. Native shutdown is `prime-agent shutdown --force --json`, targeted by both `PRIME_AGENT_DAEMON_SOCKET` and `PRIME_AGENT_CODING_AGENT_DIR`; it is never a machine-wide unscoped kill command.

## Model transport and fidelity limits

A private `models.json` declares a `solar-dsh/selected` OpenAI Completions route. Its random per-run token authenticates only the loopback endpoint. Provider credentials stay in the existing DSH adapter; the native process receives no provider API keys from the Host environment.

The actual provider/model come from the calling DSH Agent. Its reasoning effort and output budget initialize Prime; native per-request reasoning/output controls remain forwarded by the bridge. The endpoint's `selected` name is a wire alias, not another model. Context and output metadata must be available. A known adapter default effort is made explicit to Prime, whose own unspecified default would otherwise be `medium`; an unknown reasoning default or unsupported effort fails instead of silently changing the route.

`model-wire.ts` translates the request and stream through public immutable DSH messages. It handles text, reasoning, function calls and results, image attachment admission, output limits, stop values, usage/cache fields, terminal reasons and eligible opaque replay state. Unsupported vendor fields fail explicitly. Arbitrary remote image URLs are not fetched by the bridge. The adapter does not claim that one generic Chat Completions transport reproduces every provider-private protocol.

Native children, summarization and refinement use the same admitted endpoint and contribute to the run's logical request budget. The adapter reserves that budget before dispatch, including concurrent descendants. Adapter-internal HTTP retries remain owned by the configured DSH provider; a logical request limit is not a hard billed-attempt or monetary limit. Provider-reported usage is retained, with unknown billing and missing values left unknown.

Raw `ctx.llm` calls do not create ordinary DSH Agent steps automatically. The parent has normal tool call/result records; full inner Prime requests, translated requests, chunks and settlements are in the plugin journal, and Prime keeps its original native session records. The adapter does not manufacture custom Session events or label these as native PTC dispatches.

## User interfaces and settings

| Interface | Behavior |
|---|---|
| `solar_rlm_run` | Admit a bounded task, working directory and optional selected input files; return an asynchronous receipt. |
| `solar_rlm_inspect` | Read a task owned by the current DSH session. Inspection does not replay work. |
| `solar_rlm_control` | Explicit follow-up, original `/refine` command, or native stop. |
| Prime RLM conversation/settings panel | Runtime status, task inspection/stop and an explicit local keyless check. Opening it makes no model request. |

Configuration controls input bytes, whole-tree logical requests, per-round wall time, and Prime's native gates. `factoryEnabled` defaults to `false`, and `harnessRefinements` defaults to `true`, matching the pinned source. The settings are written into each new run's private Prime state; resuming an existing run does not replace its native settings or Harness state.

Selected files are copied into immutable per-run snapshots after path and size checks, with names, sizes and hashes recorded. Their full contents are not injected into the prompt; Prime reads them programmatically. This is external data access, not TinyJuice compression. Prime code executes with the native process's normal OS file permissions. The adapter is not a Python sandbox or a replacement for the official app's approval model.

## State, recovery and cancellation

State is versioned under `$DSH_HOME/solar/rlm/`:

```text
runtimes/<archive-sha256>/    verified original binary, offline Python and skills
runs/<run-id>/               manifest, immutable inputs, journal, private Prime state
s/                          short run-owned daemon sockets
checks/<command-id>/         explicit local test receipts and isolated native state
```

Run manifests are atomic writes and journal appends are serialized and synced. Readers refuse an unknown format. Every model intent is durable before dispatch; stream chunks and settlement are durable before their corresponding wire output is sent.

`preparing -> running -> idle` represents an admitted round and its native settled completion. `idle` retains the kernel and is not an independent answer grade. Stop proceeds through `cancelling -> cancelled`. Failures or missing causal/quiescence evidence are reported as `failed` or `indeterminate` as applicable; transport timeout is not a confirmed model outcome.

A reloaded Host does not silently adopt or replay an old live request. It reports an unowned active/idle connection as indeterminate. An explicit stop can reconcile the run through its exact saved native state root. A subsequent explicit new input may resume a known stopped durable session through Prime's original `--resume`; it never resends the previous prompt.

Prime's original Factory executor is kernel-memory-only. Declarative machines are durable, but a cold kernel restart does not restore live asyncio tasks/watchers. The plugin preserves this limitation and does not fabricate recovered live work.

## Offline distribution and upgrade boundary

`tools/rlm-capsule.mjs` assembles the original release binary, sidecar source/assets, offline CPython 3.12.13 and installed dependency closure. The native build uses `cargo build --locked --release -p pa-cli` on the fixed clean source. No Prime source is copied into Git or edited as an adapter patch.

The installed package includes `assets/runtime.tar.gz` and its versioned manifest. The development source keeps locks, hashes and assembly instructions; the large generated payload is ignored by Git. Runtime extraction verifies the archive, source pin and critical loaded files. `PRIME_AGENT_KERNEL_PYTHON` points to the extracted interpreter so Prime does not invoke its online bootstrap.

The payload contains the original runtime, all nine Python skills, MCP, dill, the pinned default scientific/HTTP imports, machine templates, and license/lock metadata. Normal plugin installation needs no pip, uv, Cargo, postinstall hook or another app build. See the plugin [upgrade contract](../../incubator/rlm/UPGRADING.md) for the API map, pins and any carried patches; currently there are no Prime source patches.

This payload is macOS arm64 only. Ubuntu CI can check adapter source, schemas and lifecycle/registration behavior; it cannot certify the Darwin binary. Native execution and app acceptance are distinct MacBook evidence lanes. A public release still needs its separately authorized release/index workflow and redistribution artifact channel.

## Verification and claim boundaries

The [35-case evaluation contract](../testing/prime-rlm-evaluation.md) remains the acceptance reference. Keyless checks use a scripted loopback model to exercise the original native engine; this demonstrates mechanisms, not answer quality.

Required implementation evidence includes:

- Fixed clean source, binary hash, loaded Python source hashes, offline closure and relocation.
- ACP framing/correlation, errors, cancellation, unknown effects and versioned persistence.
- Actual original persistent cells, recursive descendants, Factory and native refinement state changes in a keyless run.
- The built plugin installed and booted under plain Node in a disposable published-baseline profile, including the full DSH model bridge and native resume/stop path.
- Existing-app installation from a stable artifact, enabled state and normal explicit local check, disable/enable cleanup, default/narrow UI inspection and preserved unrelated profile state.

Actual results belong in [the verification record](../testing/prime-rlm-verification.md); planned checks are not passing evidence. The bounded subscription pilot and four-corpus follow-up were run with independent grading and retained adverse outcomes; they did not establish quality improvement. Original-paper reproduction and held-out Continual Harness effects remain **not run**. The [ARC protocol alignment](../testing/prime-rlm-arc-protocol.md) separates the published single-root game workflow from recursion-specific evaluation. Nothing in implementation, a green CI check, installation or the paper itself proves that this plugin improves a model's reasoning.

## Primary source map

All Prime links below are pinned to the integrated commit:

- [ACP metadata and causal completion](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/acp/meta.rs).
- [Daemon ACP admission, prompt and lifecycle](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/acp/daemon.rs).
- [Original RLM host](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-core/src/session_engine/rlm_host.rs), [child lifecycle](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/rlm_children/lifecycle.rs), [ledger](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/rlm_ledger.rs).
- [Original Python runtime](https://github.com/PrimeIntellect-ai/prime-agent/tree/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm), [Factory](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/factory.py), [Harness](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/prime-agent-runtime/src/rlm/harness.py).
- [Native refinement](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-core/src/session_engine/refine.rs), [native setting defaults](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-core/src/settings/interactive_settings.rs).
- [RLM original paper v1](https://arxiv.org/html/2512.24601v1). Its evaluated settings and comparative conclusions remain distinct from this integration's evidence.

The eleven-call [operational recovery](../testing/prime-rlm-quality-recovery-results.md) closed at 600 = 586 confirmed + 14 unknown. Its timing policy was followed and both child files cover all 787 records, but no final answer was produced; offline child aggregation is worse than the completed bare answer. Raw and reference answers remain local and private. The user's subsequent additional 100-request authorization raises the cumulative ceiling to 700; it does not erase any prior outcome.
