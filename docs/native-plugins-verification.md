# Native plugin source verification

Recorded on 2026-10-19. The source checks below belong to the combined native-plugin development tree. The later Desktop installation section records its narrower installed evidence separately from real-provider acceptance. Resident and Collaboration were merged as separate, dependent feature PRs, #275 and #276.

## Environment and inputs

- macOS arm64; Node `26.7.0`; published Harness `0.2.1-rc.2`; Cordis `4.0.5`.
- Pinned Codex `0.153.4`, Claude Agent SDK `0.3.263`, and dependency lockfile in this change.
- Built ESM `lib/` runs under plain Node. Scratch tests create their own `HOME` and `DSH_HOME`; they do not use the existing Desktop profile or native credentials.

## Observed checks

| Check | Actual result |
|---|---|
| `pnpm check` | Passed build, strict type check, all 76 tests then present, actual CLI scratch-profile install/boot, and generated homepage check. |
| Final cancellation correction | Core suite passed 17/17 after adding the parallel unknown/active/waiting cancellation regression. This replaces the earlier 16-test core result. |
| Rebuild and affected integration after that correction | Build and strict type check passed; packaged-daemon and collaboration-to-Resident integration passed 4/4. |
| Current source-test inventory | 53 Resident tests and 24 collaboration tests. Unchanged suites retain the passing evidence above; the final core and integration inputs were rechecked after the correction. |
| Public native protocol checks | Pinned Codex CLI generated its real JSON schema without a model call; profile field placement is asserted. A real SDK MCP server/client pair passed a tool request using the actual request identity. |
| Persistence and effects | Tests cover database reopen, actual daemon process restart, SIGKILL recovery without duplicate dispatch, lane/scope fencing, exact bridge context, and one settled DSH tool effect. |
| CLI scratch profile | Both built bundles registered; service/list/queued/pause/cancel checks passed. Explicit daemon shutdown removed its socket; successful scratch data was removed. |
| Local Markdown links and whitespace | Changed documents' local targets existed; `git diff --check` passed. |

The final cancellation regression verifies that an unknown node remains fenced while the other active node receives cancellation and a waiting node becomes cancelled. A cancellation request alone is never reported as confirmed termination.

PR CI runs the full check on Ubuntu/Node 24 for each submitted head. Its result belongs to that head and is reported separately from this local record.

## Desktop installation (2026-10-19)

昊哥 explicitly authorized installation and selected the existing `~/.dsh` as the permanent default home, replacing the earlier separate-home decision. The installed official app and its bundled CLI both reported `0.2.1-rc.2`.

- Source: merged `v4` commit `e7bc78053d6ebf60753ef5892faf1a3a39446ef9`; post-merge CI passed.
- Artifacts: Resident and Collaboration `0.1.0-dev.0` local tarballs, with SHA-256 checked against their packing manifest. These are development candidates, not market releases.
- Before installation, the observed background job was ended and both historical external subagents had terminal notices. The app was quit normally; affected Desktop profile manifests and lock/configuration files were backed up locally.
- The official app's bundled `dsh plugin --profile desktop add <absolute-tarball> --prefer-offline` completed for Resident, then Collaboration. Every pre-existing direct dependency/version and enabled bundle remained present.
- After relaunch, the official Plugins page showed both bundles enabled. Resident's detail page reported `v0.1.0-dev.0`, one component running, and the stable local tarball as its source.
- A read-only request through the installed Resident client passed `ping` and `list`. The daemon fingerprint matched the installed package; the empty graph list was observed. No task or native model execution was started.

This establishes package installation, visible enablement and Resident daemon availability. It does not establish complete user-facing native execution, live tool bridging, logged-in model catalogs, or real model behavior. The app was left running.

## Not run in this delivery

- Logged-in Codex or Claude model execution, live model catalogs, or paid calls.
- Full native task execution or complete feature acceptance in the installed app; the installation and read-only checks above are narrower.
- Subscription-plugin modification, search reconfiguration, account switching, DSH 3.x data import, release/tag/index publication, or recurring automation.

The public Tool Runtime is used for DSH guards and execution. The Resident journal is not a complete native-tool trace in the parent DSH transcript; see [the missing public logging seam](blocked-seams.md).
