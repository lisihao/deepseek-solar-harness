# Agent Note: Selective official Harness behavior backports

Status: implemented

English | [中文](2026-09-01-official-selective-backports.zh.md)

## Problem

Official DeepSeek Harness releases can contain useful fixes after Solar's source baseline, but their architecture and persistence contracts are still experimental. A whole-repository merge would also import incompatible choices such as removing SQLite Session persistence and retaining one-shot Codex and Claude subagents. Release-note similarity alone cannot prove that an official behavior is missing or compatible with Solar's stronger product contracts.

## Decision

Solar reviews each official release in an isolated worktree and copies only missing behavior whose authority boundary remains intact. The first review covers official `dsh-v0.1.2-alpha.1` through `dsh-v0.1.2-alpha.3`; the reviewed official source is `dd6322d604e00eec1ba5e0c8541159906a21094a`, and the Solar comparison source is `cf4ffebc4f4ef329ebc510c5098da9f8c36e0760`.

The following fidelity matrix records the resulting ownership and compatibility decisions.

| Official behavior | Solar decision | Solar adaptation | Evidence |
|---|---|---|---|
| `read_image` accepts extension-less PNG/JPEG/WebP/GIF paths | Backport | Preserve Solar's attachment and model-route authority; sniff only a missing extension, then use the existing bounded read and authoritative attachment decode | Signature, extension-less success, unsupported bytes, and existing mismatch tests |
| Tab completes the highlighted slash candidate | Backport | Extend the existing textarea trigger arbitration; do not import the official Lexical editor | Trigger-controller and InputBar keyboard tests |
| A slow backend is not mistaken for a disconnect | Backport | Keep Solar's two-WebSocket plus `host.describe` handshake; the threshold warns without publishing `connected` or aborting a live generation | Slow-open, real-loss, describe-failure, and reconnect tests |
| Offscreen code and read blocks defer syntax highlighting | Backport | Reuse Solar's Shiki allowlist and plain fallback with one shared, one-way `IntersectionObserver` | Code-block, read-block, unsupported-language, fallback, and cleanup tests |
| Exact token, elapsed, TTFT, and throughput presentation | Equivalent | Retain Solar's full-log `sessionStats` and `tokenUsage` projections | Existing conversation and trajectory tests |
| Unknown external Session events can be marked ignorable | Equivalent | Retain Solar's `SessionEvent.ignorable` compatibility contract | Existing persistence and cold-load tests |
| Codex and Claude model selection | Superseded | Retain Solar's persistent Resident operators, subscription qualification, collaboration policy, and trace projection | Resident and Desktop acceptance gates |
| Full-session unloaded-turn rail and targeted paging | Deferred | The behavior depends on the official Session Controller and new `turnOutline` projection; it requires a dedicated projection compatibility decision | No completion claim |
| Queued-image thumbnails and continuable-subagent image follow-ups | Deferred | The official patch spans attachment admission, Session Controller, subagent continuation, and queue presentation; it must remain one atomic contract change | No completion claim |
| Schedule catalog/header and plugin-list presentation refinements | Deferred | These must be reconciled with Solar's Desktop sidebar and remote/frontend presentation instead of overwriting product-specific UI | No completion claim |
| Remove the SQLite Session persistence backend | Rejected | Solar's released Session, Resident, orchestration, and remote-sync recovery contracts retain durable state | Existing persistence remains authoritative |
| Replace Solar's API/remote architecture or downgrade Resident operators to official one-shot subagents | Rejected | These are architecture migrations rather than isolated behavior backports | N/A |

The primary source is the official [alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1), [alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2), and [alpha.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3) release and source tags.

Desktop `3.10.0` seals the five affected Solar workspace packages (`client-connection`, `client-ui-conversation`, `client-ui-input-trigger`, `client-ui-primitives`, and `tool-fs`) as local tarball inputs. This replaces the four affected UI/tool dependencies that previously resolved to the published official `rc.6` packages, so the installed product executes the reviewed Solar adaptations rather than an unbounded official package payload.

## Alternatives considered

**Merge official master into Solar.** Rejected because it combines user-facing fixes with incompatible persistence, API, Client, and subagent architecture changes. The resulting conflict resolution would become a hidden migration rather than a bounded backport.

**Copy every item named in the release notes.** Rejected because Solar already implements or supersedes several items, and other items depend on an official subsystem that Solar deliberately does not adopt yet.

**Wait for official stability without taking any fixes.** Rejected because localized, tested behavior fixes can improve Solar without committing it to the surrounding official architecture.

## Consequences

Solar gains four independently testable behaviors without changing its plugin, persistence, Resident, orchestration, or remote-authority boundaries. The Desktop package boundary is now explicit for every affected package, at the cost of four additional reviewed tarballs in the existing sealed-input plane. Later reviews must compare source and runtime behavior rather than labels, reuse evidence while the relevant inputs are unchanged, and retire a Solar patch when the official equivalent passes Solar's stronger contract. The deferred Session navigation and image-delivery work remains explicitly incomplete rather than being represented by placeholder interfaces.
