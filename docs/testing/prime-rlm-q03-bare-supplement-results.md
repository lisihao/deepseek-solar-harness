# Q03 retrospective bare comparison: one primary-metric gain, mixed secondary result

Date: 2026-10-21, Asia/Shanghai. [Machine-readable result](prime-rlm-q03-bare-supplement-results.json).

A completed Prime RLM result has a higher frozen primary pair F1 than the newly completed bare-model baseline on the same Q03 task: **0.240000 versus 0.205882**, a difference of **0.034118**. The secondary label-accuracy result goes the other way. This is one observed main-metric benefit; it does not establish a general or causal recursion improvement.

| Metric | Bare D | Recursive S |
| --- | ---: | ---: |
| Pair F1, frozen primary metric | 0.205882 | 0.240000 |
| Pair precision | 0.200000 | 0.214286 |
| Pair recall | 0.212121 | 0.272727 |
| Pair TP / FP / FN | 7 / 28 / 26 | 9 / 33 / 24 |
| Correct labels out of 438 | 408 | 404 |
| Complete, valid and self-consistent output | Yes | Yes |
| Real model requests | 1 | 14 |
| Actual child requests | 0 | 8 across four children |
| Execution and cleanup completed | Yes | Yes |

Both used Codex gpt-6.1-sol/high and byte-identical public records/rules. The task instruction is unchanged except for explicit output delivery: bare D returns the requested JSON file contents as text; S wrote that same schema to a file. Both final answers were independently regraded with the same arm-blind grader; coverage contains every record exactly once. Of the labels, 401 were correct in both outputs, 27 wrong in both, seven correct only in D and three only in S. No single secondary metric is hidden to support the primary result.

The earlier S was reused because it completed with actual recursion and lacked a bare baseline. It was not resampled. This is a retrospective comparison on the custom OOLONG MultiNLI user-pair aggregation query, with different run times and unequal computation. It is not original-paper reproduction or a controlled isolation of recursion. The earlier S0 result remains better than S on pair F1 (0.307692 versus 0.240000).

The new bare run had one logical admission, one physical POST and one settled request, completed in 341544ms. Actual reported usage was 23685 input / 18502 output / 42187 total tokens. The configured maxTokens value was 16384, but the installed Codex SDK does not serialize a maximum-output-token field for this route; no hard output-token ceiling is claimed. Provider, relay and both transport profiles closed; independent process inspection found no owned runner. No failed or unknown request was refunded.

Cumulative spending after this supplement is **523 = 510 confirmed + 13 retained unknown**. The user subsequently authorized a total ceiling of **600**. The [fixed original-question three-arm panel](prime-rlm-three-arm-protocol.md) is the next separate validation; its outcomes must not be inferred from this sample. Production Prime/plugin defaults and installed app bytes are unchanged.
