# Reproducible model subscription settings

Status: implementation design approved directly by the user on 2026-10-23, including two maintained forks and fixed-package installation on both Macs. No official Harness source change or model probe is proposed.

## Problem and acceptance

The previous local hub was not in Git. Two installed clients were edited from `settings.section` to `settings.subscriptions.page`; installing the same npm versions discarded those edits. Source, built packages, and actual UI must be verified separately.

Completion requires a clean installation from a fixed GitHub commit and verified archives to produce one Model subscriptions section with working Codex and Grok tabs, preserve each provider/account identity, and restore standalone sections when the hub is disabled. The application and installed dependency files are never patched after installation. The same immutable environment description applies on both Macs; machine-specific app and HOME paths are resolved locally. Secrets, logins, history, and wallpaper remain private snapshot data and are not committed.

## Published baseline and integrated projects

- Official host: `@deepseek-ai/dsh@0.2.1-rc.2`, Cordis `4.0.5`, macOS arm64. Use published dependencies; no Desktop build.
- Codex: https://github.com/WSL043/dsh-codex-subscription, `v3.1.1`, `f9ecdd4dbe56b45e85ed8c2eadf79d98be5942d9`, MIT, copyright 2026 WSL043. Its JS/JSX build uses tsdown. Reuse the entire existing provider; change only settings registration lifecycle.
- Grok: https://github.com/BaronCyrus/dsh-grok-subscription, `v2.0.9`, `8bf97c5404291f860b84c8eb4f6e578c276d8c41`, MIT, copyright 2026 dsh-grok-subscription contributors. Build uses its `scripts/build.mjs`. Reuse the entire existing provider; change only settings registration lifecycle.
- No Python, native binary, model download, OAuth migration, or backend selection change is introduced by the hub.

## Confirmed extension boundary

Official `SlotRegistry.register/inject` and a declaring parent's `props.renderSlot` support new child slots. The settings shell projects raw `settings.section` entries into navigation. There is no public relocation/removal/renderStoredEntry API; priority shadowing or an undefined label does not remove a sidebar row. Rendering retained components manually would bypass the framework's standard props and error boundary. CSS hiding, DOM surgery, replacing the settings shell, and monkey-patching host modules are excluded.

Therefore an independent hub cannot legally relocate unchanged third-party standalone registrations. The dependency registration must cooperate with the child-slot contract.

## Approved implementation

1. Own plugin `@lisihao/dsh-solar-subscription-hub`, unreleased source under `incubator/subscription-hub/`, declares the root-scoped `settings.subscriptions.page` list under one `settings.section`. It renders localized tabs with keyboard navigation and preserves already visited panel state. Every registration/style/subscription has a disposer. No account/RPC behavior is implemented by the hub.
2. Create two maintained forks under `lisihao/dsh-codex-subscription` and `lisihao/dsh-grok-subscription`, from the exact pins above. Publish a bounded feature branch/PR in each fork; do not message or submit PRs to the original authors and do not modify official Harness. Preserve licenses and provider names. Each fork adds a small tested settings-registration helper: register under the hub while its slot is declared; otherwise retain the original standalone section; unload removes only the helper's own contribution. All provider, account, model, transport, search, and OAuth code stays unchanged.
3. Record each carried difference and upgrade procedure in `UPGRADING.md`; pin the public fork commit and tarball SHA-256 in the V4 preview catalog. Fork package metadata identifies the maintained preview. The V4 PR includes source/build/test for our hub and fixed distribution references, not copied third-party source. No npm publication, market tag, Pages, merge, or Desktop artifact is part of this request.
4. Retire the private local hub and both installed-file edits by normal plugin-manager installation of the identified packages. Back up affected profile files and package state first. Preserve provider IDs, credentials, historical sessions, unrelated bundles, Jev pause, and both Tailscale instances.
5. Include the exact current MacBook bench (`6af9b9ccf7af37e90d605fb1bbd5eb2a46405310`) and hindsight-chat-recall (`a9f1a8187905cf832a8a648f81ce7f0922f0c138`) archives in the reproducible preview catalog. Their original source PRs remain separate; this task does not merge them. Configure the real app launcher path per machine rather than copying a MacBook absolute path to Mini.

## Maintained preview identities

- Codex fork: [`db55d578fa06e8d46c6759b0dbaccfd1d175238f`](https://github.com/lisihao/dsh-codex-subscription/commit/db55d578fa06e8d46c6759b0dbaccfd1d175238f), [PR #1](https://github.com/lisihao/dsh-codex-subscription/pull/1), based on the `solar-upstream-3.1.1` branch pinned to `f9ecdd4dbe56b45e85ed8c2eadf79d98be5942d9`.
- Grok fork: [`8ff215c2b7897b24078122097fec4c528b68915e`](https://github.com/lisihao/dsh-grok-subscription/commit/8ff215c2b7897b24078122097fec4c528b68915e), [PR #1](https://github.com/lisihao/dsh-grok-subscription/pull/1).

Both keep their original npm version labels. The catalog archive SHA, not the version label, identifies these maintained previews. No npm publish or merge is implied.

## Verification and restore contract

- Focused regression: unmodified registration produces two standalone entries and no hub tabs; cooperating forks plus built hub produce one section and two child entries. Test load order, disable/re-enable, provider removal, and locale/keyboard behavior.
- Install built packages with the published CLI in a disposable `DSH_HOME`, boot plain built JS, and assert registration/lifecycle. No account login or paid model request.
- Validate every catalog archive SHA, license, package metadata, source pin, and required package relationship. A fixed-ref installer must download catalog and archives from the same commit and fail on mismatch.
- Run the repository's `pnpm check` once at the stable boundary, regenerate homepage/guide, and run the affected installer tests. CI and remote SHA are separate evidence.
- In each authorized installed App, observe a single subscription navigation entry and click both tabs at default and narrow widths. Check bench and recall normal entry/registration without starting a benchmark or model turn. Record public labels only.
- Environment audit compares package name/version/artifact hash, enabled state and explicit portable config; account logins and private data are separately preserved, not claimed reproduced by GitHub.

## Review boundary

The existing V4 integration policy requires design review before implementing a new third-party integration and a maintained pinned fork when an unavoidable change is carried. The user approved creating and maintaining both narrow forks and installing their fixed archives on both Macs. Original-author repositories, official Harness, market publication, npm publication, merges, and paid probes remain outside this authorization.
