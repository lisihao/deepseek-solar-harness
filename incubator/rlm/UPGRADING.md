# Prime Agent Runtime Upgrade Notes

This plugin carries the Prime Agent runtime as an unmodified native binary plus a separately pinned offline CPython capsule. Upgrades must preserve the upstream Prime RLM and Continual Harness mechanisms. Any source patch, behavioral substitution, or migration of native state requires a separate design and fidelity review; this document does not authorize one.

## Pins and provenance

| Component | Current pin/evidence |
|---|---|
| Prime Agent source | Commit `7cbffa77b38facd7c87277fa3c82bcadbe816880` (`src/runtime.ts`, `PRIME_COMMIT`) |
| Native package | Archive manifest and package layout are runtime inputs; `src/runtime.ts` validates the manifest's commit, archive SHA-256, binary SHA-256, Python version, and critical-file hashes |
| CPython capsule dependencies | Exact versions and distribution hashes in `runtime-lock/requirements.txt` |
| Third-party license inventory | `runtime-lock/licenses.json`; missing package metadata remains recorded as missing rather than inferred |
| DSH host | Package peers currently target DSH `0.2.1-rc.2` and Cordis `4.0.5` in `package.json` |

Prime Agent's source license is MIT. The bundled Python distributions include multiple licenses; review the complete lock inventory and each upstream license before redistributing a refreshed capsule. Do not infer a package license when its metadata is absent. The Python lock is generated from a separate capsule project, not by the normal DSH package manager.

## Adapter boundary

The main adapter call sites are:

- `src/core.ts`: `RlmHost.start`, promise-based `waitForResult`, ACP lifecycle and run controls, per-run Prime environment/configuration, and loopback `/v1/chat/completions` handling through `ctx.llm.prepareCall`.
- `src/model-wire.ts`: `decodeChatRequest` and `encodeChatStream`, which translate supported Prime OpenAI Chat Completions requests to DSH LLM messages and stream results back.
- `src/acp-client.ts`: JSON-RPC/JSONL transport to the native Prime ACP process.
- `src/runtime.ts`: archive/manifest checks, bundled binary and Python paths, and the pinned Prime commit.
- `src/store.ts`: versioned per-run manifest and append-only activity journal.
- `src/execution.ts`: strict, immutable native autonomous configuration snapshot and exact CLI arguments; legacy mode recovery requires journal evidence.
- `src/remote.ts`, `src/typert.ts`, and `src/client.ts`: current owner-only status/check/inspect/cancel remote surface and UI. `src/index.ts` registers the synchronous `solar_rlm` ordinary-conversation operator, the three compatible asynchronous control tools, validated plugin Config and the owner service. The browser contributes only a Settings section.

The adapter relies on Prime's native ACP session methods, optional original `--autonomous` and gate/turn/token/timeout flags, native durable session files and `--resume`, the native `openai-completions` provider, and Prime's own Python REPL, recursive child calls, Factory, and `/refine` behavior. The loopback bridge changes only the model transport. It does not substitute DSH child agents or schedulers for Prime mechanisms. Prime's full native internal step trace is not recreated from `ctx.llm` records.

Known transport limits include the current Chat Completions endpoint and explicitly supported message/tool/image fields in `src/model-wire.ts`; unsupported request fields error rather than being silently dropped. Images are accepted only as embedded data URLs and saved through DSH's attachment API (the official store may normalize non-sRGB, animated, metadata-bearing or oversized inputs; arbitrary-image byte identity is not promised); the adapter does not fetch arbitrary image URLs. DSH route reasoning-effort values without a Prime equivalent fail rather than being downgraded. Streaming, tool-call replay, reasoning, image, and usage parity still require keyless and route-specific verification. The encoder buffers provisional reasoning and tool-call deltas until the authoritative block closes, then forwards the final text or raw arguments exactly. This accommodates provider normalization without changing Prime or losing replay identity; ordinary text retains strict prefix checks. Tool names and call IDs must remain stable. A successful finish without a closing reasoning/tool block flushes its accumulated value; error and abort finishes do not fabricate successful completion. `tests/model-wire.test.ts` covers these boundaries.

