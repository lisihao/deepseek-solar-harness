# Native recursion ablation results

Date: 2026-10-21, Asia/Shanghai. **One valid recursive/non-recursive pair completed; recursion did not improve this task.** Pair F1 was S0=0.307692 and S=0.240000; label accuracy was 408/438 and 404/438 respectively. Cumulative spending is 506/522, including all 11 unknown charges. This record separates transport failures, native mechanism evidence, completed answers, and measured quality. The [frozen protocol](prime-rlm-recursion-protocol.md) defines the original four-condition panel; subsequent engineering revalidations keep their own manifests and all earlier outcomes.

## Question and acceptance boundary

The previous ARC protocol forbade children and used native recursion depth zero. Its results therefore cannot answer whether recursive model calls improve reasoning. This follow-up compares the same original Prime engine with native depth zero (S0) and depth one (S), using byte-identical dense semantic-aggregation inputs, the same Codex gpt-6.1-sol/high route, 16,384 output-token limit, persistent Python, public tools, 14 whole-tree requests, 14 autonomous turns and a 20-minute limit per condition. Factory, refinement and cross-task learning are disabled equally. Prime source, the runtime capsule and production plugin defaults remain unchanged.

The inputs are custom Q02/Q03 queries over pinned OOLONG MultiNLI material, with 438 records per task. Q03 additionally derives all user pairs satisfying public count constraints. Private source labels are inaccessible to the worker. An independent grader validates complete unique record coverage, labels, counts and pair sets. This is not an exact reproduction of the original RLM paper. A complete schema and observed real child model calls are necessary before interpreting a pair as recursive quality evidence.

## Retained engineering failures

The original panel order was Q02/S0, Q02/S, Q03/S, Q03/S0. The first three conditions stopped on transport errors after 5, 2 and 2 charged requests respectively; Q03/S0 was never started. Neither S condition reached a physically admitted child model call. There is no completed matched quality pair in that panel. Missing outputs receive zero under its frozen reporting rule, but these zeros do not establish inferior model reasoning.

| Original condition | Status | Requests | Confirmed | Unknown | Actual child requests |
| --- | --- | ---: | ---: | ---: | ---: |
| Q02/S0 | Incomplete: ECONNRESET | 5 | 4 | 1 | 0 |
| Q02/S | Incomplete: TLS connection reset | 2 | 1 | 1 | 0 |
| Q03/S | Incomplete: fetch failed | 2 | 1 | 1 | 0 |
| Q03/S0 | Not run | 0 | 0 | 0 | 0 |

After actual native shutdown, worker exit, endpoint refusal and provider/relay closure were verified, a fresh Q03 pair was declared before any quality result. Both conditions used process-local `NO_PROXY=chatgpt.com`, IPv4-first DNS order and disabled automatic address-family selection. Its S0 condition completed eight requests, then its ninth failed with `fetch failed`; no complete answer was written, and S was not started. This phase retained nine additional charges, including one unknown. Fixed IPv4 did not resolve the observed failure.

An unauthenticated HEAD check is only TLS/HTTP evidence: 24 alternating default/`Connection: close` checks to the actual endpoint returned HTTP 405. They consumed no model requests and do not certify an authenticated streamed model connection. The next declared fresh Q03 pair adds `Connection: close` in the parent transport and allowlisted undici error diagnostics. It does not alter the installed provider, Prime engine, model parameters, task, tool history or request body, and introduces no automatic retry.

## Mechanism evidence and limitations

The separate zero-model native fixture observed Prime's original depth-zero refusal, a real depth-one child reading the same public input, persistent state across child Python cells, original collect, root consumption of the collected receipt, denied input writes/protected reads/public networking, and complete owned cleanup. It used ten scripted responses and zero real-provider requests. This is mechanism evidence only.

The surviving historical prefix is 463 charged requests: 456 confirmed and seven unknown. Its old temporary individual ledger is no longer available; the exact committed aggregate is retained, rather than reconstructed request identities. All new ledgers and evidence live in a persistent private artifact directory. No unknown charge is refunded. Credentials, raw model traces, private labels and native state are excluded from Git.

Source/CI acceptance, the earlier installed-app fixture, isolated subscription behavior, quality benefit, exact paper reproduction and held-out Continual Harness improvement remain separate evidence lanes. This follow-up does not install a new plugin artifact or authorize merge, release, market publication, paid API fallback or additional credits.

## Completed matched pair

