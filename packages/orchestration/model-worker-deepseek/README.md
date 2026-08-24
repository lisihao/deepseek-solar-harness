# dsh-model-worker-deepseek

English | [中文](README.zh.md)

Optional DeepSeek official API worker for sealed nodes. Its offers are metered and therefore lose to every usable native-subscription offer in the default allocator. Ordinary nodes remain text-only. An RLM node receives the single sealed `typescript_repl` function tool and executes its model-requested calls through the owner-local bridge; this replaces the former fixed branch fan-out with the same programmable runtime used by native-subscription operators.

## Model Experience

Indirectly, through the sealed node prompt sent to the selected DeepSeek model.

#### KV Cache effect

Changing the node prompt, selected model, or RLM tool transcript changes the metered provider request.

## Known Limitations and Deferred Work

- The Provider has no workspace tools, requires an official API credential, and incurs API billing; RLM adds only the sealed `typescript_repl` Host tool.
- The model-tool loop is bounded by the sealed RLM turn budget and never falls back to the earlier prompt-encoded branch simulation.
