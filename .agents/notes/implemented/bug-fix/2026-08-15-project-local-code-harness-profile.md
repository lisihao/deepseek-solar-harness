# Agent Note: Bind Code-as-Harness governance to a project Profile

Status: implemented

English | [中文](2026-08-15-project-local-code-harness-profile.zh.md)

## Problem

Code-as-Harness derives its governed project from the Session working directory and asks the shared executor to discover a project Profile. A governed Session needs repository-owned instructions, executable gates, and an exact governance implementation; otherwise it can enter a fail-closed state machine without an admissible completion path. A Session opened above the repository must not inherit governance when the parent directory has neither one Git worktree nor one applicable rule set.

A repository-wide test command would make the Profile deterministic but would conflict with the repository policy that selects the narrowest behavior evidence for an outgoing diff. A Profile that omits behavior tests would instead allow type-correct but defective source changes to produce an attestation.

## Decision

DeepSeek-Solar-Harness owns `.agent-governance/profile.json`. The Profile identifies this repository by its root instructions, workspace manifest, lockfile, CLI entry, product manifest, and managed-plugin registry. Its required instruction sources include the root policies, the repository `dsh-code-as-harness` entry skill, and the authoritative skill and contract imported from the user-created Codex project at `plugins/managed/governance`.

Quick verification checks Git whitespace, parses the Profile JSON, and validates Solar product identity, imported-source provenance, licenses, Code-as-Harness identity, and the `DSH-desktop-v<major>.<minor>.<patch>` tag contract. Full verification adds root type checking, linting, related Vitest coverage against `origin/solar`, documentation synchronization, and release gates where applicable. Desktop and each managed component run their native package-manager, test, type, build, or documentation commands instead of being treated as root packages.

The Code-as-Harness implementation is exactly the user-created `agent-development-governance` repository imported at `plugins/managed/governance`. Its own exporter installs a digest-checked executable bundle under `tools/agent-development-governance`; the repository skill is only a routing adapter. The Cordis governance plugin remains the Session state-machine and attestation adapter. Remote CI and protected `solar` branch review remain independent authorities.

## Alternatives considered

**Configure one absolute external Profile path in the installed plugin.** Rejected because the development repository would not own its applicable rules, other checkouts would inherit machine-specific paths, and a Profile update could drift independently of the commit it certifies.

**Apply governance to every Git worktree and report audit failure later.** Rejected because ordinary repositories without an adopted Profile would be forced into corrective continuations that cannot succeed.

**Run the complete Vitest suite for every source change.** Rejected because the repository's pre-push policy requires the narrowest relevant evidence. `--changed=origin/solar` includes committed and working-tree changes related to the outgoing branch while component-owned source uses its native test suite.

**Use a generic or third-party project named Code-as-Harness.** Rejected because only the user's Codex-created `agent-development-governance` project owns this product's governance semantics and completion evidence.

**Omit local behavior tests.** Rejected because type checking and linting do not prove runtime behavior and cannot justify an attestation for source changes.

## Consequences

A DSH coding Session can discover its rules, verify the exported implementation by digest, select root and component-native commands from the outgoing diff, and produce a project-bound full attestation. Sessions outside an adopted Git worktree remain unmanaged instead of entering an impossible completion loop. Nested working directories certify the repository root rather than a package subdirectory.

Full source verification depends on a fetched `origin/solar` reference and may run a broad related-test set when shared files affect many packages. Stacked branches can include tests from lower layers because the stable base is the protected integration branch; this costs additional local time but does not omit outgoing behavior. Remote CI still decides merge readiness and may run broader checks than the local Profile.
