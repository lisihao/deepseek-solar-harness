# ADR-005: Code-as-Harness is the agent completion authority

Status: accepted

English | [中文](adr-005-ai-agent-authority.zh.md)

## Context

Repository prose can guide an AI coding agent but cannot prove which files changed, which gates ran, whether evidence is current, or whether delivered bytes match the reviewed commit.

## Decision

In DSH, Code-as-Harness refers only to the user-created `agent-development-governance` project imported at `plugins/managed/governance`. Its exported bundle and Profile run in `solar-governance.yml` on every PR to `solar`; that CI result, the other required checks, and the protected branch determine admission. The repository-local `dsh-code-as-harness` skill reproduces a failing gate or runs the harness on request and is never a second implementation.

Agents work in an isolated worktree and run focused, change-relevant evidence before push through `dsh-pre-push-checks`. They do not repeat audit, plan, full verification, or attestation locally for each task: CI runs them against the exact pushed commit, so a local rerun costs agent time and tokens without adding admission evidence. Desktop packaging and installation follow `products/desktop/AGENTS.md` only for an explicit release or install request.

## Consequences

An agent cannot self-certify by saying that it followed the rules. A PR stays unmerged until the governance workflow and required checks pass on its head commit. Focused local checks can miss a gate that only CI runs; that failure surfaces on the PR and is fixed there rather than prevented by a full local rehearsal. Prompt instructions and skills route behavior; executable controls decide acceptance.
