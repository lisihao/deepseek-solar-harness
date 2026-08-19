---
name: dsh-code-as-harness
description: Apply the Codex-created Code-as-Harness workflow to governed DeepSeek Solar Harness work such as governance, security, migration, repository-wide, Desktop delivery, release, and explicitly requested verification tasks. Use before governed mutation and once on the stable outgoing change set.
---

# DSH Code-as-Harness

## Identity

Treat Code-as-Harness as exactly the user-created `agent-development-governance` project vendored at `plugins/managed/governance`. Do not replace it with a similarly named package, a generic checklist, or prompt-only compliance. The executable bundle under `tools/agent-development-governance` must declare that source and commit in its manifest.

Before acting, read the complete authoritative skill at `plugins/managed/governance/skill/agent-development-governance/SKILL.md` and its directly required governance contract. This DSH skill adds repository-specific routing; it does not weaken or restate the authoritative skill.

## Start governed work

1. Resolve the repository root with `git rev-parse --show-toplevel`. Refuse generated runtime directories, iCloud physical storage, another task's worktree, or a dirty worktree whose changes are not owned by the task.
2. Read root and nearest nested `AGENTS.md`, the owning Agent Note or ADR, and the affected component's test and release policies.
3. Confirm the branch, base SHA, source ownership, upstream/fork remotes, and whether the change affects Desktop delivery or an upstream-sync risk class.
4. Require the repository bundle at `tools/agent-development-governance/governance.py`. If the bundle, manifest, source skill, or Profile is absent or inconsistent, fail closed; do not silently use another harness.
5. Run the authoritative audit with strict warnings, then generate a full plan before editing:

```bash
ROOT=$(git rev-parse --show-toplevel)
HARNESS="$ROOT/tools/agent-development-governance/governance.py"
python3 "$HARNESS" audit --project "$ROOT" --strict-warnings
python3 "$HARNESS" plan --project "$ROOT" --scope auto --level full --changed-from origin/solar
```

If `origin/solar` is unavailable, record and use the verified task base instead of omitting committed changes.

## Implement under harness authority

Keep every important rule connected to an executable control and its owning CI or runtime admission point. Do not edit tests, baselines, allowlists, Profiles, or bypass switches merely to make a failing gate pass. A governance change must include its written rule, executable control, wiring, invalid-case test, and fail-closed aggregate.

Use `plugins/managed/<name>` for Solar-owned plugin fixes. Preserve source provenance and licenses, never write to upstream remotes, and separate mechanical imports from Solar adaptations. Use a non-Solar repository only as a read-only source.

For Desktop code or package changes, read and execute `products/desktop/AGENTS.md` D00-D08. Do not install, restart, or replace the application for analysis, documentation, governance-only, or migration-only work. Stable tags must match `^DSH-desktop-v[0-9]+\.[0-9]+\.[0-9]+$` and must be annotated.

## Verify and admit completion

During implementation, run only the narrowest checks that can change the next action. Run full verification once for the stable outgoing change set. If delivery includes a commit, commit the intended files after focused checks, then run the one final full verification against that exact commit. Do not run full verification both before and after an unchanged commit. If the task does not create a commit, run it once after the worktree is stable.

Write final evidence into the worktree Git directory:

```bash
ROOT=$(git rev-parse --show-toplevel)
HARNESS="$ROOT/tools/agent-development-governance/governance.py"
python3 "$HARNESS" verify --project "$ROOT" --scope auto --level full --changed-from origin/solar --report @git
python3 "$HARNESS" attest --project "$ROOT" --report @git --require-level full
```

Fix failures at their source and rerun only invalidated gates while iterating; produce a single final full report after the resulting bytes are stable. Never call skipped, pending, or stale evidence successful. When the DSH governance tools are available and admission is required, only `governance_submit_completion` may request accepted completion; inspect `governance_trace` for the durable decision.

Push only when the user requested delivery or the task's accepted workflow explicitly includes a remote update. After a push, fetch the remote branch and prove the remote SHA equals the local delivered SHA. Branch protection, required CI, runtime acceptance, and Desktop installation evidence remain independent authorities.

## Report evidence

Report each selected gate as `gate | command | result | duration | evidence`, followed by local SHA and, only when delivery occurred, remote SHA, PR or release URL, and runtime evidence. Include every `warn`, `error`, or `pending` item. Never claim completion from code generation, a local build, a created PR, or an observed process alone.
