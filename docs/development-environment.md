# Restoring a fixed development environment

This is a development environment, not a product-wide release. Supported host: official DeepSeek Harness `0.2.1-rc.2`, macOS arm64. The official application is not rebuilt or modified. Source PRs, installed artifacts, private state, and live feature acceptance are separate evidence.

## Public, reproducible inputs

Resolve one complete Git commit and retain it. Fetch `tools/install-curated-plugins.sh`, `distribution/plugins/catalog.json`, and every selected archive from that same commit. The catalog identifies the package version, exact source commit, SHA-256, byte size, license, and required package ids. Version labels alone do not identify development builds.

The model subscription composition requires the hub plus the identified cooperating Codex and Grok packages. Upstream npm versions `3.1.1` and `2.0.9` use standalone settings sections. Reinstalling those originals cannot reproduce the shared section. Do not restore it by editing installed `lib/client.js` files. See [the integration design](integrations/model-subscriptions.md).

The selected development additions are [Bench and Hindsight chat recall](development-plugin-additions.md). Their original source PRs stay separate. Fixed preview archives make the installed bytes recoverable even when a source branch advances. Rebuilding from the source pin is a separate source check; do not assume tarball bytes are reproducible without verification.

If the older private package `dsh-subscription-hub` is installed, remove it through the official CLI after backup and while the app is stopped: `"$DSH_CLI" plugin --profile desktop remove dsh-subscription-hub`. The new hub has a different package name but uses the same section id; keeping both enabled would create a conflicting composition. Do not delete its directory manually or rewrite installed clients.

Before installation, normally quit the application and verify that Resident has no active or pending tasks before shutting it down through its own API. Back up affected profile files. Use the official app's CLI, not an unrelated globally installed CLI. The fixed-ref installer refuses active DSH processes and validates archives before installing only the requested packages.

```sh
# ref must be the reviewed 40-character commit containing this environment.
bash tools/install-curated-plugins.sh --ref "$ref" --list
# Set DSH_CLI to this machine's actual official bundled launcher if needed.
bash tools/install-curated-plugins.sh --ref "$ref" \
  subscription-hub codex-subscription grok-subscription \
  bench hindsight-chat-recall
node tools/configure-development-profile.mjs \
  --profile "$HOME/.dsh/profiles/desktop" --app "$app_path" --apply
python3 tools/audit-development-plugins.py \
  --catalog distribution/plugins/catalog.json --profile "$HOME/.dsh/profiles/desktop" \
  --package-id subscription-hub --package-id codex-subscription \
  --package-id grok-subscription --package-id bench --package-id hindsight-chat-recall
```

`app_path` is the absolute path of the official app on this machine. Read-only configuration output reports the resolved bundled launcher and host-module layout; `--apply` writes only the Bench launcher override with a recoverable backup.

Do not follow `v4` or a feature branch during one restore. A PR that remains unmerged is restored from its exact head commit, not from the default branch.

## Private inputs

GitHub must not contain profile secrets, account tokens, browser storage, personal memories, session contents, wallpaper, or local account state. Retain the user's private migration snapshot and its SHA-256 manifest separately. Preserve destination-only work and credentials. Git source identity is not a backup of private state or uncommitted work.

Private profile data must include package declarations/lock, non-secret settings and enabled states, machine-independent configuration, selected source working-tree deltas, wallpaper bytes, and the already classified native-readable conversation/attachment snapshot. Preserve archive-only historical sessions separately; do not reinterpret them as importable. Browser/Codex OAuth accounts and Keychain remain machine-local; complete their normal login separately.

Restore Git branches and fixed source commits before explicit uncommitted deltas. Do not reset a destination worktree that contains independent changes. Avoid copying a whole old profile over a machine that has developed new state since the snapshot.

## Machine-specific paths

`HOME`, the physical development checkout, the installed app bundle, local backend locations, and the benchmark launcher are resolved on the destination. A `file:` dependency must reference an archive copied into a durable local cache; it must not keep a source Mac's absolute path or point at a disposable worktree. Retain its archive SHA in the environment receipt. Do not infer app location from another Mac: one machine may use `/Applications`, another `~/Applications`.

Bench must use the real bundled `dsh` launcher on the destination. Its standalone CLI additionally supports `DSH_SOLAR_BENCH_HOST_MODULES` for the official app's shared modules. Do not copy app internals into a repository or duplicate official host modules inside plugins to work around an incorrect path.

## Acceptance and drift

Record at least the source commit, catalog commit, package names/versions, installed runtime file hashes, enabled flags, explicitly relocated paths, and tested private snapshot identity. Keep the receipt private when it refers to private paths or state.

Require the actual settings sidebar to contain exactly one Model subscriptions entry and no independent Codex/Grok entries. Click both tabs and inspect their controls at default and narrow widths. A plugin switch or HTTP 200 alone is insufficient. Disable/re-enable the hub in a disposable profile and require standalone fallback and cleanup. Do not click login, refresh quota, start a benchmark, or send a model request as part of a keyless restore check.

Verify Bench and chat recall registration in the running app and their selected configuration. Functional model/benchmark effects require separately authorized probes; registration alone does not prove efficacy. Compare runtime file hashes across both Macs and retain any mismatch as a failed parity check. Never repair an unknown mismatch with a silent installed-file edit.

Jev remains paused. Both Tailscale instances remain running with automatic startup; neither native Codex verification nor this restore flow may stop or suspend them. Preserve existing private history and configuration backups.

Installed acceptance for this fixed composition is recorded in [the acceptance boundary](development-environment-acceptance.md).
