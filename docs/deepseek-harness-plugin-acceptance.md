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
| Model tools | ok | status, plan, verify, and completion submission registered |
| Independent invariant | ok | Forged accepted event rejected before session commit |
| Commit guard | ok | Commit requires fresh candidate evidence |
| Delivery guard | ok | Unaccepted `git push` is denied |
| Stop policy | ok | Unverified stop is rejected with bounded continuation |
| Evidence state machine | ok | Full run, attestation, request, and accepted sequence enforced |
| Startup admission | ok | Policy, invariant service, companion, and strict mode required |
| Negative startup test | ok | Disabled companion rejected with exit 78 |
| Full local lifecycle | ok | Eight gates recorded; last event is completion-accepted |

Reproducible host check:

```bash
python3 scripts/verify_dsh_host.py \
  --dsh-root /Users/sihaoli/Documents/ChatGPT/DeepSeek-Solar-Harness
```

Verified host snapshot:

- Repository: `/Users/sihaoli/Documents/ChatGPT/DeepSeek-Solar-Harness`
- Branch: `master`
- Commit: `accdfc00f111f7740fdcb78db5f4a45629ea8f2e`
- Profile admission: `ok`
- Cordis tools: `4/4`
- Forged accepted event: rejected
- Unaccepted push: denied

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

## Pending remote evidence

- Push the implementation branch.
- Observe the repository's `Governance Harness` workflow on the exact commit.
- Record workflow URL and artifact availability.
- Re-attest after the final commit because the commit changes Git HEAD.
