# Agent Note: Reduce the fixed cost of repository changes

Status: implemented

English | [中文](2026-08-22-reduce-unit-change-cost.zh.md)

## Problem

The repository's plugin, test, documentation, and governance disciplines protect real product invariants, but a rule requiring an Agent Note for every non-trivial change turns routine implementation history into permanent bilingual architecture inventory. The cost grows with every change even when no durable decision was made. The standing pre-release policy also assumed that no released consumer or persisted product state existed, while DSH Desktop already ships tagged versions.

## Decision

Agent Notes record only durable decisions whose rationale cannot live completely in code and current-state documentation. Cross-package architecture and ownership, public capability contracts, released durable or wire compatibility, authority and permission rules, and repository-wide engineering policy require a Note. Isolated fixes, implementation within an existing contract, refactors, dependency updates, and documentation or test maintenance do not. Existing Notes are updated only when their owned decision changes.

The bilingual requirement remains for Notes that cross this threshold. It is product and engineering policy with long-term value, not routine implementation narration, so reducing the number of Notes removes more cost than weakening the authority of each retained record.

DSH Desktop is treated as a released product regardless of internal package prerelease versions. Released on-disk, wire, session, and configuration formats retain a readable path, a forward migration, or an explicit versioned failure backed by a new decision and tests. Unpublished internal package APIs may still change atomically with every repository consumer.

The [Desktop packaged-source closure](2026-08-20-desktop-source-closure.md) independently closes the highest-risk artifact gap: root builds now verify generated `lib/` bytes in sealed core archives. Package consolidation, execution-vocabulary consolidation, binary-history removal, and the `api-proxy.ts` split remain separate changes because each changes runtime or repository topology and needs its own evidence.

## Alternatives considered

**Keep requiring a Note for every non-trivial change.** This maximizes narrative coverage but makes permanent decision inventory grow with ordinary implementation volume and obscures the smaller set of decisions maintainers may actually revisit.

**Keep the threshold and remove Chinese counterparts.** This reduces per-note files but preserves the much larger problem: routine work still creates permanent architecture records. It also weakens equal-language access for the decisions that remain important.

**Delete Agent Notes entirely.** Code and current documentation do not preserve rejected alternatives or the trade-offs behind durable boundaries, so later maintainers would repeatedly reopen settled decisions.

**Continue treating the repository as consumer-free until npm packages reach a stable version.** Desktop users consume the packaged application and its persisted data, not the internal npm version label; this would preserve a known false compatibility premise.

**Combine packages and execution mechanisms in the same change.** Those changes can reduce long-term surface area, but doing them before dependency and runtime evidence would exchange visible fixed cost for a high-risk migration.

## Consequences

- Routine changes stop paying the bilingual Note triplet and its later maintenance unless they make a durable decision.
- Retained Notes remain bilingual, structured, and mechanically paired, so their authority is unchanged.
- Released data compatibility can no longer be dismissed by citing internal prerelease package versions.
- Reviewers must exercise judgment about whether a durable decision exists; the concrete required categories keep that judgment bounded.
- Larger package, runtime-vocabulary, binary-distribution, and API-proxy changes remain visible follow-up work rather than being hidden inside a governance cleanup.
