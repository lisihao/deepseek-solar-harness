# dsh-model-worker-deepseek

English | [中文](README.zh.md)

Optional DeepSeek official API worker for sealed text-only nodes. Its offers are metered and therefore lose to every usable native-subscription offer in the default allocator.

## Model Experience

Indirectly, through the sealed node prompt sent to the selected DeepSeek model.

#### KV Cache effect

Changing the node prompt or selected model changes the metered provider request.

## Known Limitations and Deferred Work

- The Provider is text-only, has no workspace tools, requires an official API credential, and incurs API billing.
- Node-local RLM is capped at four parallel branches in this release.
