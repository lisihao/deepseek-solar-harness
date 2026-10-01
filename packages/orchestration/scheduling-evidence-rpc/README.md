# @deepseek-ai/dsh-scheduling-evidence-rpc

English | [中文](README.zh.md)

Authenticated Host RPC read Consumer of `ctx.schedulingEvidence`. The `/scheduling-evidence` channel has one endpoint, `overview`, which takes no payload and changes nothing. It returns the page payload for the scheduling evidence settings section: the owner's Radar switches, the last cycle, the stored generation with its table row counts, every stored model row, and the `model-allocation.publicEvidence` and `model-allocation.costAware` modes in force.

The channel is registered with `trusted-host` authority. The gateway reads the store by running the collector's `status` and `show` commands, so the page shows what is on disk rather than only what the allocator holds in memory.

## Model Experience

None, as the payload goes to the settings page and no part of it enters a model request.

#### KV Cache effect

None; the channel adds nothing to a request prefix.

## Known Limitations and Deferred Work

- The page payload carries every stored model row (89 on the first collection) and is not paginated.
- Each `overview` call starts two short collector processes; the page asks once per visit rather than subscribing.