## Upgrade procedure

1. Pin a new Prime source commit and inspect its ACP contract, binary packaging, model-provider behavior, durable-session semantics, Python kernel override, RLM child behavior, Factory, and refinement behavior. Do not run upstream installation or build scripts during source analysis.
2. Build the native binary and offline Python capsule in an isolated preparation environment. Keep Prime source unmodified. Resolve all Python dependencies before packaging; market installation must not invoke `pip`, network resolution, or package build hooks.
3. Regenerate the Python dependency lock with exact versions and hashes, then regenerate the license inventory from the packaged distributions. Review changes, including missing license fields, before distribution.
4. Produce an immutable runtime archive and manifest with the new Prime commit, platform, architecture, archive and binary digests, Python version, package layout, and hashes for every critical file. The runtime validator must reject mismatched commit or hashes.
5. Update the adapter only where the new documented native interface requires it. Record any transport adaptation and lifecycle limitation. Do not patch Prime source or replace its RLM/Continual Harness mechanisms under an upgrade-only change.
6. Run the keyless native self-test and source-level ACP/model-wire checks in an isolated environment. Then run the required built-package plugin test in a disposable `DSH_HOME`, verifying recursive children, tool round trips, idle-kernel continuation, native `/refine` pass-through, cancellation, known-session resume, and indeterminate-state fencing.
7. Complete separately authorized installed-app GUI acceptance in the existing official `~/.dsh` home, preserving its configuration and unrelated plugins, before calling the plugin usable. Development acceptance still uses a disposable profile. Record each check as run or not run. Paid model-quality, paper-reproduction, and held-out Continual Harness evaluations are separate evidence lanes and remain unrun unless separately authorized.

## Patches and deviations

Carried Prime source patches: **none**.

1. **Authoritative DSH stream blocks (adapter only).** `src/model-wire.ts` waits for complete reasoning and tool-call blocks before encoding their values as OpenAI SSE. The published DSH assembler uses the final block even when provisional tool JSON has a different serialization; already-emitted SSE bytes cannot be retracted. Three captured subscription responses reproduced the tool-argument failure and now replay with matching wire/final-message arguments. `tests/model-wire.test.ts` covers normalized/revised arguments, interleaving, duplicate closes, delta-only finishes, stable identities and error/abort behavior. The built-package fixture in `tools/fixtures/rlm-probe/lib/index.js` also executes an original Prime Python call after such normalization, then continues/stops/resumes. No upstream patch or issue is carried; this is Solar's transport boundary.

The ACP process boundary, CPython capsule override, per-run private `agentDir`, and DSH loopback OpenAI Chat Completions bridge are explicit host/transport adaptations. They preserve the native Prime mechanisms by design, but fidelity is not established merely by that design. Entry-point/configuration and tool registration are implemented; installed-app acceptance is tracked separately in the verification record. If the Host disconnects while a request's effect is unknown, the run is fenced as indeterminate and the original task is not replayed. Explicit continuation is permitted only for a known native session; session resumption must use Prime's own `--resume` behavior.

2. **Native autonomous admission and terminal interpretation (adapter only).** `src/execution.ts` passes explicit bounded task configuration to the original CLI and preserves it in `execution.json`. Defaults remain ordinary Prime mode. At the fixed pin, `remainingAutonomousContinuations` is unused continuation capacity (`pa-daemon/src/acp/daemon.rs::quiescence_meta`), not pending work. `src/prime-evidence.ts` accepts nonnegative capacity only after a complete current native terminal barrier, zero outstanding children and `end_turn`; native limits/errors and native gate failures remain failures, even when ACP returns `end_turn`. The built fixture verifies an early text answer, a failed native gate, original Python execution, successful native continuation, stop and cold resume. Cold resume restores configuration but Prime restarts its autonomous counters; Solar's durable tree-request cap remains cumulative. No Prime source patch is carried.

