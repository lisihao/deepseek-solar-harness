# Agent Note: Establish the Solar monorepo through P0-P2

Status: implemented

English | [中文](2026-08-17-solar-monorepo-p0-p2.zh.md)

## Problem

DeepSeek-Solar-Harness development spanned a core checkout, a Desktop repository containing another Harness checkout, the user-created Code-as-Harness project, and several modified plugin repositories. That arrangement could produce a working local application, but one clone could not review or change the complete Solar-owned source closure. Repository unification also had to avoid modifying any source repository used as import input or the installed `/Applications/DSH Desktop.app` runtime.

## Decision

The protected `solar` branch is the integration authority and task work occurs in a linked worktree under `/Users/sihaoli/Projects`. The core remains at the monorepo root, Desktop lives at [`products/desktop`](../../../../products/desktop), managed source lives at [`plugins/managed`](../../../../plugins/managed), and product metadata lives under [`distribution`](../../../../distribution). The Desktop import preserves its source history at `c4485d5a8b73b5fecc6b6424187a3524b4b2890c` and removes the nested Harness gitlink.

The managed-source registry accepts six component revisions: governance `9b315f75299b8b677a08c844cf294e35cdd366b9`, Agent Teams `ff3369241dbf9763e34e11292823d5d78a9d8713`, Luna Vision Bridge `0173d93fab9f480d9a7548ac65cf04c3488fb8bb`, Memory Evolve `ce7f0faa0e0240f117c29795e9224c0d9ed18183`, Web Billing `690fdb1172366e139e590c4a8fe3f11c95b7ac90`, and Web UI `7b99d9eb69202199fffe378b289425b224691d23`. Each source history is imported by subtree, and [`plugins/registry.yaml`](../../../../plugins/registry.yaml) records package identity, source and upstream URLs, branch, accepted SHA, license evidence, and native checks. Memory Evolve's later discovered remote revision remains a candidate rather than changing the accepted local revision during migration.

Code-as-Harness means exactly the user's Codex-created `agent-development-governance` project imported at [`plugins/managed/governance`](../../../../plugins/managed/governance). Its own exporter produces the digest-checked runner under [`tools/agent-development-governance`](../../../../tools/agent-development-governance), while [the DSH entry skill](../../../skills/dsh-code-as-harness/SKILL.md) routes agents to the imported authoritative skill and contract. The repository Profile selects root, Desktop, and component-native gates, and Solar CI executes the same runner.

DSH Desktop retains version `2.4.2` during this structural migration. The product manifest requires annotated stable tags matching `^DSH-desktop-v[0-9]+\.[0-9]+\.[0-9]+$`; migration does not assign a new app version, build an installable artifact, launch Electron, replace the installed application, or deploy another machine.

## Verification

The repository verifier binds the product identity, Desktop version and tag pattern, accepted source SHAs, subtree import records, license evidence, absence of nested product gitlinks, and governance export manifest. Invalid-case tests reject the old `desktop-v...` tag shape, malformed or unbound source provenance, and a nested Desktop Harness gitlink. Each imported component retains its native lockfile and verification commands, while Code-as-Harness full verification and attestation cover the complete outgoing `origin/solar` difference.

The first complete run exposed an unfinished Cordis package-name rescope already present on the accepted core baseline. The repository-owned deterministic rescope tool completed those 26 core sites; no waiver or reduced gate was introduced. Root lint and rescope tooling now exclude `products/desktop` and `plugins/managed`, whose independent native gates remain mandatory, and invalid-case tests preserve that ownership boundary.

The source repositories used for import remain independent checkouts. The migration reads their accepted commits but does not alter their branch, working tree, remote, or history. The installed application remains a runtime output and is not a migration verification target beyond confirming that its bundle metadata has not been replaced.

## Alternatives considered

**Keep repositories separate and document absolute paths.** Rejected because paths do not provide one reviewable source closure, immutable provenance, or coordinated PR evidence.

**Copy current directory trees without history.** Rejected because snapshots hide source ownership and make later upstream comparison and conflict analysis less reliable.

**Keep the Desktop nested Harness submodule.** Rejected because it duplicates the core source authority and preserves the repository split inside the monorepo.

**Import the newest discovered remote revision instead of the accepted local revision.** Rejected because discovery is not compatibility evidence; upstream movement belongs to a separate candidate branch and qualification cycle.

**Treat Code-as-Harness as a generic policy.** Rejected because the user-created project, its executable runner, DSH plugin, Profile, and attestation semantics are the required authority.

## Consequences

A fresh clone can inspect the complete Solar-owned source set, trace each imported component to an accepted revision, and route changes through one protected integration branch. Component package-manager boundaries remain explicit, so later source integration must still qualify any change from published or sealed Desktop inputs to same-repository builds.

Required human review prevents this migration branch from self-merging into `solar`. Upstream discovery and qualification automation, Desktop source-input integration, packaged product acceptance, and release automation remain separate development phases governed by the root README roadmap and the upstream qualification ADR.
