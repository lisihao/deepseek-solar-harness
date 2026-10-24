# Upgrade boundary

## Host pins

The compatibility boundary is the published `@deepseek-ai/dsh` `0.2.1-rc.2` host and Cordis `4.0.5`. Update the package peer and development pins together, then rerun the focused lifecycle tests and the repository build check. Confirm the Settings slot contract and the public `SlotRegistry` methods used by `src/client.ts` still exist before changing the range.

## Provider cooperation

This package carries no third-party provider source and no provider patch. The separately maintained Codex and Grok provider packages own their settings registrations, provider behavior, authentication, and upgrade records. Their cooperation contract is limited to registering an existing settings view into `settings.subscriptions.page` with an `id`, `order`, and localized `label`.

If a provider changes its package, verify that it still uses that child slot and that disabling it removes only its own entry. Do not copy provider code into this package or change a provider's credentials, RPC, model selection, transport, search, or OAuth behavior as part of a hub upgrade.

## Installed state

No source change here proves that a provider fork is approved, installed, enabled, or accepted in an application. Record those facts only from the separate fixed-package and installed-app checks.
