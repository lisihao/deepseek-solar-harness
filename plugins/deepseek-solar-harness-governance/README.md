# DSH Code-as-Harness Governance

Static Cordis governance bundle for DeepSeek-Solar-Harness. The plugin adapts
the repository's canonical `scripts/governance.py`; it does not replace
project-native rules or remote CI.

## Install

Build a preverified tarball from the repository root:

```bash
python3 scripts/build_dsh_plugin.py
python3 scripts/verify_dsh_plugin.py
cd plugins/deepseek-solar-harness-governance
npm test
npm run verify
npm pack
dsh plugin --profile governed-code add ./lisihao-dsh-code-harness-governance-0.1.0.tgz
```

Inspect the composition and start through the fail-closed admission wrapper:

```bash
dsh --profile governed-code --dump-config
dsh-governed
```

For a DeepSeek-Harness source checkout without a global `dsh` binary, set an
argv-safe command prefix instead of a shell string:

```bash
export DSH_COMMAND_JSON='["node","--import","tsx/esm","/absolute/path/apps/cli/src/bin.ts"]'
dsh-governed
```

The launcher refuses to start if the final composed configuration omits either
the policy plugin or its invariant companion, or if strict mode was overridden.

## Model-facing tools

- `governance_status`
- `governance_plan`
- `governance_verify`
- `governance_submit_completion`

Only `governance_submit_completion` can request acceptance, and the service
re-attests the current worktree before it appends
`governance/completion-accepted`. The tool has no `accepted` input field.

## Authority boundary

The plugin prevents self-certification inside its governed Harness profile.
GitHub CI, branch protection, and deployment verification remain independent
authorities. A local plugin cannot prevent a machine owner from invoking a
different profile or changing files outside Harness.
