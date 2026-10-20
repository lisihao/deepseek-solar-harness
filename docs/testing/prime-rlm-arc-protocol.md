# Prime ARC protocol alignment and next experiment boundary

Date: 2026-10-20, Asia/Shanghai. This is a preparation and acceptance contract, not a reported ARC score or an efficacy result. The closed earlier experiment charged 138 requests under its then-146 cap. The user later approved the [fixed four-game panel](prime-rlm-arc-pilot-plan.json), up to 384 new requests and cumulative cap 522. Preparation and scripted acceptance use zero real model requests.

## What the published ARC result tests

The fixed reference is [PrimeIntellect-ai/arc-agi-3-prime-agent@398d4dd63cf01d00adbea41c13437ba0b8ad40fc](https://github.com/PrimeIntellect-ai/arc-agi-3-prime-agent/tree/398d4dd63cf01d00adbea41c13437ba0b8ad40fc), MIT. Its [game guidance](https://github.com/PrimeIntellect-ai/arc-agi-3-prime-agent/blob/398d4dd63cf01d00adbea41c13437ba0b8ad40fc/AGENTS.md) and initial prompt explicitly prohibit RLM/subagent calls. The workflow uses one persistent top-level Python session to inspect frames, maintain hypotheses and operate the game through a fixed broker. It therefore supports a claim about the complete Prime game harness; it cannot isolate the contribution of recursive children or Continual Harness refinement.

| Protocol input | Published reference | Current Solar boundary |
|---|---|---|
| Prime | CLI v0.3.3 | Original, unmodified CLI 0.10.0 at `7cbffa77b38facd7c87277fa3c82bcadbe816880`; upgrading/downgrading is not implicit |
| Mode | `--mode rpc --autonomous` | `--mode acp`, with explicit optional original autonomous configuration |
| Reported repository model | Claude Opus 5 / xhigh | Only Codex gpt-6.1-sol / high is authorized; this is a different-model extension, not exact reproduction |
| Game engine | `arc-agi==0.9.9`, `arcengine==0.9.3`, Python >=3.12 | Separate pinned preparation environment; never added to or substituted for the Prime capsule |
| Cases | 25 public games, fresh independent session/workspace per game, seed 0 | Freeze exact game versions and record every unavailable case; do not silently select newer games |
| Actions | 500 environment actions/game, at most 20 per batch; initial observe then single non-RESET actions; reset after GAME_OVER consumes an action | Preserve the original broker/client behavior; model calls are counted separately |
| Termination | WIN or ACTION_CAP | Record model/tree/time/native-limit failures separately; none is a game success |
| Isolation | Published guard uses Linux root ownership, `/proc` and `SO_PEERCRED` | macOS preparation cannot certify this guard; client protocol checks alone are not equivalent OS isolation |

The [run script](https://github.com/PrimeIntellect-ai/arc-agi-3-prime-agent/blob/398d4dd63cf01d00adbea41c13437ba0b8ad40fc/run.sh) does not specify a separate model-request or monetary budget. Its 500-action cap must never be relabeled as 500 model calls. The earlier four text-label counting windows did not reproduce this protocol and cannot explain or refute its headline result.

## Repair and acceptance before another real-model panel

The plugin previously omitted native autonomous flags. It also interpreted the ACP `remainingAutonomousContinuations` counter as pending work. The fixed [Prime producer](https://github.com/PrimeIntellect-ai/prime-agent/blob/7cbffa77b38facd7c87277fa3c82bcadbe816880/crates/pa-daemon/src/acp/daemon.rs#L1763) defines it as unused continuation capacity. Solar now admits explicit native autonomous settings, snapshots them immutably, and accepts capacity only after the native causal terminal barrier and zero outstanding children. Non-end-turn stops and malformed or missing evidence still fail or fence the run.

Required evidence is split into three lanes:

1. Built-package local acceptance: an initial textual early stop fails a native gate, the original engine continues, original Python writes a checked artifact, and the gate passes. Explicit cold resume must restore the same configuration while retaining Solar's cumulative whole-tree request count. Prime's own autonomous counters restart on a cold resume.
2. Original-versus-plugin scripted differential: the same binary, task, model metadata and autonomous limits run directly and through Solar. Compare model-visible instructions, tool definitions/history and actual Python/gate results. Normalize only documented run-specific paths, identities and timing. This is adapter evidence, not reasoning-quality evidence or provider-private protocol certification.
3. Real game preparation: pin the author source and dependency versions outside the plugin; acquire only officially available game environments through the documented anonymous toolkit route; record exact availability and hashes. Load an actual offline game, observe and exercise the real broker without a model. Anonymous access to all 25 historical versions must be observed, not assumed.

The tools refuse to equate a scripted gate with a quality improvement. No game corpus, model reasoning, account data, credentials or generated interpreter is published with these source changes.

## Next real-model panel

The new user-approved panel has a 384-request maximum; its real launch still requires the frozen runner and isolation gates. Before any new panel, freeze: exact cases and seed; model/provider revision and high reasoning; full prompts; comparator implementation; original mode and capability settings; per-tree and cumulative request/time/token caps; action accounting; isolation probes; independent scoring; and a stopping rule. All earlier outcomes remain retained and charged.

An ARC panel must first establish that original Prime and Solar preserve the same permitted single-root game behavior. Any comparison with another scaffold is a full-harness comparison. A recursion-specific quality claim instead requires the separate S/S0 long-context contrast from the [evaluation specification](prime-rlm-evaluation.md), with a verified no-subcall control and enough budget for actual children. These two questions must not share a favorable result label.

A revised experimental request cap, another model/effort, paid API fallback or extra credits requires explicit user authorization. No merge, release, market publication, recurring task, Jev restoration or app rebuild is authorized by this experiment preparation.


## Test-only ARC SDK compatibility deviation

The exact author broker calls `LocalEnvironmentWrapper.action1()` and related methods, while its pinned `arc-agi==0.9.9` exposes `step(GameAction, data=...)`. This was reproduced on a real offline game after successful observation. `tools/fixtures/rlm-arc-prepare/sdk-step-adapter.py` is an explicit facade around that environment object; the original broker still owns action counts, batches, reset and terminal handling. The author checkout, Toolkit and Prime remain unmodified. Preparation records the unadapted failure separately; `--compat-step` is opt-in and every resulting report marks `exactAuthorReproduction=false`.

Run a read-only preflight with `node tools/rlm-arc-prepare.mjs`. Explicit `--prepare --output <new-private-tmpdir>` stages the pinned source, dependencies and public corpus. To reuse a verified acquisition without repeating network or installation effects, run `--smoke-existing <existing-private-tmpdir> --compat-step`; this creates a new smoke receipt and retains the original report. The observed compatible smoke completed initial observation, two single actions and status with independent frame/action receipts; it is environment acceptance, not a model score.

The B arm uses its separately frozen ordinary game-tools system prompt; R and S use the author behavioral guidance and initial task. Thus S/B compares the complete supplied workflows, including guidance as well as persistent Python and autonomous execution. It is not a prompt-matched estimate of the execution engine or recursion alone. R/S share the author guidance and native settings.

The automatic grade validates trusted broker observations, not every behavioral instruction. Action-loop use and other trace-level protocol deviations require a separate review; an observed WIN does not by itself certify full author-protocol compliance.


## Observed workspace adaptation in the fixed panel

The original initial prompt names `/workspace/AGENTS.md` and `/workspace/fixed_broker_client.py`. The macOS evaluator instead stages `AGENTS.md` and `broker_client.py` in each private current working directory, appends explicit broker environment variables, and points the original terminal gate at that staged client. The first real S condition attempted both legacy paths, received two file-not-found errors, then successfully read the local guidance, imported the staged client and operated the real game. The frozen R/S task is identical apart from owned paths, but this adaptation is asymmetric relative to B and consumes part of the model-request budget. It is a recorded deviation from the original deployment, not exact author reproduction. Inputs are not changed after observing this outcome.

The same S trace attempted a multi-action call at each of the two single-action bootstrap phases. The original client refused those attempts before they reached the trusted engine, and they consumed no environment actions. These are bootstrap-phase violations; they do not establish that Python or shell loops submitted actions. Behavioral compliance, game progress, transport completion and observed WIN remain separate evidence.

The first S/ls20 condition ended after 32 charged requests with two completed levels, 97 actions and trusted terminal `ACTIVE`. Request 170 received HTTP 200 headers, then `ECONNRESET`; the later native retry was rejected by the 32-request cap. The network failure preceded the budget rejection, and its remote cause is unknown. That request remains charged as unknown. The failed condition is never replayed. A separate manual continuation may execute only conditions without a start marker, after immutable result/receipt hashes, transport closure and owned native cleanup have been verified.


## Baseline stream-consumer failure and repair boundary

After direct R/ls20 finished at 32 requests, two levels and 131 actions without WIN, the first B/ls20 response produced an authoritative `observe` tool call and reported token usage. The shared encoder returns at a successful finish; B's pull-based wrapper propagated that return to the parent model iterator before EOF. The parent correctly retained `ARC_STREAM_ABANDONED` as a charged unknown and fenced the next call. The tool was not executed and the game had zero actions. This is an evaluator failure, not a measured model error. The B condition remains in the fixed panel and is not replayed; its paired quality comparison is unavailable. A raw WIN-count denominator of four must not turn that failed control into evidence for S's reasoning advantage.

The repair makes the baseline consume the original model stream to its confirmed end before executing broker tools. A continuation supplement explicitly binds the changed runner, baseline consumer and ledger closure bytes; prompts, game cases, native runtime and compiled adapter stay frozen. `transport_closed` names an inspected closed transport with unknown usage, not a refunded or successful request. All earlier receipts remain immutable. At this pause cumulative accounting is 203/522, including 198 confirmed and five unknown requests; nine conditions have never started. Subsequent results must identify this execution-version boundary.
