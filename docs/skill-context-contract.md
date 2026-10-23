# Bounded skill discovery and durable catalog retirement

## Authorized problem and scope

A native request retained three full skill catalogs (1,467, 1,475 and 1,477 entries). The updates added only eight and two entries without changing existing descriptions. Text saying a new catalog replaces an old catalog did not remove the old bodies from the canonical Session surface. The user authorized fixing both full-catalog size and historical accumulation, then installing and checking the plugin without real model requests. Web repair/distribution work remains preserved separately.

The new unreleased package is `incubator/skill-context`, named `@lisihao/dsh-solar-skill-context`. Changes are limited to that package, its test/probe tooling, required published-baseline development dependencies, build wiring and documentation. No official App code, filesystem skill inventory, original session history, model capability/window/effort, credentials or unrelated plugin setting is changed.

## Behavior

- Keep the official `skill` loader and direct user skill invocation unchanged. Do not hide or remove skills from the registry.
- Register `solar_skill_search`, which reads the same complete, agent/cwd-scoped skill snapshot and returns a bounded, deterministic page of model-invocable names/descriptions. Search uses names/descriptions only; full skill bodies remain loaded by the official tool. Default: eight results, 240 characters per description, at most 8,192 UTF-8 bytes per result payload. Pages expose a next offset so a broad match is not silently truncated into apparent completeness. No remote/model search is performed.
- An outer official `agent/pre-step` hook consumes the built-in full-catalog proposals before they are appended. It injects one short discovery notice instead; later steps reuse it. The model-visible notice and search outputs are normal logged messages/tool results.
- Retire every already-visible `skill-catalog` node individually via the official Session single-node `surfaceOp: replace`, citing that exact source event. Use an empty developer message, which the published Session projection excludes from model input. Never replace a spanning range containing user, assistant or tool messages. Original events remain immutable and readable.
- Preserve loaded skill bodies, user constraints and tool call/result pairing. Unknown/malformed official catalog shapes fail with a named error before dispatch rather than passing an unbounded body silently.
- On cold replay/resume the same pre-step rules apply to the reconstructed canonical surface. Use lifecycle-owned registrations and flush real Session writes before dispatch. Disable removes the new listener/search registration; the official loader/catalog mechanism remains available.

## Observable acceptance

Use the actual published rc.2 AgentLoop, Session and tool services with a fake LLM. Capture the final request and show no full old catalog bodies, one bounded notice, unchanged unrelated messages, searchable newest additions and a functioning official skill load. Cover updates, interleaved user/tool messages, repeated steps, resume/reopen, incomplete snapshots, malformed catalog records and disposal. Large directory tests must exercise 1,477 or more entries and enforce output bytes, not just result count. Built plain-Node scratch CLI installation/lifecycle checks and source types/build are required. A pre-fix request or fixture must demonstrate the original accumulation.

Install only the verified fixed tarball after normal App/Host exit and idle Resident reconciliation, with current profile/plugin backups and exact installed-byte checks. App load and any manual UI check are separate from actual-request keyless proof. No real model/provider request, old failed prompt replay, browser submission or screen takeover is authorized. Report unrun scope explicitly.
