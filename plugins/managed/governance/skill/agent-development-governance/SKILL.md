---
name: agent-development-governance
description: Discover, apply, and verify repository-specific AI development rules and executable quality gates. Use when planning, implementing, reviewing, debugging, or finishing code changes in a governed project; when asked whether work satisfies project standards; or when rules, hooks, CI, tests, architecture boundaries, security checks, baselines, and exception policies must be reconciled. Supports GenesisPod through a bundled profile and other repositories through project-local profiles or native command discovery.
---

# Agent Development Governance

Turn project instructions into an evidence-backed development contract. The code harness, not prompt compliance, decides pass/fail. Treat repository-native rules and CI as authoritative; this skill is a thin adapter that makes agents invoke the deterministic harness.

## Workflow

### 1. Discover before editing

1. Locate instructions from the repository root to the target file, including `AGENTS.md`, `CLAUDE.md`, `.claude/`, contribution guides, package scripts, hooks, and CI workflows.
2. Run the governance audit and plan before non-trivial changes:

```bash
python3 "$SKILL_DIR/scripts/governance.py" audit --project "$PROJECT_ROOT"
python3 "$SKILL_DIR/scripts/governance.py" plan --project "$PROJECT_ROOT" --scope auto --level quick
```

Set `SKILL_DIR` to this skill directory and `PROJECT_ROOT` to the repository root. The tool auto-selects a project-local `.agent-governance/profile.json`; for GenesisPod it falls back to the bundled profile.

3. Read every applicable MUST rule before changing code. Do not infer a rule from a script name alone.
4. State the planned files, applicable gates, and any ambiguous architecture decision before implementation.

If no profile is recognized, inspect native instructions and package scripts manually. Do not pretend that a generic gate is authoritative. Use [governance-contract.md](references/governance-contract.md) to classify the discovered controls.

### 2. Implement within the contract

- Keep changes inside the requested scope and preserve unrelated worktree changes.
- Prefer existing facades, components, utilities, and conventions before creating new ones.
- Add or update tests at the same abstraction layer as the behavior change.
- Never weaken a test, threshold, baseline, allowlist, hook, or CI job merely to obtain green output.
- Treat bypass flags and baseline updates as governed exceptions. Require an explicit reason, owner, and expiry before using them.
- Re-run the narrowest relevant gate after each meaningful fix.

For GenesisPod-specific routing and commands, read [genesispod-profile.md](references/genesispod-profile.md). The machine-readable source is [genesispod-profile.json](references/genesispod-profile.json).

### 3. Verify before claiming completion

Plan the final gate set, then execute it:

```bash
python3 "$SKILL_DIR/scripts/governance.py" plan --project "$PROJECT_ROOT" --scope auto --level full
python3 "$SKILL_DIR/scripts/governance.py" verify --project "$PROJECT_ROOT" --scope auto --level full
```

For a machine-checkable completion record, write and re-check an attestation bound to the profile, HEAD, changed paths, and current file bytes:

```bash
python3 "$SKILL_DIR/scripts/governance.py" verify --project "$PROJECT_ROOT" --scope auto --level full --report "$PROJECT_ROOT/.git/governance-attestation.json"
python3 "$SKILL_DIR/scripts/governance.py" attest --project "$PROJECT_ROOT" --report "$PROJECT_ROOT/.git/governance-attestation.json" --require-level full
```

Use `--dry-run` first when the repository is large. Use an explicit `--scope frontend`, `--scope backend`, or `--scope full` if the change range cannot be derived from the current worktree. Use `--changed-from <ref>` for committed branch changes.

When a Profile enables `evidence_reuse`, verification reuses an earlier successful gate only when its command, relevant changed-file bytes, dependency fingerprints, baseline ref, platform, and executable version still match. `select_when` (or legacy `scopes`) chooses when a gate runs; optional repository-relative `input_patterns` choose the file bytes that enter its Evidence fingerprint. `needs` remains the producer-output link, so a consumer fingerprint recursively includes the Evidence fingerprint of each prerequisite. A changed gate may compose its prior full result with a declared `incremental_command`; the report marks both `reused` and `incremental` evidence with the source commit. Amending or rebasing a locally available evidence commit does not itself invalidate matching evidence: exact fingerprints and the two commit trees decide reuse, not ancestry alone. Use `--no-reuse` only when an explicit fresh rerun is required. Never rerun subscription-backed or metered-API acceptance merely for reassurance; require an identified invalidated input and explicit cost authorization.

Completion requires fresh or fingerprint-validated evidence from every selected gate. Record:

- gate ID and exact command;
- result and duration;
- reused or incrementally composed evidence and its source commit;
- skipped gate and concrete reason;
- remaining warning, exception, or environment blocker;
- CI status when local execution is not equivalent to the merge gate;
- local branch and SHA, remote branch SHA, and push result.

Do not equate local hooks with CI or a successful command with full project compliance. Branch protection and external CI settings require separate evidence.

### 4. Push after verified functionality

When every selected required gate passes and the requested functionality has passed its relevant acceptance probe, push the current development branch. Functional acceptance must be backed by a test, executable probe, or inspected user-facing result; an agent statement that the feature looks correct is not evidence.

1. Commit only the intended files. Preserve unrelated user changes and follow the repository's branch policy; do not turn this rule into a direct default-branch push when the repository requires a development branch or pull request.
2. Because a commit changes `HEAD`, run the required post-commit verification and re-attest the exact commit before delivery. In DeepSeek-Solar-Harness, request `governance_submit_completion` after the fresh full attestation so the delivery guard can observe accepted status.
3. Push the current branch with a normal non-force push as soon as the gates, functional acceptance, and fresh attestation are all `ok`. Do not ask for confirmation before this push.
4. Read back the remote branch SHA and require it to equal the local SHA. Observe the required remote CI when available; if it fails, continue fixing and re-verifying instead of reporting delivery as successful.

Stop before pushing only for a concrete credential, permission, protected-branch, remote-divergence, network, or safety failure. Report the exact failing command and retain the verified local evidence; never bypass the failed authority.

### 5. Review governance changes as production code

When instructions, hooks, scripts, profiles, or CI change, verify both semantics and wiring:

1. Does the written rule have an executable control?
2. Is the control invoked by local development and CI?
3. Does a final aggregator fail closed?
4. Can paths-ignore, non-executable hooks, bypass flags, swallowed exit codes, stale baselines, or missing branch protection evade it?
5. Do instruction text, package aliases, hooks, and CI invoke the same canonical gate?

Run `audit --strict-warnings` when governance itself changes.

## Tool commands

```text
audit   Inspect instructions, hooks, CI wiring, profile integrity, and command availability.
plan    List changed files, inferred scopes, and the exact selected gate sequence.
verify  Execute the selected native gates; stop only after collecting all results.
attest  Reject missing, failed, or stale evidence after HEAD, files, or profile changes.
```

All commands accept `--json`. `verify` also accepts `--dry-run` and `--fail-fast`. Profiles contain argument arrays rather than shell strings, so the runner does not evaluate shell syntax. A profile may set a positive `max_concurrency`, declare gate `needs`, and mark a resource-saturating gate `exclusive`; verification runs only dependency-ready gates, includes dependencies transitively in the plan, blocks consumers when a prerequisite fails, and drains all ordinary work before an exclusive gate runs alone.

## Evidence format

End governed work with a compact table:

```text
gate | command | result | duration | evidence
```

Use only `ok`, `warn`, `error`, or `pending`. If a required gate was not run, the overall result is not `ok`.
