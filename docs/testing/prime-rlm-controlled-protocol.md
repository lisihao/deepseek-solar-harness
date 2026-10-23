# Fixed original-question recursion control after the 600-request checkpoint

Date: 2026-10-21, Asia/Shanghai. The user explicitly added at most 100 requests. The actual closed prefix is **600 = 586 confirmed + 14 retained unknown**; the new hard ceiling is **700**. One fixed four-condition panel may add at most 97, reaching at most 697. The remaining three are not automatically spent. Every root, tool turn and descendant remains charged as a request; no unknown is refunded. No paid API, credit purchase, automatic retry or resampling is permitted.

## Case and comparisons

Retain the original 787-record OOLONG TREC question, task id `oolong-trec-32k-15000243`, public context SHA-256 `64e3a042daf4bf66fbbb8b59d0a008179d5d4ce4a1554d7bcc11eba7f2204150`, dataset revision `616cca899e8b51ea0ad5446ebab39aa72b3192bc`, and unchanged official numeric scorer SHA-256 `247583a3b653b91c39fb88a102460802f1493175b23d05a7217aead0d685c64c`. Reference answers, labels, earlier outputs and the scorer's private inputs are never available to a model. Raw and reference answers remain in local parent-private evidence; public reports contain only sanitized metrics and accounting.

This case has already been attempted. The panel is an exploratory operational comparison after the [failed original/plugin panel](prime-rlm-three-arm-results.md) and [eleven-call recovery](prime-rlm-quality-recovery-results.md), not a held-out confirmatory test or exact paper reproduction. All earlier outcomes remain retained. The case, conditions, order and instructions are fixed before these new calls.

| Order | Condition | Capability | Maximum requests |
| --- | --- | --- | ---: |
| 1 | D1 | Bare model, no caller-supplied tools or system prompt | 1 |
| 2 | R32 | Original unmodified Prime ACP, depth one | 32, whole tree |
| 3 | S32 | Plugin wrapping the same Prime, depth one | 32, whole tree |
| 4 | S0_32 | Same plugin/REPL/external input, depth zero | 32, whole tree |

All use `openai-codex/gpt-6.1-sol`, reasoning high, configured maxTokens 16384 and a twenty-minute condition wall limit. Native arms have the same 32-turn/4000000-token autonomous configuration. The subscription SDK does not serialize an output-token cap, so actual usage is retained; 16384 is a configuration value rather than a verified token ceiling. No model capability or reasoning setting changes. The bare SDK may supply its own standard instruction; “no caller-supplied system prompt” does not mean no backend instruction.

S−D measures practical extra-computation benefit in this case. S−S0 is the matched-maximum-budget recursion contrast. R−S checks an original/plugin gap under the same model, task, native capabilities and operational instructions. Different stochastic trajectories are expected; a single score difference does not by itself establish packaging failure or general benefit. Declared maximums are equal among native arms, while actual resource use is reported rather than forced to match.

## Operational policy

Keep the common exhaustive batching guidance. Every arm also receives the same policy: preserve the original six category names rather than inventing new definitions; if delegating, let children classify the original questions independently, without a parent-invented taxonomy. When recursion is admitted, use at most two children, end the parent assistant turn after spawning and wait for native child-exit notifications. Do not steer a child before it settles. Check complete coverage and audit borderline decisions. In a code environment, save the JSON-encoded final Answer string in answer.json in the same Python cell that computes the aggregate.

Use only the admitted recursion setting. Do not create separate depth-zero sessions, Factory children or another helper path to bypass depth zero. When recursion is unavailable, perform the work in the current agent. Factory and refinement learning remain disabled for this quality panel. Prime's binary, kernel, scheduler, messaging, recursion and Continual Harness implementation remain unmodified.

The exact common instruction is bound in the prepared manifest. The two-child limit, independent-classification rule, no-early-steer rule and end-turn instruction are model instructions, not replacements for the original Prime runtime. The native spawn API enforces its configured maximum depth, and the parent ledger enforces request ceilings. Other helper APIs are prohibited by instructions and examined after the run; depth zero alone is not evidence that every helper path was absent. Actual compliance is examined after the run; violations and invalid controls are retained. No successful decomposition, category decision or benchmark answer is supplied.

D receives the complete context inline and returns text; native arms read the identical bytes from inputs/context.txt and write one JSON string. This input/output-medium adaptation is explicit. Root R/S provider envelopes are compared with only exact owned paths and session/message ids normalized; task dates and substantive content are never normalized away.

## Preparation, proof and stopping

Preparation binds the actual 600-call closure and independent verification, latest human authorization, source/lock/package hashes, compiled bytes, runtime manifest, public input and prompts. It loads no provider or credentials. The new explicit quality-control-v1 native protocol leaves all historical protocols unchanged.

Zero-model proof runs R/S/S0 through the same executor and local scripted chunks. R/S must execute persistent root/child cells, spawn/settled collect, derived fixture output, existing isolation checks and cleanup. S0 must show native depth-zero spawn refusal and no child request. This proves covered mechanisms, not semantic quality or real-model compliance with instructions.

Real dispatch revalidates the proof and all bindings before reading credentials. Exclusive prior-allocation, run and condition markers prevent reuse or replay. The parent ledger separately limits logical and physical requests, with D1 capped at one and each native tree at 32; the native host has the same 32 ceiling. Unknown requests or failed cleanup stop later conditions. Wrong answers and missing outputs remain recorded; worker lifecycle completion is insufficient for task completion.

Valid final numeric answers are scored by the unchanged pinned official scorer, without another model judge. Independent evidence must verify final-answer completion, actual recursion/contribution, S0 control validity, full-tree usage, owned process/socket closure and the cumulative cap. Public-shaped receipts allowlist score/exact/parser-confidence/scorer identity; raw answers, reference answers, labels, provider payloads and account data remain private. Process-crash recovery must reconcile existing effects before any further run; no marker is cleared automatically.

No installed-app update, merge, release, market publication, Jev or recurring automation is included. Relevant source checks and actual zero-model native acceptance must pass before real dispatch. Reports reuse those unchanged results rather than triggering another full gate for prose edits.
