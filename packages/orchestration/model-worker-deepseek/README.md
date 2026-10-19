# dsh-model-worker-deepseek

English | [中文](README.zh.md)

Optional DeepSeek official API worker for sealed nodes. Its offers are metered and therefore lose to every usable native-subscription offer in the default allocator. Ordinary nodes remain text-only. An RLM node receives the single sealed `typescript_repl` function tool and executes its model-requested calls through the owner-local bridge; this replaces the former fixed branch fan-out with the same programmable runtime used by native-subscription operators.

## Explicit tool execution

`toolExecution` lets CodeAct-style Consumers use the same `generateWithTools` loop, owner-local `typescript_repl` bridge, physical-request observation and evaluation admission as RLM. It does not enable RLM context placement or grant child-spawn permission. The explicit `maxToolRounds` takes precedence; without it, an enabled RLM plan keeps its previous derived limit. A bound of N permits at most N bridge-execution rounds and N+1 model requests; a tool call in the final response fails without another bridge call. Missing or incompatible bridges fail before provider dispatch. Unknown usage remains absent for each physical request. The aggregate may retain only known usage and does not prove a complete total. Failure does not restart the command.

## Evaluation scope

When the request carries an evaluation block, every `ctx.llm.stream` call of the worker (the plain call, and each round of the tool loop) names the scope's model, sets `maxTokens` to the scope's ceiling lowered to the output tokens still available (never below 1, so an exhausted scope is refused by admission and no request falls back to the adapter default of 256000), sets the scope's reasoning effort, and carries a fresh admission labelled with the logical command, the round, and the session that sends it (`<command>#round<N>@<session>`, or `<command>#plain`). The assistant message kept in the tool loop's history names the scope's model. Without an evaluation block nothing is added.

## Physical request evidence

When `physicalRequestObserver` is present, the worker composes it with the existing per-HTTP-request admission. Each tool round retains every transport attempt: a later successful response does not clear an earlier unknown request. Scope refusal is reported before dispatch; abort, connection closure, and a normal return after cancellation do not prove a provider terminal response. Normal provider finish can confirm completion without usage, while the missing usage stays absent. A tool-processing failure after completed responses does not turn those responses into unknown requests. Observation alone neither enables an evaluation scope nor changes its generation or accounting policy.

## Model Experience

Indirectly, through the sealed node prompt sent to the selected DeepSeek model.

#### KV Cache effect

Changing the node prompt, selected model, or RLM tool transcript changes the metered provider request.

## Known Limitations and Deferred Work

- The Provider has no workspace tools, requires an official API credential, and incurs API billing; RLM adds only the sealed `typescript_repl` Host tool.
- The model-tool loop uses the explicit tool-execution limit or the sealed RLM-derived limit and never falls back to the earlier prompt-encoded branch simulation. This policy alone proves neither context externalization nor independent child-spawn limits.
