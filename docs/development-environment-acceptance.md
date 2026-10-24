# Fixed development environment acceptance

The installed composition was tested from catalog commit `0a87f57c349a8921023a7ef3785f94827cdd3d89`. Subsequent evidence-only catalog updates retain the same archive bytes and source pins. This remains an unmerged development preview, not a market or npm release.

| Check | MacBook | Mac mini |
|---|---|---|
| Five selected archives installed through the official CLI | Passed | Passed |
| Every own-package regular file matches its catalog archive | Passed, zero differences | Passed, zero differences |
| Exactly one Model subscriptions navigation entry | Observed | Observed |
| Both original Codex/Grok pages, default and narrow windows | Opened and controls observed | Opened and controls observed |
| Bench and Hindsight chat recall enabled in Installed plugins | Observed | Observed |
| Bench launcher resolved to the actual local app | Configured | Configured |
| Existing provider host bundles unchanged from their upstream pins | Verified in fixed archives | Same fixed archives |
| Login, quota-refresh clicks, model requests, benchmark/recall efficacy | Not run | Not run |

The local full `pnpm check` passed: 467 unit tests, published-baseline built-package probes, 13 curated archive checks, installer fixtures, 11 audit fixtures and 7 profile-configuration fixtures. GitHub Actions run [40054481914](https://github.com/lisihao/deepseek-solar-harness/actions/runs/40054481914) passed for the identified feature head. Maintained Codex tests passed 830 with 26 skips; Grok tests passed 178. The Codex test fixture uses canonical `/private/tmp` to avoid an existing macOS `/var` symlink comparison error.

Private backup receipts verify preservation of existing credentials, conversations, attachments, wallpaper files and unrelated profile dependencies. They are not published. Jev's nine configured nodes remain disabled; both Tailscale instances remain running. No historical session conversion or account migration was performed by this plugin installation.

## Existing host limitation

The Mac mini's full app signature check passed. The MacBook's strict resource check reports pre-existing additional files under `Contents/Resources/app/`, observed with timestamps preceding this task. Its executable-signature check passed and its `app.asar` SHA-256 matches the signed resource manifest. No app file was repaired, removed, rebuilt or re-signed here. A successful plugin/UI check must not be represented as a successful full MacBook resource-signature check.

## Restore boundary

Use one complete catalog commit and the [restore instructions](development-environment.md). Provider versions alone are insufficient: the original npm packages do not implement the cooperating registration helper. Preserve the exact fork commits and tarball hashes.

Private settings, credentials, history and wallpaper require the separate private snapshot. The pre-existing `dsh-session-prefix@0.1.0` compatibility overlay remains a separately identified private exception; this task retires only the two subscription-provider client edits. The migration tool refuses to apply those old provider overlays over the new maintained forks. No general guarantee of benchmark quality, recall effectiveness, or compatibility with a newer host is claimed.
