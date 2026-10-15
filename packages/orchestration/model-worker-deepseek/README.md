# dsh-model-worker-deepseek

English | [中文](README.zh.md)

Optional DeepSeek official API worker for sealed nodes. Its offers are metered and therefore lose to every usable native-subscription offer in the default allocator. Ordinary nodes remain text-only. An RLM node receives the single sealed `typescript_repl` function tool and executes its model-requested calls through the owner-local bridge; this replaces the former fixed branch fan-out with the same programmable runtime used by native-subscription operators.

## Evaluation scope

When the request carries an evaluation block, every `ctx.llm.stream` call of the worker (the plain call, and each round of the tool loop) names the scope's model, sets `maxTokens` to the scope's ceiling lowered to the output tokens still available (never below 1, so an exhausted scope is refused by admission and no request falls back to the adapter default of 256000), sets the scope's reasoning effort, and carries a fresh admission labelled with the logical command and the round (`<command>#round<N>`, or `#plain`). The assistant message kept in the tool loop's history names the scope's model. Without an evaluation block nothing is added.

## Model Experience

Indirectly, through the sealed node prompt sent to the selected DeepSeek model.

#### KV Cache effect

Changing the node prompt, selected model, or RLM tool transcript changes the metered provider request.

## Known Limitations and Deferred Work

- The Provider has no workspace tools, requires an official API credential, and incurs API billing; RLM adds only the sealed `typescript_repl` Host tool.
- The model-tool loop is bounded by the sealed RLM turn budget and never falls back to the earlier prompt-encoded branch simulation.
