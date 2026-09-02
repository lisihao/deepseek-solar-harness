# Agent Note: First-class subscription models keep DSH tool authority

Status: implemented

English | [中文](2026-09-02-first-class-model-tool-authority.zh.md)

## Problem

When Smart Auto selected Claude Code and subscription qualification failed before admission, DSH correctly fell back to Codex. The fallback turn could still invoke Codex product-native command execution, which opened a second approval channel that the owning DSH Session could not settle. The native request therefore ended an otherwise recoverable turn with `APPROVAL_REQUIRED` even though the same operation was available through DSH's governed model-tool bridge.

Using the existing `disabled` native-tool policy was not valid: that policy deliberately forbids every tool and the Resident daemon rejects it when a model-tool bridge is present.

## Decision

Resident protocol v13 includes `dsh-tools-authoritative`. It requires a non-empty model-tool bridge and is sealed into the canonical command Receipt hash. First-class Claude Code and Codex model adapters use this policy; the explicit `physical_operator` tool, TaskGraph plans, Debate no-tool roles, and remote operators keep their existing contracts.

First-class model turns retain the existing parent-Session Resident lane. Explicit resident `physical_operator` calls now use the stable `explicit-tool:<parent-session-id>` lane so their inherited native product policy cannot be contaminated by a first-class model turn's sticky read-only/no-approval settings. After upgrade, the first explicit resident call creates one new native Session for that lane; existing product history is retained.

Claude Code receives `tools: []` plus only the strict DSH MCP bridge allowlist, so its built-in tool surface is removed. Codex receives the DSH dynamic tools, an empty native environment list, a read-only sandbox, no approval escalation, and explicit authority instructions. Because Codex app-server 0.151.0 has no supported built-in-tool allowlist, DSH does not claim that the product has hidden every built-in read-only utility; it guarantees that execution and workspace mutation remain on the DSH bridge.

Remote execution rejects the new policy before admission because an owner-local model-tool socket cannot cross that transport. `disabled` remains the only no-tool policy and still cannot be combined with a bridge.

Every Resident business request completes the compatible handshake on the same local-socket connection before dispatch. The handshake returns a daemon instance identity, and the daemon rejects unqualified connections. A client rechecks that identity for every request and retires an incompatible daemon by stable error code. Retirement is conditional on the observed instance and PID. Clients sharing one root coalesce recovery in process, while a transactional SQLite authority claim serializes independent daemon processes before socket startup, so cached readiness, concurrent clients, or a different package copy cannot route a v13 request into an older process or terminate its replacement.

Desktop resolves its packaged DSH dependency closure ahead of profile-local module links. Product-owned packages and subpaths therefore come from the installed application, while third-party profile plugins retain their own resolution and files.

## Alternatives considered

- Reusing `disabled` was rejected because it intentionally removes both native and DSH tools.
- Letting Codex product-native approvals flow through was rejected because the owning DSH Session cannot settle that second approval channel.
- Giving every resident call the new policy was rejected because explicit `physical_operator` use must retain its documented native product behavior.

## Consequences

Smart Auto can fall back from an unqualified Claude subscription to Codex without moving tool execution onto an unowned approval path. DSH tool calls continue through the ordinary scope, guard, approval, event, and plugin composition surfaces. Receipt replay cannot change tool authority, and unsupported remote use fails loud.

An application upgrade cannot keep using an older Resident parser through the shared control socket or mix packaged core packages with stale source links. The daemon handshake stays inexpensive because native product qualification remains on `operator.list`, outside the per-request compatibility exchange.

The Codex limitation is explicit: the current app-server protocol can remove native environments, enforce a read-only sandbox, decline side-effectful native approvals, and instruct the model to use DSH tools, but cannot remove every built-in read-only utility from the advertised product surface. A future upstream allowlist can strengthen enforcement without changing the DSH policy name or Receipt semantics.
