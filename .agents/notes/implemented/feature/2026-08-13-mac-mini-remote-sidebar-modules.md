# Agent Note: configurable remote Web page modules

Status: implemented

English | [中文](2026-08-13-mac-mini-remote-sidebar-modules.zh.md)

## Problem

DeepSeek Harness needs a small installable plugin that can start multiple independently configured instances. Each instance must appear in the left sidebar and open the operator's target Web page itself. GenesisPod and ThunderOMLX are the first deployment values, but neither service belongs in the package contract. Health summaries, service-specific API adapters, and two hard-coded buttons do not satisfy this requirement.

The concrete MacBook deployment reaches loopback-only Mac mini services through SSH forwards. ThunderOMLX permits framing, while GenesisPod returns both `X-Frame-Options: SAMEORIGIN` and CSP `frame-ancestors 'self'`, so a direct cross-origin iframe is blocked even when both processes run on the same machine.

## Decision

**One installable dual-face plugin manages a configured instance array.** `@deepseek-ai/dsh-client-ui-remote-modules` declares its own disabled bundle row. The row's `instances` array is the multi-instance boundary: each member has a unique id, label, full HTTP(S) target URL, relay port, and order. Instance configuration is generic; the package contains no GenesisPod or ThunderOMLX branches.

**Each instance owns a fixed-target loopback relay.** The Host starts one relay bound to `127.0.0.1` per instance. Incoming paths, methods, bodies, cookies, redirects, streaming responses, and WebSocket upgrades remain on the single configured target origin. The relay is therefore not an open proxy. It removes `X-Frame-Options` and only the `frame-ancestors` CSP directive so an operator-authorized page can render in Harness; it leaves the remaining security policy and page bytes intact. A stable configured relay port preserves the browser origin, cookies, and local storage across Harness restarts.

**The browser renders the target application, not an observation of it.** The Host publishes a no-store instance roster at `/remote-webpages/v1/instances`. The Client controller validates that roster into a root-scoped `defineStore`. One occupant of the additive `sidebar.footer.action` slot renders the dynamic instances as vertical rows. Opening a row creates exactly one iframe pointed at that instance's relay URL, plus reload, external-open, and close controls. There are no health routes, normalized service snapshots, or service-specific dashboards.

**The plugin owns a durable multi-instance settings surface.** The Host registers `ui-remote-modules` with the user-settings service, layering the stored `instances` array over the profile row. The browser contributes a dedicated **Remote Modules** tab under **Settings → Plugins** with add, edit, delete, reorder, discard, reset, and save actions for id, label, target URL, relay port, and sidebar order. The namespace is explicitly exposed through the Host configuration API. Its descriptor is `restart`-applied because relay listeners and stable browser origins are created at process startup; the editor states that timing before a user saves.

**SSH and target authentication stay deployment-owned.** The plugin neither opens SSH nor captures application credentials. The MacBook example forwards the GenesisPod frontend and ThunderOMLX page endpoints, while the services continue to bind Mac mini loopback. Target-owned OAuth, local storage, cookies, absolute API ports, and login identity remain inside each target application.

## Alternatives considered

**Keep the service-specific native health dashboards.** Rejected because they show an operational summary instead of the two services themselves and hard-code the first deployment into a supposedly reusable plugin.

**Use direct target iframes without a relay.** Rejected because the real GenesisPod frontend denies cross-origin framing. It would reproduce a browser-level failure in the required deployment.

**Expose a path-prefixed reverse proxy on the Harness origin.** Rejected because generic applications commonly use absolute asset and API paths such as `/_next/*`; transparent subpath rewriting is brittle. A dedicated loopback origin per instance preserves the target's root-path semantics.

**Create one Cordis loader row per browser instance.** Rejected for this version because the client-module boot roster is package-keyed, so duplicate rows do not create duplicate browser plugin fibers. The package-owned `instances` array is an explicit and testable multi-instance contract without changing global boot semantics.

## Testing

Focused Host tests pin URL and identity validation, duplicate rejection, stored-settings precedence and restart metadata, multiple relay lifecycles, target path/query forwarding, full HTML delivery, cookie preservation, anti-frame header removal, roster method gates, and disposal. Client tests pin dynamic roster loading, one additive slot occupant, localized settings-tab registration, complete instance validation and persistence, vertical multi-row rendering, actual iframe URLs, reload, external-open, and close behavior.

A keyless real-composition browser scenario boots the assembled Web application with two local target servers. The GenesisPod fixture deliberately sends the same anti-frame headers as the deployed service and loads an external script. The browser test proves both the target heading and executed script are visible inside the iframe, then opens a separate ThunderOMLX service UI and the populated Remote Modules settings tab. It also asserts vertical geometry and the absence of the old health-dashboard copy.

## Consequences

The first deployment can configure GenesisPod and ThunderOMLX, while later deployments can add, remove, reorder, or rename arbitrary Web page instances without code changes. The plugin intentionally broadens its runtime trust boundary to operator-configured Web applications; operators must configure trusted targets. Loopback relays restrict network exposure, but target-specific authentication, hard-coded API origins, service workers, and OAuth redirect policy may still need deployment work outside this package.