The internal evaluation host can explicitly forward the original nonnegative `rlmMaxDepth` setting into the private `settings.json` before Prime session creation. ARC uses zero to enforce the author protocol's no-subagent rule; the production default omits it. This is native configuration, not a change to Prime's recursion implementation. Invalid caps fail before any run or model dispatch.

3. **ARC benchmark SDK facade (evaluation tools only).** The fixed author ARC broker calls action methods absent from its pinned Toolkit 0.9.9. `tools/fixtures/rlm-arc-prepare/sdk-step-adapter.py` delegates those method calls to the same pinned SDK's `step(GameAction, data=...)`. Original broker counts/reset/terminal logic remains unmodified; the original API failure and explicit compatibility flag remain in reports. This does not ship with the plugin, modify Prime, or justify exact author-result reproduction. See the [ARC protocol boundary](../../docs/testing/prime-rlm-arc-protocol.md).

4. **Optional native autonomous limits (adapter only).** `src/execution.ts` validates and persists positive `gateMaxRetries` and `maxContinuations`, emitting the original `--autonomous-gate-retries` and `--autonomous-max-continuations` flags only when explicitly provided. The pinned CLI requires positive integers for both flags. Omission retains Prime's default. It does not change Prime, increase Solar's complete-tree request budget, or accept a failed gate. `tests/execution.test.ts` verifies persistence, old snapshots, exact argv and bounds. Actual original/plugin native gate controls are recorded separately from unit checks and measured quality.

5. **Ordinary-conversation operator (adapter only).** `src/index.ts::createOperatorTool` registers `solar_rlm` on the published ToolRuntime, using the current Agent's provider/model and native initialization settings. `RlmHost.waitForResult` follows the native turn and any owned cancellation/cleanup promise; it never polls or repeats a prompt. Failed, cancelled, indeterminate and empty-answer rounds become tool errors. Admission checks the owner signal after persistence, late ACP responses cannot overwrite cancellation, and plugin disposal waits for detached cancellation receipts. A settled successful tool detaches its scoped owner listener without stopping Prime's retained idle kernel. The three existing asynchronous tools keep their receipt behavior. The browser now contributes only Settings. No Prime source or algorithm changed. Lifecycle tests cover the cancellation windows; the built-package scripted Agent fixture checks model schema, native execution and durable parent tool call/result. Real parent-model selection remains a separate unrun check for this UI/operator change.

## Known upstream risks at the frozen pin (2026-10-23)

The [closeout handoff](../../docs/testing/prime-rlm-closeout.md) records these read-only findings. They are not carried patches and do not authorize a runtime update.

- Prime [PR #3708](https://github.com/PrimeIntellect-ai/prime-agent/pull/3708) moves child prompt admission after acknowledgement, preventing early collect from settling an unprompted child. The frozen pin contains the earlier ordering. The merged fix is present in the v0.10.1 release commit; occurrence in our historical real runs is not established.
- [Discussion #3663](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3663#discussioncomment-19097018) reports interim child text being latched instead of a later final answer. The frozen source has the reported first-nonempty capture condition; no local dynamic reproduction or maintainer-confirmed diagnosis of our traces is claimed.
- [PR #3679](https://github.com/PrimeIntellect-ai/prime-agent/pull/3679), merged after the v0.10.1 release commit, adds typed ACP failure classification. A future target must be checked by commit ancestry; selecting v0.10.1 alone does not imply this fix is included. Failure typing does not itself improve semantic answers or make replay safe.

Before changing the pin, distinguish these lifecycle/diagnostic risks from the completed semantic-quality comparisons, select an exact unmodified target, and follow the upgrade/fidelity/install gates above. No improvement claim follows from upgrading.

## Current verification record

See [the canonical verification record](../../docs/testing/prime-rlm-verification.md) for actual source, native, scratch-profile and installed-app evidence. A bounded isolated Codex subscription pilot is recorded there separately. General efficacy, paper reproduction and held-out continual improvement are not established by that pilot.
