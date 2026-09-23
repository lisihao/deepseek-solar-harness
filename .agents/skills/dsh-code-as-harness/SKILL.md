---
name: dsh-code-as-harness
description: Use when a Solar Code-as-Harness CI check fails on a DeepSeek Solar Harness PR, when changing the governance Profile or its bundle, or when the user explicitly asks for a full local governance run. Ordinary tasks use dsh-pre-push-checks instead.
---

# DSH Code-as-Harness

Code-as-Harness is the `agent-development-governance` project vendored at `plugins/managed/governance`, exported to `tools/agent-development-governance/` and configured by `.agent-governance/profile.json`. The `solar-governance.yml` workflow runs its audit, plan, full verification, and attestation on every PR to `solar`. That CI run is the merge authority, so ordinary tasks do not repeat it locally; they select focused evidence through [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md).

## Reproduce a failing CI gate

Read the failing gate id from the CI log, look up its `command` and `cwd` in `.agent-governance/profile.json`, and run only that command. Fix the cause at its source, rerun that gate, and push. Do not edit tests, baselines, allowlists, the Profile, or bypass switches merely to make a gate pass.

## Full local run

Run the complete harness only when the user asks for it or when a failure cannot be isolated to one gate:

```bash
ROOT=$(git rev-parse --show-toplevel)
HARNESS="$ROOT/tools/agent-development-governance/governance.py"
python3 "$HARNESS" audit --project "$ROOT" --strict-warnings
python3 "$HARNESS" verify --project "$ROOT" --scope auto --level full --changed-from origin/solar
```

## Change the governance itself

A change to the Profile, the exported bundle, or `solar-governance.yml` includes the written rule, its executable control, its CI wiring, and a test proving an invalid case fails. `scripts/solar/verify-monorepo.mjs` requires the bundle manifest's source commit to equal the `governance` entry's `accepted_sha` in `plugins/registry.yaml`.
