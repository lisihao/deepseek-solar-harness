# Development governance contract

Use this model to separate prose aspirations from controls that can block a defective change.

## Control layers

1. **Authority**: identify the applicable instruction source and precedence.
2. **Scope**: map changed paths and behavior to architecture, frontend, backend, data, security, documentation, and release rules.
3. **Implementation**: preserve boundaries, reuse canonical capabilities, and add tests.
4. **Local feedback**: format, lint, type, focused tests, and architecture checks.
5. **Completion gate**: full relevant test/build/security/governance commands with fresh evidence.
6. **Merge gate**: CI aggregator plus repository branch protection.
7. **Runtime gate**: deployment smoke tests, health checks, and rollback evidence where applicable.

Written rules without a control are `honor-only`. Executable scripts that are not wired into a required gate are `available-only`. A gate is `enforced` only when its failure blocks the relevant transition.

## Rule record

Every important rule should have:

| Field | Meaning |
| --- | --- |
| id | Stable identifier |
| statement | Testable MUST/SHOULD/MAY wording |
| scope | Paths and behaviors covered |
| evidence | Source file and rationale |
| control | Lint, test, audit, hook, or CI job |
| transition | Edit, commit, push, merge, deploy |
| exception | Approval, owner, reason, expiry |
| status | honor-only, available-only, or enforced |

## Fail-closed rules

- Preserve subprocess exit codes and treat timeouts or unreadable output as failures.
- Run independent checks concurrently only through declared profile bounds. A dependent check starts after every declared prerequisite passes; an absent, cyclic, or failed prerequisite blocks completion. A gate marked `exclusive` drains active work and runs alone when its measured resource demand would invalidate timing-sensitive evidence.
- Include staged, unstaged, untracked, renamed, and committed branch changes when selecting scope.
- Avoid `|| true`, parser fallbacks to zero, and path filters that hide governance changes unless an independent required gate covers them.
- A hook is advisory when it can be bypassed or is not executable. CI must independently enforce merge-critical controls.
- A CI aggregator is not a merge gate until branch protection requires it.
- Baselines may ratchet downward; updating them is a policy change, not an automatic fix.
- Bypass flags must not be used silently.
- Reuse a passing gate only when the report proves the same gate command, declared Evidence input bytes, dependency evidence, baseline, platform, and executable version. `select_when`/legacy `scopes` select a gate; explicit `input_patterns` define its input closure and must not inherit unrelated selected-path bytes. Commit ancestry is not evidence: an amend or rebase may reuse a locally available report only through exact fingerprints or a verified tree delta. A failed report may contribute individually passing gates, but never a failed, blocked, missing, or fingerprint-mismatched result.
- Subscription-backed and metered-API gates require explicit cost authorization when no compatible evidence exists. Reassurance alone is not an invalidation reason.

## Verification levels

- `quick`: fast feedback during implementation. It is never final evidence for a merge-ready claim.
- `full`: all relevant native gates represented by the project profile. Remote CI may still be required.
- `runtime`: post-build or post-deployment checks that need services or environment credentials.

## Generic adoption

Place a profile at `.agent-governance/profile.json`. Start from `profile-template.json`, use argument arrays, and keep commands native to the repository. Commit the profile, wire its canonical full command into CI, and make the final CI status required in branch protection.
