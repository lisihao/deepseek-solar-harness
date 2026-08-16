# Agent Note: Bind Code-as-Harness governance to a project Profile

Status: implemented

English | [中文](2026-08-15-project-local-code-harness-profile.zh.md)

## Problem

The installed Code-as-Harness plugin derives its governed project from the Session working directory and asks the shared executor to discover a project Profile. DeepSeek-Solar-Harness had no `.agent-governance/profile.json`, so a Session opened in this repository could enter the fail-closed state machine but could not pass its first audit. A Session opened above the repository could also be mislabeled as governed by older plugin versions even though the parent directory had neither one Git worktree nor one applicable rule set.

A repository-wide test command would make the Profile deterministic but would conflict with the repository policy that selects the narrowest behavior evidence for an outgoing diff. A Profile that omits behavior tests would instead allow type-correct but defective source changes to produce an attestation.

## Decision

DeepSeek-Solar-Harness owns `.agent-governance/profile.json`. The Profile identifies this repository by its root instructions, workspace manifest, lockfile, and CLI entry; records the root instructions, contribution guide, testing policy, and pre-push skill as required instruction sources; and maps source, documentation, tooling, release, and governance paths to native commands.

Quick verification runs the Git whitespace check and parses the Profile JSON. Full verification adds repository type checking and linting for source, tooling, or release changes, then runs Vitest with `--changed=origin/master` so behavior coverage follows the complete outgoing branch diff without defaulting to every test. Documentation and governance changes run `doc-sync`. Release changes additionally run the build and package-hygiene commands.

The external Cordis plugin remains the state-machine and attestation adapter. It anchors a nested Session working directory at the nearest Git root and activates only when that root contains a project Profile or the deployment explicitly supplies one. Remote CI and branch protection remain independent authorities.

## Alternatives considered

**Configure one absolute external Profile path in the installed plugin.** Rejected because the development repository would not own its applicable rules, other checkouts would inherit machine-specific paths, and a Profile update could drift independently of the commit it certifies.

**Apply governance to every Git worktree and report audit failure later.** Rejected because ordinary repositories without an adopted Profile would be forced into corrective continuations that cannot succeed.

**Run the complete Vitest suite for every source change.** Rejected because the repository's pre-push policy requires the narrowest relevant evidence. `--changed=origin/master` includes committed and working-tree changes related to the outgoing branch while leaving exhaustive platform coverage to CI.

**Omit local behavior tests.** Rejected because type checking and linting do not prove runtime behavior and cannot justify an attestation for source changes.

## Consequences

A DSH coding Session can now discover its rules and produce a project-bound full attestation. Sessions outside an adopted Git worktree remain unmanaged instead of entering an impossible completion loop. Nested working directories certify the repository root rather than a package subdirectory.

Full source verification depends on a fetched `origin/master` reference and may run a broad related-test set when shared files affect many packages. Stacked branches can include tests from lower layers because the stable base is the protected default branch; this costs additional local time but does not omit outgoing behavior. Remote CI still decides merge readiness and may run broader checks than the local Profile.
