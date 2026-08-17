# ADR-004: Qualify upstream changes before integration

Status: accepted

English | [中文](adr-004-upstream-qualification.zh.md)

## Context

Automatically noticing a new upstream revision does not prove that it preserves Solar sessions, tools, plugins, profiles, or Desktop behavior. Directly merging upstream heads would turn discovery into an unreviewed product release.

## Decision

Automation may discover new revisions and create candidate branches, but it never writes them directly to `solar`. Each candidate records its old and new revisions, performs a mechanical import separately from Solar adaptations, reports conflicts and interface changes, and runs the complete affected capability contract.

Documentation-only metadata is risk class R0, isolated leaf-plugin changes are R1, and session, agent loop, sandbox, persistence, default-plugin, or Desktop packaging changes are R2. R2 candidates require human approval after full Code-as-Harness, CI, and product acceptance evidence. Failed or incomplete candidates remain rejected without changing the accepted revision.

## Consequences

The repository can stay current without equating latest with accepted. Every accepted upstream movement has a reviewable delta, compatibility evidence, and rollback point. Conflicts may be resolved by an agent, but the same agent cannot supply the required human approval for an R2 merge.
