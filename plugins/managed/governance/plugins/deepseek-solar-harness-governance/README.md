# DSH Code-as-Harness Governance

Static Cordis governance bundle for DeepSeek-Solar-Harness. The plugin adapts
the repository's canonical `scripts/governance.py`; it does not replace
project-native rules or remote CI. Version 0.3.14 governs only Git worktrees
with a project Profile, anchors nested sessions to their Git root, and records
audit or plan failures in the durable Trace. Mutation-classified tools
invalidate evidence only when re-attestation confirms that the governed state
changed. The `dsh.client` browser plugin distinguishes rejected, invalidated,
and unmanaged work in its per-session `治理 Trace` conversation tab.

## Install

Build a preverified tarball from the repository root:

```bash
python3 scripts/build_dsh_plugin.py
python3 scripts/verify_dsh_plugin.py
cd plugins/deepseek-solar-harness-governance
npm test
npm run verify
npm pack
dsh plugin --profile governed-code add ./lisihao-dsh-code-harness-governance-0.3.14.tgz
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
- `governance_trace`

Only `governance_submit_completion` can request acceptance, and the service
re-attests the current worktree before it appends
`governance/completion-accepted`. The tool has no `accepted` input field.

`governance_trace` projects a bounded, secret-minimized timeline from the
append-only session log. It includes gate results, attestation digests, phase
transitions, and every commit or delivery admission decision. The Web client
exposes the same projection through the `治理 Trace` tab in every session's
conversation view ring. Its `治理证据` section shows those Code-as-Harness
facts; its `调度决策` section shows only bounded policy, admission, and
physical-receipt facts such as a selected route, TaskGraph admission, or a
terminal receipt code. It deliberately does not duplicate model-visible output,
tool activity, native progress, Debate floors, or full Evidence. Those execution
details remain in the ordinary `轨迹` tab. The tab refreshes while mounted and
never consumes left-sidebar space. An empty tab means that this DSH session has
not invoked governance, a governed admission, or a receipt path. The HTTP
projection reads a live session when present and otherwise inspects its immutable
persisted log, so historical tasks remain visible without publishing them as
active sessions. Full command output remains in the mode-`0600` run log under
Git metadata and is referenced by digest and path instead of copied into the
visible trace.

Every `governance/*` record is appended with the DSH `ignorable` envelope
marker because it is informational and does not participate in conversation
reconstruction. For logs written before that marker was available, only the
Trace HTTP projection falls back to the backend's read-only raw artifact and
extracts governance records; unrelated unsupported event types still fail
closed, and the stored artifact is never rewritten.

## Authority boundary

The plugin prevents self-certification inside its governed Harness profile.
GitHub CI, branch protection, and deployment verification remain independent
authorities. A local plugin cannot prevent a machine owner from invoking a
different profile or changing files outside Harness.
