# ADR-005: Code-as-Harness is the agent completion authority

Status: accepted

English | [中文](adr-005-ai-agent-authority.zh.md)

## Context

Repository prose can guide an AI coding agent but cannot prove which files changed, which gates ran, whether evidence is current, or whether delivered bytes match the reviewed commit.

## Decision

In DSH, Code-as-Harness refers only to the user-created Codex `agent-development-governance` project imported at `plugins/managed/governance`. Its repository-exported executable bundle, Profile, attestation, DSH completion tool, CI, and protected branch determine admission. The repository-local `dsh-code-as-harness` skill is a thin DSH entry point and never a second implementation.

Every agent task starts with strict audit and a change-aware plan, runs in an isolated worktree, uses project-native controls, completes full verification and attestation, and revalidates exact committed bytes before push. Completion also requires remote-SHA equality and any applicable runtime or Desktop D00-D08 evidence.

## Consequences

An agent cannot self-certify by saying that it followed the rules. Missing wiring, stale evidence, skipped gates, remote movement, or an unavailable completion authority remains `pending` or `error`. Prompt instructions and skills route behavior; executable controls decide acceptance.
