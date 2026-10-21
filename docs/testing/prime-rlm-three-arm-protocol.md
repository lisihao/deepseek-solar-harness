# Fixed original-question bare / Prime / plugin comparison

Date: 2026-10-21, Asia/Shanghai. The user raised the cumulative ceiling to **600 requests** and asked the agent to continue without requesting approval for each allocation. The completed supplemental Q03 bare call closes the prefix at **523 = 510 confirmed + 13 retained unknown**. The initial attempt permitted at most 65 new requests, reaching at most 588. Its first connection failed as recorded below; the current recovery starts at 524 and permits at most 65 new requests, reaching at most 589, below 600. Every descendant and transport-unknown request remains charged; no API fallback, retries or extra credits are authorized.

The target is an independently graded completed answer from RLM that is better than the bare model on the same problem. Run the bare model D once, original unmodified Prime R once, and the DSH plugin S once. This also checks whether a real-provider original/plugin gap is visible. A quality difference is observed data, not an assertion that stochastic native trajectories must be identical.

## Frozen case and common guidance

Choose the first file-order 32K numeric description-count item in the already pinned paper-period OOLONG validation shard, without consulting its answers: row index 13, `id=15000243`, `context_window_id=1`, dataset `trec_coarse`. Revision: `616cca899e8b51ea0ad5446ebab39aa72b3192bc`. Shard `validation-00005-of-00007.parquet` SHA-256: `8c0d27a796b471b93cd9323646f80a1b1216f88e16612cfb67df1bbe33dbae4b`. Public context is 78138 UTF-8 bytes, 787 Date-prefixed records, SHA-256 `64e3a042daf4bf66fbbb8b59d0a008179d5d4ce4a1554d7bcc11eba7f2204150`.

The original question and official numeric scorer are unchanged. All arms receive this same added guidance:

> Work only from the provided data; do not look up dataset labels or benchmark answers elsewhere. Check every record rather than estimating from a sample. Work in disjoint batches, keep explicit per-record classifications and aggregate all batches. Use recursive subagents if they are available in your environment.

The guidance is a declared strategy adaptation. The model chooses batches, child prompts and aggregation; no successful decomposition or gold-derived partition is injected. This is an original-task transfer test with added common strategy instructions, not exact numerical reproduction of the paper.

## Conditions and accounting

| Condition | Model-visible material and execution | New request ceiling |
| --- | --- | ---: |
| D1 | One user message with common guidance, complete context and original question; no caller-supplied system prompt or tools | 1 |
| R32 | Direct original Prime ACP, common guidance and question, same context in `inputs/context.txt` | 32, entire tree |
| S32 | Solar host wrapping the same original Prime binary, identical R task prompt and context file | 32, entire tree |

All use `openai-codex/gpt-6.1-sol`, reasoning `high`, configured `maxTokens=16384`, twenty-minute condition wall time, and a fresh isolated state. The underlying subscription SDK does not serialize a maximum output-token field for this route; 16384 is a checked configuration value, **not an experimentally enforced token ceiling**. Actual provider-reported usage is retained. No provider or model implementation is changed to address this limitation.

R/S use native depth one, Factory and refinement learning disabled, and the same autonomous 32-turn / 4000000-token configuration. Both write a JSON-encoded Answer string to `answer.json`; D returns that Answer text directly. This output-medium adaptation is recorded. Parent and native request guards both use 32, avoiding the earlier thirteen/fourteen mismatch. Depth one permits recursion; actual child requests and contribution evidence are reported separately.

The unchanged official OOLONG numeric scorer is pinned at commit `0bb7eabe839218fee7fe8d007f41cfc2fd3ae24c`, file SHA-256 `247583a3b653b91c39fb88a102460802f1493175b23d05a7217aead0d685c64c`. Score is `0.75 ** absolute_count_error`; exact match and absolute error remain visible. Private labels, gold, another arm's output and prior outcomes are never sent to an arm. The earlier negative comparisons and the mixed Q03 result remain retained.

## Pre-dispatch and completion evidence

Run the frozen `quality-pilot-v1` worker through both direct Prime and Solar using only local scripted chunks. Each must actually spawn a child, preserve root/child Python state across cells, collect a settled child and derive 42, deny public-input writes/private-canary reads/public-network sockets, and cleanly shut down. Bind source hashes, compiled bytes, runtime manifest and proof to the prepared real experiment. This mechanism acceptance makes zero real model requests and does not prove quality.

Preparation loads no credentials/provider. Real dispatch validates the closed Q03 prefix, all prepared/source/input/runtime/proof hashes and exclusive markers before loading the provider. The existing logical/physical ledger admits at most one physical POST per logical call. A transport unknown or failed cleanup prevents starting later conditions; wrong answers do not silently disappear. All completed, incomplete and unstarted conditions are retained. The full local source gate runs once at the stable boundary; unchanged evidence is reused.

