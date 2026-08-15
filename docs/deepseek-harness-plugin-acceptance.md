# DeepSeek-Solar-Harness Governance Plugin Acceptance

## Scope

This record covers the Code-as-Harness Cordis bundle implemented in
`agent-development-governance` and its compatibility with the authoritative
DeepSeek-Solar-Harness source checkout. It does not treat the generated
Application Support runtime as source code.

## Local implementation evidence

| Control | Status | Evidence |
| --- | --- | --- |
| Canonical Python runtime | ok | Packaged SHA-256 is checked against `scripts/governance.py` |
| Cordis service | ok | `ctx.governance` resolves in a real Cordis Context |
| Model tools | ok | status, plan, verify, completion submission, and trace registered |
| Independent invariant | ok | Forged accepted event rejected before session commit |
| Commit guard | ok | Commit requires fresh candidate evidence |
| Delivery guard | ok | Unaccepted `git push` is denied |
| Stop policy | ok | Unverified stop is rejected with bounded continuation |
| Evidence state machine | ok | Full run, attestation, request, and accepted sequence enforced |
| Startup admission | ok | Policy, invariant service, companion, and strict mode required |
| Negative startup test | ok | Disabled companion rejected with exit 78 |
| Full local lifecycle | ok | Eight gates recorded; last event is completion-accepted |
| Visible trace | ok | Denied delivery is projected from the durable session log with phase, reason, tool, and command digest |
| Browser plugin | ok | Installed package declares `dsh.client`, exports `lib/client.js`, and appears in the real Web boot graph |
| Sidebar entry | ok | Real Chromium locates the full-width `治理 Trace` row in a single-column footer and opens the compact centered `governance-trace-panel` without browser errors |
| Trace HTTP API | ok | Same-origin `/code-harness/v1/trace` reads live or persisted sessions and never publishes or mutates the inspected log |

Reproducible host check:

```bash
python3 scripts/verify_dsh_host.py \
  --dsh-root /Users/sihaoli/Documents/ChatGPT/DeepSeek-Solar-Harness
```

Verified host snapshot:

- Repository: `/Users/sihaoli/Documents/ChatGPT/DeepSeek-Solar-Harness`
- Profile admission: `ok`
- Cordis tools: `5/5`
- Forged accepted event: rejected
- Unaccepted push: denied
- Trace event: `governance/milestone-evaluated`, `decision=denied`, `reasonCode=missing-acceptance`
- Client boot entry: `@lisihao/dsh-code-harness-governance/client.js`
- Browser entry: `治理 Trace`
- Browser panel: `Code-as-Harness 治理 Trace`

## Repository authority evidence

DeepSeek-Solar-Harness `master` protection was enabled and read back through
the GitHub API with:

- strict required status checks: `true`
- required context: `all checks passed`
- administrators enforced: `true`
- pull request required: `true`
- stale review dismissal: `true`
- conversation resolution: `true`
- force pushes: `false`
- branch deletion: `false`

The `agent-development-governance` repository is private. GitHub currently
returns `403 Upgrade to GitHub Pro or make this repository public` for both
classic branch protection and rulesets. The repository remains private; this
constraint is reported as `warn`, not silently treated as protected.

## Remote evidence

The current implementation branch must pass the repository's `Governance
Harness` push and pull-request checks. The workflow uploads the
`governance-attestation` artifact and binds it to the exact PR head; GitHub's
PR checks are the authoritative run and commit record instead of a stale
hard-coded workflow id in this document. The merge commit must pass the same
workflow independently.
