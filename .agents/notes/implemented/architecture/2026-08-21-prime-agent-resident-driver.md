# Agent Note: Prime Agent as an independent Resident Driver

Status: implemented

English | [中文](2026-08-21-prime-agent-resident-driver.zh.md)

## Problem

DSH already had durable Claude Code and Codex physical operators and a persistent global TaskGraph Scheduler. Prime Agent adds useful RLM recursion, multi-agent exploration, and synthesis, but installing it as another global planner would create competing scheduling, receipt, retry, scope, and acceptance authorities. Folding Prime-specific code into the Resident daemon or Desktop would also couple product releases and prevent other product Drivers from using the same boundary.

## Decision

Prime Agent is an independent package implementing the public Resident product Driver SPI. `@deepseek-ai/dsh-resident-operator-local` loads configured Driver factories in the detached daemon and fences clients with a canonical Driver-module manifest in Resident protocol v6. The Resident bundle wires the Prime package by module name; neither the daemon, physical router, orchestration Scheduler, model Consumer, nor Desktop imports Prime implementation internals.

The first Provider id is `prime-agent`. It qualifies exact Prime Agent 0.7.4, requires `openai-codex` OAuth from the user's ChatGPT subscription, rejects API-key fallback, reads the subscription model catalog through public JSONL RPC, and persists Prime's native Session id through the existing Resident Session/Receipt store. DSH owns the global TaskGraph, scopes, execution ids, retries, approvals, and acceptance. Prime receives one sealed node task and may perform only bounded node-local recursion; the Driver explicitly excludes Prime global workflow refinement.

Prime is resident-only. Omitting execution mode preserves the global ephemeral default and therefore fails loud for Prime instead of silently choosing another product or execution mode. Explicit user selection takes priority. Smart routing and orchestration select Prime for recursive, RLM, multi-agent exploration, synthesis, research, and long-horizon node work; Claude Code and Codex retain their existing analysis and implementation routes.

## Verification

Driver tests use a strict fake JSONL RPC product to prove ESM package discovery, exact-version and OAuth qualification, API environment scrubbing, authority-prefix delivery, native Session continuity, and abort behavior. Resident protocol tests prove independent Driver loading and manifest fencing. Physical-router tests prove resident-only mode admission. Orchestration tests prove bounded recursive nodes select Prime while the DSH Graph remains authoritative. Desktop package verification requires both the Driver entry and Prime CLI bundle in the installed runtime.

## Alternatives considered

**Make Prime Agent the DSH global planner.** Rejected because two durable schedulers could independently retry, mutate work, and claim completion.

**Embed Prime directly in the Resident daemon.** Rejected because every Prime release would change the daemon implementation and third-party Drivers would lack a stable extension seam.

**Use ACP instead of Prime JSONL RPC.** Rejected for this release because the public JSONL RPC provides the native Session state required for durable resume and the bounded command set used by the Driver.

**Offer API credentials as a fallback.** Rejected because the physical-operator contract for this product uses the user's subscription and must fail loud when that qualification is absent.

## Consequences

Prime can be added or removed by Bundle composition without changing DSH Core or the Scheduler. The daemon survives Desktop/HMR restart with its Session, Receipt, lease, event, and artifact authorities unchanged. Prime authentication remains an explicit external qualification step in Prime itself. Version or Driver-set changes make the old daemon incompatible and cause an orderly shutdown/restart rather than an ambiguous mixed composition. In-turn capability checkpoint hot swap remains unsupported; current Providers accept pre-dispatch and next-turn injection only.
