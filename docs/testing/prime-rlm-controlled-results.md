# Fixed same-question recursion-control results

Date: 2026-10-21, Asia/Shanghai. This [exploratory fixed panel](prime-rlm-controlled-protocol.md) **did not establish a recursive-plugin quality improvement**. Bare D completed with official score **0.75**. Non-recursive plugin S0 completed with **0.5625**. Original Prime R and recursive plugin S both failed the original native completion gate. The [sanitized machine-readable report](prime-rlm-controlled-results.json) retains their different completion and scoring states.

| Condition | Task status | Official score | Root / child requests | Elapsed time |
| --- | --- | ---: | ---: | ---: |
| Bare D1 | Completed | 0.75 | 1 / 0 | 292673 ms |
| Original Prime R32 | Incomplete; native gate failed | 0.017817948013544083, diagnostic only | 15 / 17 | 494193 ms |
| Recursive plugin S32 | Incomplete; no final answer | Unscored | 13 / 15 | 487865 ms |
| Non-recursive plugin S0_32 | Completed | 0.5625 | 15 / 0 | 295457 ms |

The R file is a retained diagnostic, not a successful completion. A file's later existence does not override the original terminal gate failure. S has actual child calls but no final answer. No child aggregate or draft is promoted to a main answer. Independent S0 grading reproduced 0.5625. Its recorded calls all have depth zero, one session id, an empty child roster and no recorded helper/Factory bypass. Both continuation workers physically closed; no qc4-owned process remained and both retained sockets refused connection. Completed-worker status alone is not the acceptance criterion.

All conditions retain the same task/model/high reasoning and common policy. Native maximums were matched at 32 whole-tree requests; actual use differs. The configured maxTokens value is 16384, but the subscription SDK does not serialize a backend output-token ceiling. Provider-reported usage, including cache-related totals, is preserved rather than reconstructed from selected fields.

## Original/plugin differential and continuation

Independent comparison found the first real R/S provider options identical after replacing only their exact owned path prefixes, conversation-log path line, sessionId and message ids. Tools, route, common task, dates and substantive content match. The normalized SHA-256 is `3c5982c045b1ee39a86eb9a8e248ed57c84aad2c7529f37188696eb1d31db1a9`. This excludes an observed initial-request content gap here; it does not prove every later trajectory is equivalent.

The first parent process stopped after R because it conflated a failed worker exit with incomplete resource cleanup. R's shutdown, frontend exit and bridge closure succeeded, physicalCleanup was true, and independent process/socket checks confirmed closure. R remains an incomplete task. Only the never-dispatched S/S0 conditions continued in a new namespace and ledger; D/R were not resampled.

The first continuation attempt failed before logical admission because a parent-intents directory was missing: zero real model requests. Its records and closure remain retained. A fresh namespace then passed a synthetic directory/dispatcher/settlement check before real dispatch. Synthetic ledgers are separate and are not subscription requests. The source-99dab45 native worker, Prime binary, Python kernel, recursive APIs and Continual Harness were unchanged.

## Accounting and limits

The fixed panel added **76 confirmed logical and physical requests**, no new unknown: 33 for D/R and 43 for S/S0. Cumulative usage is **676 = 662 confirmed + 14 retained unknown**, zero in flight. The phase ran under its historical 700 cap. The user's later additional 100-request authorization raises the current cumulative cap to **800**; it does not rewrite old receipts, refund unknowns or change the running panel. No paid API, extra credit, installed-app update, merge or release was used.

This task has already been used for operational fixes, so the panel is neither held-out confirmation nor exact paper reproduction. There is no completed S−D or S−S0 quality pair. The completed S0−D contrast favors D in this sample. The earlier [mixed Q03 primary-F1 gain](prime-rlm-q03-bare-supplement-results.md) and all prior adverse/incomplete results remain separate and retained. The next work must reconcile the observed native gate behavior before allocating further real calls; a hypothesis is not a cause until verified.

Raw answers, reference answers, private labels, account data, sessions and provider payloads remain outside Git. Final reports expose only completion, sanitized scores, resources and evidence hashes.

The pinned-source gate diagnosis distinguishes R gateAttempt=1 (not proven exhausted) from S gateAttempt=4, which exceeds the original default of three. A later strict zero-model contrast verified both original CLI limit options and the separate default of three autonomous continuations. The latest-source recursive R/S and depth-zero S0 controls also passed. See the [native configuration protocol](prime-rlm-gate-protocol.md). Native gate failure remains a failure. This is configuration diagnosis, not a quality result.
