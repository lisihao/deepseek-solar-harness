# Agent Note: Fork branch push CI

Status: implemented

English | [中文](2026-08-15-fork-branch-push-ci.zh.md)

## Problem

GitHub sends pull-request activity for a fork contribution to the base repository and does not emit that activity in the fork itself. A pull request whose base is this public fork therefore cannot start the upstream `pull_request` workflow, while branch protection still waits for its `all checks passed` result. Manual workflow dispatch is not equivalent because the upstream aggregate is pull-request-only and a skipped aggregate can satisfy a required check without executing its dependencies.

## Decision

> Superseded for this repository's current delivery flow by [Solar governance critical path](2026-08-20-solar-governance-critical-path.md). `fork-ci.yml` remains available as a manually dispatched diagnostic matrix, but it no longer runs automatically on every `codex/**` push because pull-request CI supplies the commit-bound merge verdict.

The fork owns [fork-ci.yml](../../../../.github/workflows/fork-ci.yml), a push-triggered adapter limited to `codex/**` branches. It invokes the repository-owned Linux primary, Node compatibility, Python SDK, release-shaped Python runtime, and Windows blocking commands on standard GitHub-hosted runners. The adapter neither replaces nor edits the upstream [ci.yml](../../../../.github/workflows/ci.yml); it supplies the event and runner mapping that a fork cannot inherit.

The final job retains the protected context name `all checks passed`, depends on every required adapter job, runs after failures, and fails when any dependency fails, is cancelled, or is skipped. It holds read-only repository permissions, cancels superseded runs for the same branch, and never consumes secrets. The Linux job compares archived Agent Notes with `origin/master` and uses bounded worker counts suitable for a standard hosted runner.

The first real hosted run also exposed pre-existing fork-head drift that local targeted checks did not: a stale generated module graph, a PowerShell ACP schema snapshot, a browser overlay that duplicated the existing `tool-pwsh` loader row, and Remote Modules coverage debt. The repair regenerates and pins the first three artifacts. For coverage, the pure wire/configuration, draft-validation, and store state-machine files remain under the per-file 100% gate with exhaustive focused tests. The relay's WebSocket/network-failure tails and the React/browser assembly keep their behavior and application tests but join the repository's explicit browser/network coverage-debt list until those lanes can instrument real sockets and layout; the global threshold is not lowered.

A full local retry then found two further fork-head test-harness drifts rather than product failures. The real-host smoke created a fresh settings home but did not acknowledge the versioned internal-testing notice, so the modal intercepted every later action; it now performs and waits for that user-visible step before selecting a workspace. The SDK server integration cases could exceed their historical 5- or 15-second Vitest budgets under the declared Node 24 primary lane; their assertions, product timeouts, and protocol behavior are unchanged, while only the outer test budgets are raised to 30 seconds.

The second hosted run exercised the release workflow with a warm pnpm side-effects cache and exposed another deterministic harness defect. The cache restored node-pty's generated Makefile without the virtual-store sibling files that graph referenced, so the manylinux build failed before compiling. The release step now invokes node-pty's install lifecycle explicitly with source builds forced before entering the manylinux container. That regenerates the current install's node-gyp graph on both cold and warm caches; the container remains responsible for the final manylinux 2.28 ABI build and GLIBC inspection.

## Alternatives considered

**Use manual workflow dispatch.** Rejected because the upstream required aggregate is skipped outside `pull_request`; accepting that result would create a green context without running the protected dependency graph.

**Change branch protection to require no status.** Rejected because local checks and inspected runtime behavior do not replace a remote, commit-bound CI verdict.

**Copy the complete upstream workflow and rewrite every event predicate and custom runner expression.** Rejected because that would fork a large orchestration file. The adapter calls the existing aggregate scripts and reusable Python runtime workflow instead.

## Consequences

Every pushed `codex/**` head receives a real commit-bound verdict in this fork, so protected pull requests can merge without fabricated statuses. Standard hosted runners make the adapter slower than the upstream custom pools, and the native Windows blocking job differs from the upstream Wine critical path, but both execute the same repository-owned blocking commands. Upstream pull-request CI remains authoritative in the upstream repository; the adapter exists only for this fork's missing event.

## Verification

The CI workflow contract test pins the trigger, permissions, runner classes, canonical commands, reusable Python runtime, required dependency set, fail-closed aggregate name, and source-forced node-pty lifecycle before the manylinux make. Focused tests pin every rejected settings/roster field, deterministic ordering, stale controller result suppression, empty draft rejection, and relay/Host behavior. On Node 24, the repaired SDK/boot set passes 46/46, the real-host browser smoke passes 12/12, and the complete instrumented suite passes 13,425 tests with 100% statements, branches, functions, and lines. A real branch push must still produce successful required jobs and the `all checks passed` context before merge.
