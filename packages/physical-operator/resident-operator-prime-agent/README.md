# @deepseek-ai/dsh-resident-operator-prime-agent

English | [中文](README.zh.md)

Independent Resident product Driver that exposes Prime Agent as the stable `prime-agent` physical operator. It uses Prime Agent 0.7.4's public JSONL RPC mode and the user's `openai-codex` OAuth subscription. It has no API-key fallback.

DSH remains the global authority for TaskGraph scheduling, scopes, receipts, retries, approvals, and acceptance. Prime owns only one persistent node-local RLM session and its bounded recursive work. The Driver prefixes the sealed node task with this authority boundary and does not invoke Prime's global workflow refinement.

## Configuration and semantics

The package exports `createResidentProductDriver()`, which is loaded through the generic `driverModules` SPI in `@deepseek-ai/dsh-resident-operator-local`. It does not import the Resident bundle, orchestration daemon, Desktop, or either Consumer. The Driver qualifies the exact Prime version, verifies `~/.prime/agent/auth.json` contains `openai-codex` OAuth, and reads the subscription-visible model catalog before becoming available.

Each Resident Session reuses Prime's native session id for the same operator, real workspace, and lane. Prompts are text-only. The child receives a credential-scrubbed environment and a bounded recursion depth; caller abort maps to Prime's public `abort` RPC command. Product output becomes the ordinary Resident result, so daemon receipts, leases, persistence, and artifacts apply without Prime-specific storage in DSH.

## Model Experience

Indirectly, through `ctx.physicalOperators`. Explicit `prime-agent` selection is available, while Smart Auto and orchestration may select it for bounded recursive, RLM, multi-agent exploration, synthesis, research, or long-horizon node work.

#### KV Cache effect

No additional global prompt section. Each sealed node task enters one Prime Resident turn.

## Known Limitations and Deferred Work

- The first release supports only the `openai-codex` OAuth subscription provider and Prime Agent 0.7.4.
- Prime authentication is completed in Prime Agent itself with `/login`; DSH reports an unavailable Provider until that qualification succeeds.
- The Driver supports pre-dispatch and next-turn capability injection, not in-turn checkpoint hot swap.
- Prime performs node-local recursion only; it cannot create, mutate, or settle the DSH global TaskGraph.
