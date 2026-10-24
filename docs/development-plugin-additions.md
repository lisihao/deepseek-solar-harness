# Fixed development plugin additions

This catalog adds two development previews, not stable releases: `@lisihao/dsh-solar-bench@0.1.0-dev.0` and `@lisihao/dsh-solar-hindsight-chat-recall@0.0.0`. Their identity includes the exact source commit and archive SHA-256; matching version strings are insufficient.

| Package | Source and existing PR | Archive | SHA-256 | Bytes |
|---|---|---|---|---:|
| Bench | [`6af9b9ccf7af37e90d605fb1bbd5eb2a46405310`](https://github.com/lisihao/deepseek-solar-harness/commit/6af9b9ccf7af37e90d605fb1bbd5eb2a46405310), [#311](https://github.com/lisihao/deepseek-solar-harness/pull/311) | `distribution/plugins/bench/6af9b9ccf7/lisihao-dsh-solar-bench-0.1.0-dev.0.tgz` | `60b6ae86dd5047c8ac62a81d8e8da43c96fdf7e4b2c53731b6203a94b25ec651` | 175818 |
| Hindsight chat recall | [`a9f1a8187905cf832a8a648f81ce7f0922f0c138`](https://github.com/lisihao/deepseek-solar-harness/commit/a9f1a8187905cf832a8a648f81ce7f0922f0c138), [#307](https://github.com/lisihao/deepseek-solar-harness/pull/307) | `distribution/plugins/hindsight-chat-recall/a9f1a81879/lisihao-dsh-solar-hindsight-chat-recall-0.0.0.tgz` | `ed009f76e70c3ff5128d6088b8d2d4c897414a24b532c47e0dc767f257d327f6` | 6400 |

Both archives include `package/LICENSE` (MIT). Their source commits belong to `lisihao/deepseek-solar-harness`; the existing feature PRs remain separate and unmerged by this task. The installed MacBook bytes matched these two archives in a read-only audit. The earlier Bench `2f74ac2604` archive is not the selected environment: the user selected the current `6af9b9ccf7` build. The two tarballs are now checked in so a later build tool change cannot silently substitute different archive bytes.

## Restore from one catalog commit

Set `catalog_ref` to the complete reviewed Git commit containing these entries. It is the **catalog** commit, not either package's source commit:

```sh
work="$(mktemp -d "${TMPDIR:-/tmp}/solar-plugin-install.XXXXXX")"
catalog_ref='<40-character-catalog-commit>'
curl -fSL "https://raw.githubusercontent.com/lisihao/deepseek-solar-harness/${catalog_ref}/tools/install-curated-plugins.sh" -o "$work/install.sh"
bash "$work/install.sh" --ref "$catalog_ref" bench hindsight-chat-recall
```

First quit DSH normally and verify Resident has no active or pending work. The installer verifies the selected archives, backs up profile files, and invokes the official app CLI. `requiredPackageIds` is empty for these entries because their non-catalog dependencies must not be represented by fabricated catalog ids. Hindsight requires the existing `dsh-mnemon@0.5.32` peer. Bench requires its declared `yaml@2.9.1`, `zod@4.6.7`, and official rc.2 peers. Preserve existing account, model and backend choices.

## Resolve paths, then audit files

After installation, configure the real app location while the app is still stopped. This command only writes the Bench launcher override and preserves other settings and credentials:

```sh
node tools/configure-development-profile.mjs \
  --profile "$HOME/.dsh/profiles/desktop" \
  --app '/absolute/path/to/DeepSeek Harness.app' --apply
python3 tools/audit-development-plugins.py \
  --catalog distribution/plugins/catalog.json \
  --profile "$HOME/.dsh/profiles/desktop" \
  --package-id bench --package-id hindsight-chat-recall \
  --report "$HOME/.dsh/development-additions-audit.json"
```

The audit compares every regular own-package file to its verified archive; nested `node_modules` is a separate dependency closure. It fails on missing, extra or different files, including same-version client edits. It does not dump settings, execute a model, or make an installed feature operational by itself.

Bench's standalone CLI also needs `DSH_SOLAR_BENCH_HOST_MODULES` to point to `<actual app>/Contents/Resources/app/dsh/node_modules` (or the packaged `app.asar/dsh/node_modules` layout, resolved by the helper) when the app is outside `/Applications`. Its child launcher must be the actual bundled `dsh`. Do not copy source-machine `file:/Users/...` declarations to a different home. Store selected archives at durable destination paths and retain their SHA-256.

## Evidence boundary

The initial archive checks verified source pins, package metadata, MIT notices, SHA-256, byte sizes and owned-file inventories. No credential/private-state files, personal wallpaper, home-directory paths or common secret patterns were found in these two archives. The Bench inventory covers 90 files; recall covers 10 files. Keyless configuration/audit fixtures are separate from model/benchmark efficacy; no live model or benchmark run is claimed here. See [the environment restore contract](development-environment.md) for private snapshots and installed acceptance.
