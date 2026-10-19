# Agent Note: Host child-spawn policy

Status: implemented

English | [中文](2026-10-18-host-child-spawn-policy.zh.md)

## Problem

Offline comparisons need to disable children, permit only root calls, or permit bounded recursion without changing context placement or tool-loop selection. The previous Runtime limits bounded recursion and children but did not express those independent permissions.

## Decision

The Runtime Definition exposes childSpawnPolicy. Local explicitly resolves omission to recursive with maxTotalChildren equal to maxTurns; none requires zero, root-only permits depth-zero parents, and recursive retains the original depth constraint. New descendants inherit the exact resolved policy and limits. The [Local README](../../../../packages/orchestration/rlm-runtime-local/README.md) owns admission and recovery details.

The original synchronous spawn commit point persists accepted descendants before dispatchChild yields. Same-command receipts remain idempotent. Every accepted descendant, including deleted, failed and indeterminate entries, continues consuming the same root tree's cumulative limit. Reopening an existing execution cannot change its retained policy before replacing Host bindings.

Local state version 7 requires resolved policies and validates the parent/child references, unique identities, depth, inherited limits and policies, and cumulative bounds before uncertain work recovery may write. Old versions 1–6 and unknown future versions are refused without migration or state-file changes. The Session log format is unchanged.

## Alternatives considered

Inferring permissions from prompt text or hiding the child helper would leave the Host admission authority unchanged. Using zero for the existing positive maxDepth would conflate recursion depth with permission. A second quota ledger would duplicate the original synchronous accepted-child state.

## Consequences

The guarantee applies to one LocalRlmRuntime instance and one root tree; it does not establish cross-process file locking or a budget shared by unrelated roots. It does not meter tokens or change WP1. Fake Host tests exercise policy refusal, concurrent final-slot admission, deletion and failure without refunds, restart preservation and rejection of malformed persisted relationships before writes. Actual Consumer context externalization, Loader assembly, full physical accounting, production token bounds and measured RLM benefit remain separate work. No installed runtime is changed.
