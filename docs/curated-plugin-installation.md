# Installing the curated plugin packages

This distribution is a fixed set of preview plugin archives and maintained forks, authorized for public download on 2026-10-21. It is separate from a stable Solar market release: there is no Discover index URL, automatic account setup, Desktop rebuild or npm publication. The [homepage](../README.md) has Chinese copy/paste commands and the complete configured-plugin snapshot. The [usage guide](curated-plugin-usage.md) explains the visible controls and quota boundaries.

## Supported target and prerequisites

- Official, unmodified DeepSeek Harness `0.2.1-rc.2`, macOS arm64, `desktop` profile. The baseline is a tested identity, not a statement that it is the newest upstream version.
- An initialized desktop profile (open the official App once, then quit it normally). The CLI bundled with the installed App: `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`. A global `dsh` can be a different version; do not substitute it silently.
- `bash`, `curl`, and `python3` on the installing machine. Check their availability first. Python here parses the catalog and checks downloads; RLM's native/Python execution payload is already inside its archive.
- The user chooses the package ids. The installer does not treat the installed snapshot as an instruction to enable every optional memory, looping, compression or browser feature.

Quit Harness normally and wait for its Host to exit before changing the profile. First inspect/settle any native Resident work through its normal controls; do not kill active or scheduled work to make an installer pass. A disconnected UI does not establish that native work stopped. The installer refuses active processes rather than stopping them for you.

Installation does not import the maintainer's settings, credentials, existing browser login, sessions or personal wallpapers. It does not sign in, open the App, send a prompt, run canaries, or test a connection. External dependencies and account setup remain explicit steps in each plugin's guide.

## Pin one repository commit

Resolve `v4` once and retain the resulting full 40-character Git commit. Download the script, catalog and all chosen files from that same commit. This keeps a branch change during the install from mixing package identities. The script takes explicit package ids and `--ref`; `--list` lists the available selection without installing it. See the homepage for an executable example.

The package catalog records package name, exact version, full source commit, source repository, archive SHA-256, archive size and license. The `0.1.0-dev.0` label is reused by identified development artifacts, so version alone is insufficient. Source and artifact hashes are the distribution identity. Runtime payloads have no dependency on the maintainer's task worktree.

RLM exceeds GitHub's regular per-blob size limit. Its tarball is stored in ordered parts under the same package directory. The installer joins the exact bytes and verifies both each part and the complete archive before handing it to the official CLI. These parts are regular repository files, not Git LFS pointers. It neither compiles Prime nor installs a new Python environment from the network.

## What an installation does

1. Validate arguments, platform, prerequisite commands and the official CLI path.
2. Read the fixed catalog and resolve the selected packages' declared dependencies. Download the selected package files and accompanying licenses. Verify the exact files and reconstructed archive before any CLI installation.
3. Check the live-process boundary and back up the current affected desktop profile configuration/lock files locally. Existing unrelated plugins, credentials and session data are not copied from another machine or reset.
4. Install each selected archive through `dsh plugin --profile desktop add <absolute-tarball>`, in dependency order. A failure stops the sequence; packages already installed are not silently rolled back or replayed. Retain the local backup and command output to reconcile that partial state.
5. Open the official App yourself, verify the plugin list and the documented UI entry, and check the specific feature. Report download, CLI install, startup/UI and real execution separately.

The package installer installs archives only. A native dependency download by the official package manager remains a network operation and can fail independently. An exit code of zero is not a login or real-provider acceptance receipt. No automatic retry, fallback provider or quota purchase follows a failure.

## Manual per-package installation

For an Agent that downloads directly, read the same fixed catalog, download the listed relative archive files or ordered parts, verify all SHA-256 values and the complete archive size/hash, and retain the license notices. Then, with the App/Host quit and current profile files backed up, use:

```sh
DSH_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DSH_CLI" plugin --profile desktop add '/absolute/path/to/the-verified-package.tgz'
```

The final argument must be an existing local archive from the exact catalog entry. Do not point it at a private `/Users/.../Projects/...` path copied from a maintainer's log. A tarball download is a CLI/package installation source; it is not a valid market-index source.

For community originals, the homepage supplies package/version, fixed git commit or versioned upstream Release URL. Those packages are obtained from their own publishers, not repackaged here. `SEE LICENSE IN LICENSE` or a missing manifest license means read the upstream license; the inventory does not grant redistribution permission. Official basic and optional bundles are listed separately because they are supplied by the official App and configured through its controls.

## Recovery

Keep the original package catalog/ref, verified archives, local backup and CLI output. If a command's effect is unknown, inspect the current profile package manifest, lockfile and installed package identity before another install. If a multi-package sequence stops, establish which packages actually changed; do not rerun the whole list blindly.

Quit the App before a corrective install. Reinstall the earlier identified archive for the affected plugin when a downgrade is appropriate. Compare configuration and lockfile differences against the backup and reconcile only the affected entries. Do not overwrite the entire old profile over newer settings, credentials or sessions. The official plugin manager can disable or remove a specific plugin; removal does not by itself prove an already-running native task stopped, nor does it imply deleting that plugin's durable data.

Backups and runtime receipts can contain private configuration. Keep them local. The public repository contains only distributable plugin artifacts, licenses, sanitized inventory and guides.

## Verification and unresolved Web case

The existing Resident, Collaboration, handoff, RLM and maintained-fork archives retain their identified source/package acceptance boundaries. Distribution checks cover hashes, package metadata, safe archive members, part reconstruction and installation-command behavior; these checks do not rerun every plugin or grade model answers.

The installed Web snapshot previously passed settings/catalogue and keyless tests but a new user-initiated Web request reported `WEB_SUBMISSION_MISMATCH`. The original resource was absent from a later task list and its external outcome is unknown; the user reported no intervention. The catalog's newer Web candidate adds bounded read-only receipt observation, while retaining the original installed archive for traceability. That candidate passed source/keyless checks and was installed on 2026-10-21 with all 54 files verified. App/Host restarted and the preserved task records were unchanged. No post-repair live prompt or button acceptance was performed; installation is not evidence that the real failed request was recovered or that the candidate has completed a live Web/Insight run. Do not send a replacement request to validate an unknown earlier effect without a separate user decision.