Both conditions completed, produced schema-valid outputs covering all 438 records, preserved the public inputs and passed native cleanup. Both received the same 14-request whole-tree ceiling; actual spending differed. The [machine-readable result](prime-rlm-recursion-results.json) retains every planned condition and hash-bound evidence.

| Metric | S0: recursion disabled | S: recursion enabled |
| --- | ---: | ---: |
| Correct labels | 408 / 438 | 404 / 438 |
| Label accuracy | 93.1507% | 92.2374% |
| Pair F1, primary score | 0.307692 | 0.240000 |
| True / false positive pairs | 10 / 22 | 9 / 33 |
| False negative pairs | 23 | 24 |
| Exact counts / exact pair set | No / No | No / No |
| Output self-consistent with its labels | Yes | Yes |
| Root / child model requests | 11 / 0 | 6 / 8 |
| Real child agents | 0 | 4 |
| Actual model requests / allowed maximum | 11 / 14 | 14 / 14 |
| Known non-cached input tokens | 42,328 | 117,274 |
| Known cached input tokens | 234,368 | 102,784 |
| Known output tokens | 6,176 | 11,575 |
| Known total tokens | 282,872 | 231,633 |
| Elapsed seconds | 210.491 | 343.696 |
| New unknown requests | 0 | 0 |

The token buckets are disjoint: total includes non-cached input, cached input and output. These are provider-reported usage fields, not a price or general cost-efficiency conclusion. Equal admission ceilings do not imply equal actual token consumption. The final pair used 25 confirmed requests and added no unknowns. Its parent-only connection-close profile permitted this pair to finish, but one success does not prove the underlying intermittent network fault is resolved.

## What explains this negative result

All four child output files, covering 110, 110, 110 and 108 records, contributed their labels unchanged to the final recursive answer. Their correct counts were 104, 102, 102 and 96. The model used original spawn and collect; observed collect snapshots were still running, and a model-created background Python aggregation job consumed the completed child files. This is not a claim that the root consumed a settled collect receipt in the real trial.

Both methods derived counts and pair sets correctly from their own predicted labels. There is no observed loss of child labels or aggregation defect in this pair. Comparing labels against the independent gold: 400 were correct in both methods; recursion fixed four flat errors, introduced eight errors where flat was correct, and both methods were wrong on 26. The difference therefore lies in semantic classification, with four additional recursive errors. In particular, contradiction-to-neutral errors were 20 in S versus 16 in S0. These are observed error locations, not a proven general cause of child-model mistakes.

The exact user-pair query amplifies small classification differences: it requires equal neutral counts and a bounded entailment-count difference. S produced 42 pairs, of which nine were correct; S0 produced 32, of which ten were correct, against 33 gold pairs. Both methods had incorrect per-user count vectors for 21 users. This explains the arithmetic propagation from label mistakes into F1; it does not imply that recursion universally reduces quality.

The root split the corpus and delegated classification without an independent semantic verification pass. Recursion expanded the execution structure but did not automatically correct those classifications. S0 also completed this material without a context failure. This single case cannot establish a long-context advantage, a general negative effect, an optimal chunk size, or which individual prompt/decomposition choice caused the semantic errors. No post-result tuning or further sampling was used to search for a positive score.

## Final accounting and delivery boundary

Across all three declared panels, eight conditions were planned: two completed, four were incomplete after transport failures, and two were not run. All outcomes remain retained. New requests total 43: 39 confirmed and four unknown. Adding the unchanged historical prefix gives **506 charged = 495 confirmed + 11 unknown**, below the 522 cap. No request remains in flight. Sixteen requests remain unused; another complete reservation at the current two-tree/14-request design would require 28.

Original native shutdown, both worker exits, provider/relay closure and removal of the parent fetch profile passed. Independent endpoint probes returned connection refusal, and process inspection found no remaining process owned by these experimental roots. The final closure receipt SHA-256 is `c3fd18c63b72a40176867bd311df274d05b2d22a653e3c4dd88b87b230d65593`.

Execution helpers and compiled host were frozen at source head `673eb9ee97ec588fc87d8b8073d0910d068247d3`; the later continuation/network drivers had separately pinned hashes and retained source snapshots. The final source delivery adds portable checks and this derived report, not a new installed artifact. CI previously exposed a fixture accidentally requiring the private, uncommitted native capsule; the fixture now creates its own synthetic manifest. The full source gate and remote CI are recorded separately in the verification record.
