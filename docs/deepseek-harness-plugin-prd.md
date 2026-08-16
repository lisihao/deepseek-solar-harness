# DeepSeek-Solar-Harness Governance Plugin PRD

## Objective

Turn the existing Code-as-Harness executor into a native, installable Cordis
bundle for DeepSeek-Solar-Harness. The bundle must prevent an agent from
self-certifying completion, retain machine-checkable evidence, and make stale
evidence fail closed.

The shared Python executor remains the only gate-selection and attestation
implementation. The Cordis package is an adapter and policy layer, not a second
governance engine.

## Repository boundary

- Source of governance truth: `agent-development-governance`.
- Harness host and compatibility target:
  `/Users/sihaoli/Documents/ChatGPT/DeepSeek-Solar-Harness`.
- The generated DeepSeek runtime checkout under Application Support is never a
  development source and is not modified by this work.

## Completion contract

Conversation completion, `turn/end { kind: "completed" }`, and Goal completion
are not delivery completion. Only a fresh `governance/completion-accepted`
event may represent locally certified work.

An accepted event requires all of the following:

1. A governed work record exists for the session and project.
2. A full verification run completed with every selected gate passing.
3. The generated attestation still matches the profile, Git HEAD, changed path
   set, and current file bytes.
4. The accepted event cites the exact run, attestation digest, and Git HEAD.
5. The session log has crossed a durability barrier.

Remote acceptance additionally requires the repository-native CI aggregate and
protected-branch policy. Local hooks and the plugin cannot substitute for that
external authority.

## Runtime requirements

- Activate governance only when the session resolves to a Git root with either
  the project-local `.agent-governance/profile.json` or an explicitly configured
  profile. A Git repository without an adopted Profile remains unmanaged.
- Anchor nested working directories to the nearest Git root so audit, planning,
  verification, and evidence all refer to the same project boundary.
- Install as a static `dsh.bundle`, not a dynamic `cordis_run` definition.
- Expose a `ctx.governance` service and model-facing status, plan, verify, and
  completion-submission tools.
- Use `agent/pre-step` to expose current certification state.
- Use `agent/turn-stopping` to reject an unverified completion claim and steer
  bounded corrective work.
- Use monotonic tool guards for commit, push, merge, release, and deployment
  milestones.
- Execute the Python harness through argument arrays with `shell: false`.
- Persist structured governance events in the append-only session log.
- Persist audit and planning failures as `governance/completion-rejected` events
  before returning the tool error, so the visible trace records the actual cause.
- Treat a mutation-classified tool as a trigger to recheck existing evidence,
  not proof of mutation. Invalidate candidate or accepted evidence only when the
  attestation no longer matches or the recheck times out.
- Ship an invariant companion that validates the event state machine before
  candidate events commit.
- Store full command output outside the model-visible log; persist bounded
  summaries, digests, and artifact locations in events.
- Ship a `dsh.client` browser half that registers additively in
  `sidebar.footer.action`; do not replace the sidebar.
- Expose a same-origin, no-store, read-only HTTP projection for the selected
  session and render it in a user-visible `治理 Trace` panel. Prefer the live
  Session and fall back to immutable persistence inspection for historical
  tasks; viewing a trace must not publish a cold Session.

## State machine

```text
open -> planned -> verifying -> candidate -> accepted
  |         |           |            |
  +---------+-----------+------------+-> blocked
                         |
                         +-------------> invalidated
```

Any confirmed change to Git HEAD, the selected path set, file bytes, or the
governance profile invalidates prior evidence. The agent may request
certification, but it cannot supply or directly append an accepted result
through a model-facing argument. A command name or shell text alone is not
mutation evidence.

## Evidence events

- `governance/work-opened`
- `governance/plan-recorded`
- `governance/run-started`
- `governance/gate-finished`
- `governance/attestation-issued`
- `governance/completion-requested`
- `governance/completion-rejected`
- `governance/completion-accepted`
- `governance/invalidated`
- `governance/milestone-evaluated`

Every event carries a `workId` and ISO timestamp. Run and attestation events
also carry the run id, level, Git HEAD, profile digest, change fingerprint,
output digest, and attestation digest where applicable.

The model-facing `governance_trace` tool renders a bounded projection of these
events. Milestone events record commit or delivery, allowed or denied, the
current phase, a reason code, tool name, and command digest. They never persist
the raw command in the model-visible trace.

## Distribution

The bundle is developed under `plugins/deepseek-solar-harness-governance/` and
published as a prebuilt tarball. Its packaged Python runtime is generated from
the shared executor and checked against a SHA-256 source manifest. A dedicated
`governed-code` profile and the `dsh-governed` launcher verify that the composed
config still contains both the policy plugin and invariant companion.

## Non-goals

- Preventing a machine owner from editing files outside Harness.
- Treating a Cordis VM as a hostile-code security boundary.
- Replacing project-native tests, hooks, CI, or branch protection.
- Copying project-specific rules into prompt prose.

## Acceptance tests

1. Direct natural-language completion without evidence is rejected.
2. A failed, skipped, or timed-out gate cannot produce an accepted event.
3. File, profile, or HEAD mutation invalidates an attestation.
4. Commit requires fresh candidate evidence; push/merge/deploy requires fresh
   accepted evidence.
5. An illegal event transition is rejected by the invariant companion.
6. Removing the policy or invariant row makes `dsh-governed` fail closed.
7. The packaged Python runtime digest matches the canonical executor.
8. The bundle installs and appears in a real DeepSeek-Harness composed config.
9. CI independently runs the full profile and publishes its attestation.
10. A denied delivery appears in `governance_trace` with its phase and reason.
11. The installed package appears in the real Web boot graph, the sidebar entry
    is visible, and clicking it opens the Trace panel without browser errors.
12. A nested DSH session resolves to the repository root and a Git repository
    without a governance Profile stays unmanaged.
13. Audit and planning process failures remain visible as durable rejection
    events with specific reason codes.
14. A mutation-classified tool preserves matching candidate evidence and
    invalidates only confirmed stale evidence.
15. Candidate, rejected, and invalidated phases render as distinct Chinese
    states rather than falling through to `未治理`.
