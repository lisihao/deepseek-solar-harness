# Original OOLONG bare-model quality pilot: goal not demonstrated

Date: 2026-10-21, Asia/Shanghai. [Frozen protocol](prime-rlm-bare-quality-protocol.md). This report is generated from the retained receipts summarized in [the result JSON](prime-rlm-bare-quality-results.json).

The requested quality benefit has **not been established**. The bare model completed; the recursion-enabled RLM run exhausted its parent allowance without completing and made no child request. Its saved draft was worse. Neither a running engine nor a draft output is counted as a successful quality comparison.

| Arm | Final or saved answer | Absolute error against 314 | Official numeric score | Real model requests | Actual child requests | Execution |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Bare model | 291 | 23 | 0.0013378550 | 1 | 0 | Completed |
| RLM draft | 269 | 45 | 0.0000023865 | 13 | 0 | Incomplete; next request refused before admission |

Both used Codex gpt-6.1-sol/high and the same original 64K TREC material and question, frozen before outcomes. The bare model's 153618-byte full input was independently checked against the task; S read the same 153459-byte context from a read-only file. The original official numeric scorer is unchanged. Prime reported native depth one, but no actual descendant request occurred. The saved draft cannot establish a completed-pair quality loss or gain; it is retained as diagnostic evidence.

The RLM strategy stayed in its root Python REPL: it loaded the context, attempted external label lookups, inspected batches and maintained a persistent index set. The saved 269 was computed from that set and written before cancellation; the separate candidate file had 310 unique indices and was not the final count. All thirteen physical requests belonged to the same root session. The evidence does not establish why the model never invoked spawn. The stop occurred after 370395 ms, below the twenty-minute wall limit: the parent allowed thirteen RLM requests while the native outer guard still allowed fourteen. The fourteenth native intent was refused before a new admission. That mismatch is a runner limitation, not evidence that the unfinished draft was a final native answer.

Two earlier attempts remain visible: a DSH message-shape failure before a physical model POST, then a real bare request terminated by Node's five-minute idle body timeout. Neither produced an answer; their S comparators never started. The message-shape and body-timeout fixes passed actual compiled-wire and Node-fetch local tests. V3's fourteen physical model requests all settled with known usage. Its RLM worker exited with code 1 after the stricter thirteen-call parent limit; original shutdown/physical cleanup passed, the retained Unix socket refused connection, and independent process inspection found no owned worker or Prime process. Provider, relay and both network profiles closed.

The denominator is six planned conditions across three retained attempts: one completed, three incomplete and two not run. The quality pilot added sixteen charged admissions, fourteen confirmed and two unknown, to the previous 506. Cumulative accounting is **522 = 509 confirmed + 13 retained unknown**, exactly the authorized cap. No further model request is authorized by that cap. No quality gain, task-routing condition or cost threshold is inferred.

The source at `6735129c2cacaaae3539dd79909e27ed6db84818` passed the full local gate and [GitHub CI](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39541904107/job/119031316916). All sixteen focused quality checks passed. Prime, the production plugin and installed app bytes were unchanged. The compiled host hash still matches the earlier accepted original-runtime proof. Raw transcripts, private labels, local credentials and native state remain outside Git.
