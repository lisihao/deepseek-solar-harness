# @deepseek-ai/dsh-client-ui-remote-modules

English | [中文](README.zh.md)

**Remote Modules** is an installable, opt-in dual-face Web plugin that embeds any number of user-configured Web applications in the Harness left sidebar. One plugin row accepts an `instances` array; every item becomes an independently labelled, ordered sidebar entry with its own target URL and loopback relay. Clicking an entry renders the target application itself in an iframe, not a health view. The plugin does not call, normalize, or display service health APIs. The [Agent Note](../../../.agents/notes/implemented/feature/2026-08-13-mac-mini-remote-sidebar-modules.md) owns the architecture decision.

The package declares an installable bundle and remains disabled by default:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-remote-modules
```

Enable and configure the `ui-remote-modules` row in a profile patch. [`examples/mac-mini-modules/cordis.yml`](../../../examples/mac-mini-modules/cordis.yml) is the runnable MacBook example:

```yaml
- id: ui-remote-modules
  disabled: false
  config:
    instances:
      - id: research-workspace
        label: Research Workspace
        url: http://127.0.0.1:19001/
        relayPort: 29001
        order: 100
      - id: model-console
        label: Model Console
        url: http://127.0.0.1:19002/console/
        relayPort: 29002
        order: 200
```

After the plugin starts, open **Settings → Plugins → Remote Modules** to add, edit, remove, or reorder instances. The editor persists the complete `instances` array in the Harness user-settings document; its values override the profile row. Saved changes take effect after Harness restarts because the loopback relay listeners are created at startup.

| Config | Meaning |
|---|---|
| `instances` | Array of independently started Web page instances. An empty array keeps the feature available without shipping private deployment targets. |
| `instances[].id` | Unique kebab-case instance key. |
| `instances[].label` | Sidebar button and dialog label. |
| `instances[].url` | Full HTTP(S) target page. Paths, queries, and fragments are supported; embedded credentials and active URL schemes are rejected. |
| `instances[].relayPort` | Loopback relay port. `0` selects an ephemeral port; use a stable non-zero port when the target stores login state by origin. |
| `instances[].order` | Integer vertical order; defaults to `100`. |

## Runtime boundary

Each instance starts a local-only, fixed-target relay. All paths stay on the single configured origin, so it is not an open proxy. The relay preserves the target HTML, JavaScript, CSS, cookies, redirects, methods, streaming bodies, and WebSocket upgrades. It removes `X-Frame-Options` and only the `frame-ancestors` CSP directive because those headers otherwise prevent an operator-authorized application from appearing in Harness. Other CSP directives remain intact. The Host publishes only the instance roster at `/remote-webpages/v1/instances`; React then loads each relay URL directly in an iframe.

For remote services forwarded to loopback, SSH remains deployment-owned. Point each `url` at the corresponding local forward and keep both SSH listener ports and relay ports on MacBook loopback. Private hostnames, addresses, and credentials belong only in the user's profile settings and are never product defaults.

Stable relay ports preserve the browser origin across Harness restarts, which lets service-owned cookies and local storage survive. Authentication still belongs to the target application; this plugin neither collects nor stores target credentials.

## Model Experience

None, as the Web pages render only in the browser and do not add their content, state, or credentials to model requests.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Trusted configuration** — target URLs are operator-controlled deployment configuration. Do not point an instance at an untrusted site when stripping that site's anti-framing policy would violate its security intent.
- **Loopback display scope** — relay URLs bind to `127.0.0.1`, so the browser must run on the same Mac as Harness. Remote-browser publishing needs a separately designed authenticated authority boundary.
- **Target-owned compatibility** — hard-coded absolute API origins, service workers, OAuth redirect allowlists, and third-party cookie policy remain properties of the embedded application and may require target-specific deployment settings.
- **SSH lifecycle stays deployment-owned** — this package does not open, authenticate, or reconnect SSH tunnels.
- **Configuration applies on restart** — the Settings editor saves immediately, but relay targets and listening ports change only after Harness restarts.
