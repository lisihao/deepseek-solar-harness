# Agent Note: Fork branch push CI

Status: implemented

English | [中文](2026-08-15-fork-branch-push-ci.zh.md)

## Problem

GitHub sends pull-request activity for a fork contribution to the base repository and does not emit that activity in the fork itself. A pull request whose base is this public fork therefore cannot start the upstream `pull_request` workflow, while branch protection still waits for its `all checks passed` result. Manual workflow dispatch is not equivalent because the upstream aggregate is pull-request-only and a skipped aggregate can satisfy a required check without executing its dependencies.

## Decision

The fork owns [fork-ci.yml](../../../../.github/workflows/fork-ci.yml), a push-triggered adapter limited to `codex/**` branches. It invokes the repository-owned Linux primary, Node compatibility, Python SDK, release-shaped Python runtime, and Windows blocking commands on standard GitHub-hosted runners. The adapter neither replaces nor edits the upstream [ci.yml](../../../../.github/workflows/ci.yml); it supplies the event and runner mapping that a fork cannot inherit.

The final job retains the protected context name `all checks passed`, depends on every required adapter job, runs after failures, and fails when any dependency fails, is cancelled, or is skipped. It holds read-only repository permissions, cancels superseded runs for the same branch, and never consumes secrets. The Linux job compares archived Agent Notes with `origin/master` and uses bounded worker counts suitable for a standard hosted runner.

## Alternatives considered

**Use manual workflow dispatch.** Rejected because the upstream required aggregate is skipped outside `pull_request`; accepting that result would create a green context without running the protected dependency graph.

**Change branch protection to require no status.** Rejected because local checks and inspected runtime behavior do not replace a remote, commit-bound CI verdict.

**Copy the complete upstream workflow and rewrite every event predicate and custom runner expression.** Rejected because that would fork a large orchestration file. The adapter calls the existing aggregate scripts and reusable Python runtime workflow instead.

## Consequences

Every pushed `codex/**` head receives a real commit-bound verdict in this fork, so protected pull requests can merge without fabricated statuses. Standard hosted runners make the adapter slower than the upstream custom pools, and the native Windows blocking job differs from the upstream Wine critical path, but both execute the same repository-owned blocking commands. Upstream pull-request CI remains authoritative in the upstream repository; the adapter exists only for this fork's missing event.

## Verification

The CI workflow contract test pins the trigger, permissions, runner classes, canonical commands, reusable Python runtime, required dependency set, and fail-closed aggregate name. A real branch push must produce successful required jobs and the `all checks passed` context before merge.