Affected source: the explicit quality worker protocol and its checks, the reusable native condition executor, `tools/rlm-quality-pilot/three-arm.*`, its zero-model native acceptance, package test selection and these reports. Prime, production plugin defaults and installed app bytes stay unchanged. No installation, merge, release, market publication, Jev or automation is included.

## Recorded pre-dispatch evidence

The full local `pnpm check` passed build/typecheck, 162 Vitest tests, 46 ARC checks, 54 recursion checks, 22 quality checks, the built-package disposable-profile test and generated homepage/market guide checks. A final receipt-only sanitization edit then passed all six affected three-arm tests. Native worker configuration/sandbox checks passed separately. None loaded a real provider.

The first zero-model native attempt completed both R and S mechanisms and cleanup, but its final source-binding check rejected a concurrent receipt-sanitization edit. That unaccepted attempt and both outcomes remain retained; no subscription request was made. The stable-source second attempt accepted both paths: each used five scripted root and three scripted child requests, preserved root/child Python state, collected the settled child and derived 42. Both input-write/private-canary/public-socket isolation checks passed. R's retained result confirms direct original ACP; S confirms the Solar host. Independent process inspection found no owned process, and both retained Unix socket artifacts refused connections. The accepted proof SHA-256 is `53ecde646618e4cf814d5db95e44236b4bf4531afcc5dc01862c7df74722cd26`.

Compiled hash remains `7c4aa9fa77bd6514f13deaa5a6a10607bb60efdc526feb91e6b7f3e49415c2a3`; runtime-manifest SHA-256 remains `b6e34a977b4eb782b9a6e2c12436ad911adf30b511bd3df73214b55f829107f9`. The actual new public task was independently aligned against all 787 labelled source records; the original numeric gold equals a separate count of target labels. The model receives none of those labels. Cumulative real usage before this panel remains 523/600. These results validate the runner/mechanism; real quality results are still pending here.

## Retained connection failure and one manual transport recovery

The initial real attempt at source `23e3c67ba8abef5be9c3e5d9f2426c5b1d3e58b6` dispatched one bare POST but failed with `UND_ERR_CONNECT_TIMEOUT` after 10512ms. Its metadata GET had returned 200; no model response headers, final answer or usage arrived. Both native arms were never started. The [unscored attempt receipt](prime-rlm-three-arm-initial-failure.json) is retained; one charge remains unknown rather than refunded. Provider, relay and both transport profiles closed, and independent inspection found no owned runner. Its closed prefix is **524 = 510 confirmed + 14 retained unknown**. The closure SHA-256 is `60482a0706f09649d6e7d72c8ca7a3c8cdfe2f6c8253f03433a5486763207665`. Server completion is not claimed known.

The parent's owned Agent had inherited a ten-second connection timeout. The recovery explicitly sets a thirty-second connection timeout for the same exact Codex POST, retaining the twenty-minute body timeout, signal, request bytes and zero SDK retries. A local TCP listener that accepts but never completes TLS verifies the configured short connection timeout with actual Node fetch, one connection and complete cleanup. A separate credential-free metadata GET with the same Node/IPv4/owned-Agent path returned 401 after 1484ms, establishing TLS connectivity only; it did not request a model.

After those client effects are closed, one separately marked recovery attempt may use the identical frozen task, guidance, scorer, model and D1/R32/S32 allocation. No answer quality was observed or used to change the task. It uses a fresh namespace and the actual 524 prefix; the old request is not silently retried or erased. An exclusive allocation next to the prior closure prevents another output directory from reusing the same spending prefix. Model/provider retries remain disabled.

The recovery source passed the complete local gate: build/typecheck, 162 Vitest tests, 46 ARC checks, 54 recursion checks, 25 quality checks, built-package disposable-profile behavior and homepage consistency. Its re-bound actual native proof again completed both original/plugin paths, with three scripted child requests each and zero real requests; independent process/socket closure passed. Proof SHA-256: `0c8113c1d4fad43ac8a3bb6d535bbe7c9eb78ff1467caa91e09c33fe2aeb8102`. Public input, common guidance, original scorer, Prime binary/runtime and model configuration are unchanged from the first attempt.

## Completed panel and separate exploratory recovery

The source-82a0e0d run is closed at 589 = 575 confirmed + 14 unknown. D returned 116 against gold 121; both original Prime and the plugin made seven root plus twenty-five child calls without producing answer.json. See the [results and native timing diagnosis](prime-rlm-three-arm-results.md). The declared panel remains incomplete as a quality comparison. A distinct [eleven-request exploratory recovery](prime-rlm-quality-recovery-protocol.md) preserves that result and the same task/model/scorer, while adding the operational parent-turn instructions supported by the diagnosis.
