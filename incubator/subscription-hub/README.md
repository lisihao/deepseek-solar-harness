# DSH Solar Subscription Hub

`@lisihao/dsh-solar-subscription-hub` provides one localized **Model subscriptions** Settings section. It declares the root-scoped list slot `settings.subscriptions.page`; a cooperating provider contributes its existing settings page with an `id`, `order`, and localized `label`. The hub renders those entries as accessible tabs and keeps a page mounted after it has first been visited.

The hub does not implement provider authentication, account storage, model calls, RPC, or credentials. It creates no host-side service. With no cooperating page registered, the section displays an empty state.

## Cooperation boundary

The Codex and Grok subscription providers are separate packages. This package does not copy, patch, install, or enable either provider. A provider that has not been changed to register into `settings.subscriptions.page`, or that is not installed and enabled, remains absent from this section and can keep its standalone Settings section. A built hub alone therefore does not establish one combined provider section in an installed application.

The maintained provider forks, their fixed references, archive verification, and installed-app acceptance are tracked outside this package. Do not describe those external steps as complete from a hub source or unit-test result.

## Configuration and data

There is no hub configuration and it writes no data. The child-slot name and Settings section id are protocol identifiers, not deployment settings.

## Verification boundary

The package has focused source tests for the `SlotCore` registration lifecycle, the empty state, two registered pages, locale registration, keyboard tab-index mapping, listener release, and style/slot cleanup. Those checks do not install the package into DSH Desktop or exercise a provider account.
