# Prime RLM verification record

Date: 2026-10-20, Asia/Shanghai. PR: [#280](https://github.com/lisihao/deepseek-solar-harness/pull/280).

Implementation and installation are authorized. Paid experiments, merge, release, tags, Pages and market publication are not authorized by this task. The package remains `@lisihao/dsh-solar-rlm@0.1.0-dev.0` under `incubator/rlm`.

## Identity and execution boundary

| Input | Verified identity |
|---|---|
| Prime source | Clean `7cbffa77b38facd7c87277fa3c82bcadbe816880`, CLI 0.10.0, MIT |
| Original native binary SHA-256 | `6e2780ce477b52e23f24afcc24fc332026aa628fa9cd9a7a25659b997e61cca0` |
| Offline capsule SHA-256 | `ffa9ef5854d625ee7f22dca0876867a78b886d1b249102f491e9a9ab56c1983d` |
| Python | Relocatable CPython 3.12.13, all nine Prime Python skills and pinned dependency closure |
| Source-to-loaded checks | 89 critical hashes, including 24 actual loaded Prime source/machine-data mappings; byte-for-byte match to the pin |
| Python third-party lock SHA-256 | `a7c8ef7ef10f84cca2a788601b4e5f444448812a9ad855af2bd4e891904fa2c7` |
| Host baseline | Published DSH 0.2.1-rc.2 / Cordis 4.0.5 |
| Development environment | macOS arm64; plain Node 26.7; source packages share host peer modules |
| Adapter/test/build input fingerprint | `7a993b1ba5d47febd801359dbacac3356554f8142bb16bf9f73c70b68cabe6b4` (36 files; excludes generated `lib`, payload bytes and prose) |

The manifest and provenance are in `incubator/rlm/runtime-lock/capsule.json`; large runtime assets are generated and ignored by Git. No Prime source or official Harness runtime was patched. Source identity does not alone certify every provider behavior or evaluation case.

## Checks run

| Check | Actual result |
|---|---|
| Clean source, locked Rust release build, binary version/hash | Run: passed |
| Offline Python dependency/import/protocol-v3 checks and relocation | Run: passed |
| Actual capsule extraction and critical-file validation | Run: passed; hot validation also passed |
| DSH plugin metadata audit | Run: 7 OK, 0 warning, 0 error |
| Root build, strict typecheck and unit suite | Run: build/typecheck passed; 18 test files, 136 tests passed |
| Affected entrypoint recheck after service-injection repair | Run: 7 tests passed; rebuilt ESM/CJS/declarations passed |
| Existing native-plugin scratch-profile gate | Run: passed, including Resident shutdown; no repeated run needed for unchanged native source |
| Built RLM package in disposable published-baseline profile | Run: passed, service and three ordinary tools registered |
| Actual original native RLM/Harness self-test in that profile | Run: all 14 checks passed; 18 scripted local protocol requests, 0 real-provider calls |
| Full `ctx.llm` bridge, follow-up, stop and original `--resume` | Run: passed; 3 local FakeAdapter dispatches, correct fixed route/context/output budget, linked intents/settlements, 0 paid-provider calls |
| Remove both test bundles and confirm profile bundle removal | Run: passed |
| Independent bounded adapter review | Run: reported defects repaired and rechecked; no remaining actionable finding in that review's scope |
| Homepage/market-guide regeneration and check | Run: passed; no published plugin entry invented |
| Existing-app installation and rendered default/narrow UI | Not run at this source-verification checkpoint; update below after installation |
| Real-provider/model acceptance | Not run; this task does not launch paid model experiments |

The initial `pnpm check` reached the RLM integration lane and exposed a missing declared `llm` injection. It was repaired for both plugin and probe; the affected build/entrypoint/profile checks were rerun. A subsequent bridge failure came from the fixture selecting `off` for a model declaring no reasoning settings. The fixture now supplies the valid no-effort route; the Host preserves Prime's internal `--thinking off` without inventing a DSH provider effort. The final bridge passed. Passing unaffected native/unit evidence was reused; the failed aggregate command is not presented as a successful command.

## Native mechanism evidence

The explicit local self-test drives the **original native binary**, with a private agent directory/socket and a scripted loopback model. Python code, native requests and child receipts perform the computations; the fake controller does not substitute the answer.

- Persistent cells keep state across calls.
- Root → child → grandchild spawn, native child-exited continuations and collect produce the observed 42 → 43 → 42 receipt chain.
- A real Factory seed starts, reports status and is stopped through the original executor.
- Harness memory creation/update records the native revision change.
- `refine.run` moves pending state at the turn boundary; the original planner applies a real memory edit and records history.
- The following native provider context contains the original `refinement_notice`; original `/refine rollback` removes the entry and appends the rollback history.
- Native child roster, owned daemon shutdown, frontend exit and loopback cleanup are checked.

The next-turn refinement assertion concerns Prime's provider context, **not** a claim that one Python kernel hot-reloads another session-local Harness store. Factory live asyncio state remains memory-only across a cold kernel restart, as in the reference.

Adapter failure tests cover malformed ACP/framing, causal sequence and prompt mismatches, `end_turn` without native terminal evidence, outstanding descendants/continuations, unknown formats/effects, replay conflicts and restart recovery, full-tree request reservations, and cleanup despite persistence/transport faults. Confirmed native stop with an unsaved receipt is distinguished from an unconfirmed stop.

## Installation checkpoint

Pending at this checkpoint: pack the verified build to a stable path; quit the official app; back up affected desktop profile configuration; install only this package through the bundled CLI; relaunch; inspect enabled state and normal explicit local self-test; verify default/narrow rendering and disable/enable behavior; compare unrelated configuration and credentials without publishing their contents.

## Evaluation claims still unavailable

The [evaluation contract](prime-rlm-evaluation.md) remains separate from these engineering checks. G1 has source identity and representative native mechanism evidence; its complete F01–F12 differential matrix and real-provider coverage are not certified by this report. G2 reasoning-quality benefit, G3 original-paper reproduction and G4 held-out Continual Harness improvement are **not run**.

No measured reasoning, cost or latency improvement is claimed. Forced scripted recursion is plumbing evidence. Installation, unit tests, a native self-test or a passing CI job does not replace matched real runs, independent grading, full-tree accounting and negative controls.
