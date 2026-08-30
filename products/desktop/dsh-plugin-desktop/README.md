# DSH Desktop

English | [中文](README.zh.md)

`dsh-plugin-desktop` runs DSH in Electron while remaining part of the ordinary Cordis composition. The installed application is named **DSH Desktop**. The package provides the `dsh-plugin-desktop` executable and the `dsh-desktop` alias; the registered npm package name is the reliable `npx` entry.

## Architecture

The Electron executable is minimal bootstrap code. It acquires the single-instance lock, resolves the selected DSH profile, provides the native runtime capability, and boots the Host Cordis root in the Electron main process. The `desktop-shell` Host plugin owns the `BrowserWindow`, navigation policy, settings namespace, and close-versus-quit lifecycle through Cordis effects. The native runtime owns the physical tray, while `desktop-shell`, `desktop-profiles`, `desktop-terminal`, and `desktop-updates` contribute effect-scoped commands through its ordered item registry.

Both presentation modes reuse the existing loopback Web carrier. The profile mounts the ordinary `dsh-base` and `dsh-web-app` bundles, the Host binds its HTTP and WebSocket surface to `127.0.0.1` on an ephemeral port, and Electron loads that same-origin page in a sandboxed renderer. There is no Electron-owned plugin roster, preload bridge, or raw Electron API in the renderer.

The same package also provides `dsh-product-server`, a plain-Node Host adapter for remote deployments. Desktop and Product Server are generated from one sealed product composition and therefore load the same Resident, Orchestration, AgentTeams, Billing, Remote Modules, RLM/Continuous Harness, model-allocation, memory, governance, and product UI rows. Only Host adapter rows differ: Desktop owns Electron window, tray, terminal, profile, and updater effects; Product Server owns the persistent Web endpoint, pins the browser directory picker for remote clients, and always retains the compatibility browser layout because it does not load the Electron-owned advanced layout provider. The ordinary `dsh server` command remains the upstream-compatible bare Server profile and is not the DSH Desktop product deployment.

DSH Desktop keeps a named catalog of Product Servers and one active Server selection independently from its current deployment role. The native **Connect to Remote Server…** window adds, edits, selects, and removes entries; manually changing the active entry restarts the Frontend against that endpoint without starting a local Host. After connection, a Desktop-owned monitor keeps qualifying the catalog and remounts the browser generation against a newly elected schedulable Leader without restarting the application. A successful fallback becomes the persisted active Server and appears in the native window title. When every entry is unavailable, the complete catalog remains intact and Desktop opens local deployment recovery instead of silently starting a local Host. Switching back to the local Server retains the whole catalog, its last selection, and the presentation mode, so any saved Server can be selected again without reconfiguration. Existing single-Server deployment state migrates into the catalog as its first entry. A loopback endpoint such as `http://127.0.0.1:13080` normally reaches the Product Server through an owner-controlled SSH local forward, uses that authenticated tunnel directly, and does not request a second pairing code or Keychain credential. Direct remote HTTPS clients, including pocket/mobile clients, still use the one-time pairing challenge, an encrypted durable device credential, and short-lived access sessions. The Frontend billing bridge reads every configured Server ledger, adds the inactive MacBook ledger once, and preserves per-Server ready/unavailable provenance in the billing panel.

Electron owns the native **Deployment** menu and the local recovery page shown when the active Frontend Server cannot be loaded. Both offer **Use Local Server** and **Connect to Remote Server…** without depending on the remote Client bundle. The Desktop footer always exposes Server configuration directly; in Frontend role it additionally exposes **Use Local Server**.

The same native window owns optional background Git commit synchronization. Each device configures its local repository path, GitHub authority remote, branch, direction, interval, and an optional Tailscale/SSH accelerator remote. Synchronization refuses dirty or wrong-branch worktrees, only fast-forwards or pushes committed refs, and reports divergence instead of merging it. The accelerator may prefetch Git objects, but GitHub remains the accepted authority and an accelerator failure does not block the authority path.

It also owns revision-aware background Session progress handoff. A Frontend may pull complete, balanced Session replicas from its selected Product Server into a protected inbox and import them after switching to the local Server; an active local Server may push or pull those same immutable log prefixes. The controller remembers per-Server revisions, so unchanged logs are not transferred again. It never copies SQLite or WAL files, never replicates an open turn, and never creates a second active writer: live work remains on its authoritative Server and is observed through the normal snapshot/cursor stream.

The desktop package has normal Host and Web Client faces. Its Client face validates the Host-supplied mode, platform, and product-version markers. Both modes mount one non-interactive, single-line product marker in a reserved strip below the window content and keep Desktop actions on the ordinary additive slots. Compatibility then stops before providing a layout service or root presentation; advanced mode installs the desktop layout service and root presentation described below. Third-party Web clients continue to use the ordinary DSH module graph in both modes.

The tray profile selector lists existing profiles and the lazily available `desktop` and `web` defaults. A selectable profile directly composes `dsh-base` before `dsh-web-app`; headless, malformed, or already desktop-embedded profiles remain visible but disabled. `desktop` is the only launcher-managed profile: its installation-owned prefix is repaired while third-party bundle order is preserved. Every other selected profile keeps its manifest, user patch, and dependencies unchanged. The launcher inserts its own desktop layer after `dsh-web-app` for the active generation and never persists that layer in the selected bundle list.

The desktop product layer also supplies Resident Physical Operators and AgentTeams without persisting either bundle into a user-selected profile. One **Collaboration** control sits beside the ordinary chat-model selector, so the composer no longer presents the operator, native model, and effort as three peer selectors. Each untouched Session uses Smart Collaboration: the primary model owns the conversation and evaluates non-trivial work before delegating to Codex or Claude Code. Logged manual policies either disable delegation or prefer one product for qualifying tasks; short conversation remains on the primary model. Product-specific native model and reasoning/thinking values live together as advanced preferences inside that control, both default to per-task recommendation, and the effective pair is locked to the canonical operator/workspace Resident Session until an idle revision-checked reset. Opening the control immediately refreshes the live subscription catalog, then keeps a short visible-panel refresh cadence so an early startup race cannot leave the choices disabled for a minute. Desktop recognizes the legacy unmarked policy event while new policy and profile events carry the ignorable extension marker, so older readers can cold-load the same Session without rejecting its log. The low-level physical-operator request still defaults to `ephemeral` when a caller omits `mode`, preserving provider compatibility; Smart Collaboration explicitly prefers `resident` for repository, multi-turn, and restart-continuous work. On macOS, the launcher resolves the user's native `claude` and `codex` commands into private owner-only wrappers, and the Resident daemon uses those products' subscription login and native session continuity. API-key fallback is forbidden. The daemon is independent of an Electron generation, so an application restart disconnects the client without deleting its receipts, leases, artifacts, or native product sessions.

The current Session header has an additive **Physical Operators** action in both presentation modes. It opens a read-only same-origin dashboard showing provider qualification, durable Sessions, latest receipt state, and bounded progress events for that Session. The Host route reads `ctx.residentOperators` on demand and never creates Desktop-owned Resident storage. It also explains Smart Collaboration and the capability contract for plugins: model work uses the `physical_operator` tool, Host plugins inject `ctx.physicalOperators` for execution, and trusted management/status plugins may inject `ctx.residentOperators` for inspection. Live descriptor, tag, and execution-mode guidance makes delegation proactive; the policy is visible and logged instead of introducing a hidden classifier or second scheduling authority. Desktop does not place this action in the sidebar footer, so operational inspection cannot consume session-navigation space.

The Physical Operators action distinguishes installed Resident hosts from active workers and exposes each worker's isolation lane. Codex and Claude Code each admit up to four concurrent lanes; one native product host can therefore execute several independent TaskGraph nodes without presenting duplicate applications as operators.

The product layer also mounts the sealed `@deepseek-ai/dsh-orchestrations` bundle as an independent plugin capability. Its Service Definitions own the Intent, Context, Capsule, TaskGraph, and Orchestration contracts; the local Provider owns the durable daemon, SQLite state, artifact store, and scheduling writes; the tool and Web UI are consumers of `ctx.orchestrations` only. The additive **Orchestrations** action in the current Session header opens a workbench that reads a same-origin projection of runs, DAG dependencies, compiler/capsule/context stages, sealed execution plans, operator choices, attempts, generations, evidence, blockers, and events. Pause, resume, cancel, approval, rejection, and indeterminate-resolution controls call the public service seam and never mutate daemon storage directly. Removing the bundle removes this surface without changing chat, workflows, or physical operators.

Each orchestration workbench run starts with a Collaboration Trace summary. It names the admitted `Smart Collaboration`, `Primary Model Only`, `Prefer Codex`, or `Prefer Claude Code` policy, the TaskGraph route, active and maximum worker counts, ready nodes, clean-task Capsule state, and fresh-lane isolation. The event timeline retains the same admission, Capsule resolution, operator dispatch, lane, and scheduler wait reasons so a completed run remains explainable after restart.

Resident dispatches also project product-neutral connection, reasoning/execution, tool-activity, and finalization phases into the Collaboration Trace. Terminal events show the selected Codex or Claude Code operator, stop reason, bounded user-facing output, and immutable Evidence reference. Private reasoning text, prompts, terminal screens, and product-local transcripts remain outside this projection.

Local acceptance Runs under `/tmp/dsh-orchestration-*` or `/private/tmp/dsh-orchestration-*` remain durable and appear with an **Acceptance** label. The workbench includes them by default and offers a presentation-only hide control that keeps their stored count visible.

Desktop seals the Solar-controlled Better Sidebar, GenUI, plugin diagnostics, model fallbacks, code graph, Mnemon, Aegis skills, and bounded utility tools as product inputs. Product-first resolution keeps the accepted Better Sidebar implementation authoritative even when an aggregate UI package depends on an older release, while its mount guard prevents duplicate sidebar ownership. Mnemon is the only product memory bundle; stale Memory Evolve rows are disabled without deleting user data. The native DeepSeek provider declares `deepseek-v4-flash-vision-exp` with image input, so Desktop does not load Luna Vision Bridge or Modlens. Aegis contributes skills only; Code-as-Harness remains the sole completion and admission authority.

The packaged `anchored-standard` preset is a system-trust product input and precedes the matching upstream preset root. Its first-turn gate includes delegated agents, so an AgentTeams worker begins with the same `bash` and `str_replace_editor` bootstrap pair instead of being treated as already promoted. AgentTeams also places its member protocol in the first user prompt rather than replacing the selected preset persona. A user profile that already declares AgentTeams is not duplicated; the final product patch still enforces this prompt placement.

Profile selection is desktop-owned state under Electron user data, not another field inside a selected profile. A switch is recorded as pending and takes effect through an orderly restart. The new profile becomes last-known-good only after the Cordis tree and native window mount successfully; the tray is created after the Web surface loads, and that state commit completes synchronously before tray commands can run. A failed pending generation is rolled back and relaunched once. Official profiles use the same DSH home for sessions, settings, and storage by default, so switching does not copy or migrate records. A custom profile patch may deliberately redirect one of those persistence roots.

Before Loader entries mount, the launcher registers the generation-scoped `ctx.desktopProfiles` service. Its immutable `current` value contains the active profile's `name` and absolute `dir`; `list()` performs read-only discovery, while `select(name)` serializes persistence-before-restart switching without changing the live generation in place. The service is a Desktop Host capability, not a renderer bridge or an active-profile API supplied by current upstream DSH.

Bare Cordis plugin imports resolve from the persistent profile. A narrow Node resolve hook applies only to imports issued by `@deepseek-ai/cordis-plugin-loader`, so profile-local third-party packages and the healed launcher fallback use the same resolution path even when packaged Electron does not expose Node's internal ESM loader.

Before profile preparation and Cordis boot, the launcher prepends a private command directory containing only the pinned bundled `pnpm` command to the current Electron main process `PATH`. Host and third-party plugins can therefore discover that package manager from startup, including through ordinary DSH subprocess providers, without requiring a system Node.js installation. This ambient path is a compatibility surface, not the formal plugin-management contract.

The `desktop-pnpm` Host row provides `ctx.desktopPnpm` for managed package operations against the immutable active profile. `run(args, signal?)` executes packaged pnpm directly in the active profile directory; it is a low-level operation and does not promise DSH profile initialization, caller-relative source anchoring, or bundle reconciliation. `runPlugin(args, invokingDir, signal?)` instead starts the packaged `dsh plugin --profile <active>` command from the caller's absolute directory. Plugin installation, removal, update, and dependency repair must use `runPlugin()` so the upstream CLI remains authoritative for relative `file:` and `link:` specifications, the pnpm profile working directory, first-use initialization, and successful `dsh.profile.bundles` reconciliation.

Both methods return live stdout and stderr streams, a `done` promise that settles after the complete process tree exits, and `cancel()`. One operation may run per generation. The service uses the ordinary DSH subprocess provider, exact packaged JavaScript entries, shell-free argv, and child-scoped DSH home, Electron-backed Node, CI, and native-module ABI values. The public runtime path still does not expose `node` or `dsh`; its private helper and the `ELECTRON_RUN_AS_NODE` and npm ABI variables exist only inside package-manager subprocess trees. The launcher does not modify the system `PATH`, shell startup files, profile configuration, or `.env` documents.

Plugin authors should use the supported contract imports, lifecycle rules, and adaptation patterns in the [Desktop plugin service architecture](docs/plugin-services.md).

## Mode setting and restart boundary

The `dsh-desktop.mode` field in the DSH home `settings.yaml` document is the single source of truth:

```yaml
dsh-desktop:
  mode: compatibility # or advanced
```

The launcher reads the same file resolved by the active `@deepseek-ai/dsh-settings-file` row before composing a generation. The Host registers the `dsh-desktop` namespace with the standard settings service. There is no parallel mode value in the profile manifest.

Users can select the other mode from the tray or edit the DSH home `settings.yaml` document by hand. The tray updates the registered `dsh-desktop` settings namespace, while a manual edit changes the same file observed by the settings provider. A committed change requests one orderly restart: the current Cordis tree disposes first, then Electron relaunches only after a successful zero-code shutdown. The application never hot-swaps root slots, native window materials, or Loader rows inside a live renderer generation.

Linux supports compatibility mode only. Its tray mode command is disabled, and an advanced value is rejected rather than silently falling back.

## Compatibility mode

`dsh-desktop.mode` defaults to `compatibility`. This mode creates a normal operating-system window with its native frame and loads the official Web surface from the active DSH profile. macOS suppresses the visible page title. Windows retains the native caption icon and displays `DeepSeek Harness Desktop`, but removes the window menu bar. The operating system owns native title-bar color and appearance.

The desktop Client module validates the mode and platform markers, then has no compatibility-mode effects. It does not provide or replace the `layout` service, register a `root` or `sidebar` occupant, install styles, or change the conversation surface. Compatibility mode preserves the selected profile's own layout, sidebar, and conversation composition; the ordinary `desktop` and `web` profiles therefore keep the official rows unchanged.

The Cordis row registers native window values during profile activation. The launcher creates the window only after `app-boot` settles and audits the complete profile, so the first renderer manifest includes the active official, desktop, and third-party client plugins without a Loader-wide wait inside the plugin itself.

On Windows, the launcher pins the existing browse directory-picker backend and client surface instead of the adaptive native chooser. Workspace selection therefore remains inside the Web UI and never loads the native N-API dialog worker in the Electron main process. macOS and Linux retain the upstream adaptive chooser.

Windows PowerShell keeps the upstream `pwsh-sandbox` behavior and Windows ACL confinement in both presentation modes. The launcher generation replaces only that Host provider with the `dsh-plugin-desktop/windows-pwsh-sandbox` subpath from this same package. For the exact upstream ACL-runner argv, the adapter launches the packaged Electron executable in Node mode through a private trampoline, removes the Node-mode variable before the restricted PowerShell process is created, and delegates all policy and failure handling back to the upstream runner. The desktop deploy root also pins a Yarn patch that combines `STARTF_USESHOWWINDOW` with the existing `STARTF_USESTDHANDLES` and `SW_HIDE` on both native restricted-process paths. This preserves captured stdio without suppressing console allocation and requests a hidden initial show state when Windows creates the GUI-hosted PowerShell process's first console window. It does not use the upstream-incompatible `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` flags. Direct `danger-full-access` PowerShell, macOS, and Linux execution are unchanged; there is no automatic unrestricted fallback when Windows confinement fails.

## Advanced mode

Advanced mode is an explicitly composed desktop presentation for macOS and Windows. After all user patches have been read, the launcher disables the official `ui-layout` Loader row, keeps the official `ui-sidebar` and `ui-conversation` rows enabled, and applies the selected mode to `desktop-shell`.

The desktop Client then provides the `layout` service for its own Cordis-fiber lifetime and registers only the `root` slot occupant. Its root declares seats for the unchanged upstream sidebar, conversation, details, and overlay contributions. The official sidebar remains the `sidebar` occupant and continues to declare the workspace browser, settings shell, and additive footer-action seats. This preserves its component behavior, collapse animation, and third-party extension points while the desktop package owns only frame geometry and native material.

The advanced theme presenter projects the active upstream theme snapshot onto the document, including color scheme, resolved token values, dark-mode marker, and theme-color metadata. It subscribes to ordinary theme changes and removes only its own projected state when the generation disposes.

For an advanced generation, the Electron adapter also reads the registered `ui-theme.preference` after Host boot and mirrors its built-in `light`, `dark`, or `system` value into Electron's native appearance before constructing the window. Committed preference changes update the native material while the window is active, and disposal restores the preceding Electron appearance. Client-only third-party theme ids do not change this Host preference.

The desktop sidebar surface scopes the upstream sidebar-fill token to transparent, so the official sidebar and session-list fade reveal the native material without changing their component styles.

On macOS the advanced window uses a transparent hidden-inset title bar, positioned traffic lights, and native `sidebar` vibrancy. Its 90 CSS-pixel collapsed column centers the official 56-pixel rail below a desktop-owned traffic-light inset. The sidebar surface itself is non-draggable; a desktop-owned transparent 32 CSS-pixel strip to the right of the traffic lights supplies its window drag target. A separate caption row reserves 20 CSS pixels above the complete conversation and details surfaces while exposing another transparent 32 CSS-pixel drag target. Buttons, links, inputs, dialogs, and contributions that explicitly declare `app-region: no-drag` remain interactive; a custom pointer target placed within the top 32 pixels must declare the same exclusion. On Windows the official sidebar keeps compatibility geometry: 56 pixels collapsed, 280 pixels by default when expanded, and the same upstream transition behavior, while its transparent surface reveals Mica. The window uses a hidden title bar with native controls, transparent overlay, Mica background material, shadow, rounded corners, and a thick resizable frame. Electron exposes the system-drawn Mica material on Windows 11 22H2 and later. A desktop-owned 32 CSS-pixel caption row spans the Windows conversation and details columns; the complete upstream slot surfaces start below that row, so official and third-party header contributions keep their ordinary relative layout without element-specific caption offsets. Linux rejects advanced mode rather than silently falling back to a presentation different from the persisted setting.

## Development

This package is managed by the Yarn workspace in `products/desktop/`. The Solar Harness source is the monorepo root two levels above that workspace and retains its independent pnpm graph. Install and verify DSH Desktop from `products/desktop/`:

```sh
yarn install
yarn check
```

The check verifies that every required first-party peer in the production graph is declared by the desktop deploy root. Headless Loader smokes activate the launcher-owned desktop row and a profile-local third-party row, then boot the published Web profile and inspect its loopback root and client manifest. Unit and type tests cover both profile compositions, restart fencing, client environment validation, desktop layout state, and platform-native window options.

Start the desktop application explicitly when a graphical session is available:

```sh
yarn dev
```

`dev` builds before launching. It does not require a separate manual build.

The headless-safe launcher surfaces can be exercised without importing or starting Electron:

```sh
node lib/bin.js --help
node lib/bin.js --version
node lib/product-server-bin.js --host 127.0.0.1 --port 3080 --trusted-host mini.example:3080
```

A Mac mini installs Product Server from one immutable GitHub release rather than a MacBook artifact. The installer verifies the tag-to-commit binding, builds and runs the release-shaped Product Server smoke on the Mac mini, atomically switches a LaunchAgent, retains the preceding release as `rollback`, and then proves HTTP, Remote Sync, and `operator.read/execute/interrupt`:

```sh
node scripts/install-product-server.mjs \
  --ref DSH-desktop-v3.9.1 \
  --commit <exact-40-character-release-commit>
```

The default installation creates a one-member cluster and permits exact-commit execution from the release repository. Use `--execution-repo <git-url>` for another single Git authority, or `--cluster-config <path>` to install a complete multi-Server membership and repository allowlist.

## Plugin workflow

Manage any profile with the ordinary DSH command:

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
dsh plugin --profile desktop update
```

The application starts with `desktop` by default. Choose another Web-capable profile from the tray's **Profile** submenu; switching profiles restarts the application. The generated DSH terminal defaults bare commands to the currently active profile, so the shorter forms below modify that profile directly:

```sh
dsh plugin add third-party-plugin
dsh plugin remove third-party-plugin
dsh plugin update
```

An explicit `--profile <name>` remains authoritative and is useful for preparing another profile before selecting it.

`dshmarket@1.2.3` is not preinstalled and is not a dependency of DSH Desktop. That release still resolves a profile from config/argv and starts `dsh plugin` through private child-process code; it neither reads `desktopProfiles` nor uses `desktopPnpm`, and its package exports no runner injection seam. A later compatible release must detect the Desktop services dynamically and retain its existing CLI fallback under ordinary DSH. In addition, the `1.2.3` source repository and npm tarball contain no complete MIT license text or copyright notice, so that version does not pass the bundled-redistribution gate. User-directed installation of a third-party package is separate from Desktop embedding it in the application archive or installer.

See [Plugin services for authors](docs/plugin-services.md) for required injection, optional Desktop adaptation, TypeScript examples, cancellation, and fallback guidance.

The package can then be launched from npm with:

```sh
npx dsh-plugin-desktop
```

A third-party Host plugin only needs its normal `dsh.bundle` patch. A plugin with browser UI also publishes the normal `dsh.client` metadata with `platform: "web"` and an exported `./client` artifact. The upstream Web client module graph discovers it in both modes; Electron does not require a separate client build or a desktop-specific registration API. Advanced-mode contributions must target services and slots that exist in that explicit composition rather than assuming the official layout or sidebar occupant owns them.

## Desktop operations

Packaged macOS and Windows applications query `https://www.dshdesktop.cn/api/desktop/version` 60 seconds after startup and every six hours after a completed check. Each no-cache request has a 15-second deadline and shares one in-flight operation with the **Check for Updates…** tray command. The response is accepted only when it contains canonical stable Semantic Versioning. Background network, HTTP, timeout, invalid-response, equal-version, and older-version outcomes are silent. A manual check always opens a native result dialog: equal or older results report the installed version, failures ask the user to retry, and a strictly newer version uses the **Download** or **Later** prompt. Automatic update prompts are remembered per version, while the tray can retry explicitly. Development, unpackaged, and Linux launches do not download an installer.

Choosing **Download** first rechecks that the advertised version is unchanged, then makes the first request to the platform's fixed counted download endpoint. DSH Desktop follows the service redirect through Electron networking, streams at most 1 GiB into a private versioned user-data directory, and rejects an incomplete DMG or Windows PE before exposing it. On macOS it opens the downloaded DMG and tells the user to replace the application in `Applications` and reopen it. On Windows it asks again after the NSIS installer is ready; **Restart and Install** launches that installer and requests orderly Cordis teardown before the current process exits. Download, filesystem, and installer-opening failures remain silent and leave the available-version tray action retryable.

Release operators must publish both platform artifacts before making a version discoverable. After the artifacts and download redirects are ready, set `deepseek-harness-desktop:release:version` to the canonical stable version in the Upstash Redis console, for example `SET deepseek-harness-desktop:release:version 2.0.1`. The version API changes immediately; missing, unavailable, or invalid values produce no Desktop prompt.

On macOS and Windows, **Open DSH Terminal** opens a system terminal rooted at the active profile. Its welcome text identifies the application version, active profile, profile directory, and DSH home, then lists configuration and plugin-management commands. Inside this terminal, bare `dsh`, `dsh --dump-config`, and plugin subcommands without a profile selection default to that active profile; an explicit `--profile` and the upstream `web` alias keep their original meaning. DSH Desktop generates private per-profile `dsh`, `pnpm`, and `node` shims under its user-data directory, sets `DSH_HOME`, uses the active profile as the working directory, and prepends the shim directory only to that terminal's `PATH`. A later profile switch therefore does not change commands in an already open terminal. It does not edit the global environment or shell startup files. The macOS launcher preserves the user's interactive zsh or bash setup before restoring the desktop-owned values. Windows selects PowerShell 7, Windows PowerShell, or Command Prompt in that order and opens it in a new Windows Terminal window; when `wt.exe` is unavailable, a private `cmd start` broker creates a visible console instead. Synchronous launch failures and unsuccessful broker exits are shown in a native error dialog. Linux does not compose the terminal command.

## Native lifecycle

Closing the window hides it while the Host Cordis tree continues running. The tray reopens the window, selects the active profile, opens the isolated DSH terminal, checks for a stable release, changes mode through the standard settings namespace, or requests an explicit quit. Profile and mode changes both dispose the current Cordis tree before Electron relaunches. Native quit, `SIGINT`, and `SIGTERM` also request disposal before exit; a five-second deadline or a repeated request forces the final exit. Navigation and redirects remain on the exact loopback origin; external HTTP, HTTPS, and mail links open in the operating system, while the renderer uses `contextIsolation`, the Chromium sandbox, and no Node integration.

## Packaging

`yarn package:dir` creates an unpacked directory for the current host platform. The packaged-runtime gate rejects an application archive that omits the desktop update and terminal modules, the DSH CLI bootstrap, the bundled pnpm entry, Resident/AgentTeams runtime packages, Code-as-Harness governance, the patched Anchored Standard preset, or the physical deployment package. Electron Builder emits the root manifest, desktop runtime, and complete dependency tree under `app.asar.unpacked`; both Host profile boot and the CLI bootstrap use this physical tree so DSH profile-fallback symlinks never target a virtual ASAR directory. `verify:vendor` rejects stale installed file dependencies before packaging, `verify:composition-package` composes those product inputs from the packaged Electron tree, while `verify:resident-package` qualifies native subscription providers from the packaged daemon and `verify:resident-execution` performs explicit no-tool product turns. `build/app-icon.png` remains the unmodified iOS Default source and the Windows/Linux application icon. The build runs `scripts/generate-mac-app-icon.mjs` to center that artwork at 824 by 824 pixels on a transparent 1024 by 1024 canvas; macOS packaging and the live Dock both use the generated `build/app-icon-mac.png`. `build/tray-icon.svg` is the brand-blue tray source: the build derives a macOS template image that the system colors automatically and fixed brand-blue Windows and Linux tray images.

`yarn verify:orchestration-e2e` is the installed-product acceptance for durable orchestration. Because it consumes qualified Claude Code and Codex native subscriptions, it fails before contacting the Desktop unless `DSH_ALLOW_SUBSCRIPTION_E2E=1` explicitly authorizes an affected final acceptance. Its default minimal matrix rejects a cyclic Graph, proves high-tier planning and verification around two parallel low-tier DAG leaves, seals an enabled node-local RLM plan, recalls a prior Continuous Harness outcome, queries the running Host projection, and opens the real Desktop workbench through CDP. The RLM comparison keeps both candidate methods anonymous until the high-tier verifier settles, then records the frozen outputs, reveal mapping, verdict, full source commit, and product version as reusable real-subscription quality evidence. It reuses still-valid deterministic or earlier installed-product evidence for the three separate goal-policy turns and the separate scope-conflict turns. `DSH_SUBSCRIPTION_E2E_FULL_MATRIX=1` separately authorizes those five additional subscription turns when their behavior is actually affected. The command writes a JSON evidence artifact, including its mode and reused coverage, under `dist/acceptance/`; module mocks cannot satisfy the live portion of this gate.

### Local Windows x64 installer

Use a native Windows x64 machine with Git and x64 Node `22.23.2` (the same release used by CI). The packaging command accepts Node `22.19+` and Node `24.x`, whose official distributions include the required Corepack command. From PowerShell in a fresh `v2` checkout, run:

```powershell
corepack.cmd yarn install --immutable
corepack.cmd yarn dist:win
```

Python and Visual Studio C++ Build Tools are not required. The Windows command uses `node-pty`'s bundled x64 Node-API binaries instead of asking Electron Builder to rebuild them from source, and the packaged-runtime gate rejects an installer staging tree that omits those binaries.

`dist:win` refuses non-Windows and non-x64 hosts, runs a Windows-safe gate containing the build, all TypeScript compiler faces, packaging and native-shell focused tests, and the runtime-closure verifier, then builds an assisted NSIS installer and verifies both generated PE files. The full cross-platform suite remains CI-owned because some POSIX execution tests are not Windows programs. The installer allows a per-user or elevated all-users installation, permits changing the installation directory, creates Start Menu and desktop shortcuts, and preserves DSH user data when the application is uninstalled. Version `2.0.0` is written to `dsh-plugin-desktop\dist\DSH-Desktop-2.0.0-x64-Setup.exe`; the unpacked application remains at `dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe` for smoke testing.

This local command deliberately strips Windows certificate variables and sets `signExecutable=false`. Its output is installable for testing but has no Authenticode publisher, so Windows can display an Unknown publisher or SmartScreen warning. A signed Windows release, certificate verification, installer upgrade/uninstall testing, and native UI/sandbox smoke remain separate release gates.

## Model Experience

The product layer adds AgentTeams and the existing physical-operator tool surface. The per-Session strategy defaults to Smart Collaboration and is available beside chat-model selection; it can be overridden with the `/operator` command or the Desktop panel. Resident execution returns only bounded continuity metadata, and the underlying run API still treats an omitted `mode` as ephemeral. A live system-prompt section evaluates every non-trivial task against available descriptors, tags, and modes, while the Session-header dashboard exposes status only to the human observer. Packaged Anchored Standard gives both the main agent and delegated agents the two-tool first-turn bootstrap. AgentTeams puts its coordination protocol in the worker's first user message and preserves the preset persona.

#### KV Cache effect

The Desktop composition does not add a second model-request pipeline. Anchored Standard and AgentTeams affect the same request assembled by the DSH Host; changing presets still changes cache identity as it does in ordinary DSH.

## Known Limitations and Deferred Work

- Adding or removing a profile bundle requires restarting DSH Desktop; the launcher does not watch profile manifests. Selecting another profile from the tray performs that restart automatically.
- Switching compatibility/advanced mode always restarts the application by design; a live generation never hot-swaps Loader rows, slot ownership, or native materials.
- Advanced mode is unavailable on Linux. Linux continues to use the compatibility presentation.
- Resident native-product qualification and release acceptance are currently macOS-only. A missing subscription login or a changed pinned Claude/Codex protocol fails loud and never falls back to an API key; ordinary ephemeral operators remain available.
- Desktop resolves the user-owned `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, or `~/.volta/bin` product installation before an inherited system PATH. This keeps Finder and terminal launches on the same qualified Claude/Codex release and avoids a root-owned legacy Claude CLI sharing and rotating the same macOS Keychain credential. Claude Agent SDK discovery and execution are pinned to that resolved client as well, so the SDK cannot silently fall back to a different bundled CLI with different token-refresh or TLS behavior.
- The macOS and Windows tray terminal exposes private `dsh`, `pnpm`, and `node` shims. Separately, the Host runtime exposes the bundled `pnpm` command on the current Electron process `PATH` for ambient compatibility and provides the managed `desktopPnpm` service; none of these commands are added to the system `PATH`, and Linux currently has no desktop terminal command.
- On Windows, the ambient `pnpm` command and lifecycle Node helper are `.cmd` shims. `desktopPnpm.run()` and `runPlugin()` avoid shell lookup for the manager process by launching exact packaged entries, while upstream `dsh plugin`, PowerShell, and Command Prompt can resolve the ambient shim through a command interpreter. A third-party plugin that calls Node `spawn('pnpm', { shell: false })`, or a lifecycle script that directly executes its `.cmd` `npm_node_execpath` with `shell: false`, remains non-portable and should use the managed service or a shell-aware launch path.
- `dshmarket@1.2.3` remains an optional user-installed third-party package, not a bundled marketplace. Preinstallation is deferred until an audited release consumes the optional Desktop services while preserving ordinary DSH fallback and includes the complete license notice required for redistribution.
- The update handoff validates the download container, not publisher identity. macOS still requires the user to replace the application from the opened DMG; Windows runs the downloaded NSIS installer but the local `dist:win` artifact is unsigned. Signed artifacts, Authenticode/publisher verification, SmartScreen reputation, and native upgrade testing remain release gates.
- The shared carrier is loopback HTTP and WebSocket, not Electron IPC. Replacing it requires transport extension points in upstream DSH and is outside this standalone package.
- During P1-P2 migration this product pins the published DSH `0.1.0-rc.6` family, while the imported Solar core has its own source version and provenance. Tests continue to validate the published package interfaces until a later source-integration phase qualifies and changes that dependency boundary.
- `package:dir` is an unpacked smoke artifact. `dist:win` adds an unsigned NSIS test installer but does not establish Authenticode identity or SmartScreen reputation. Installation and upgrade behavior, native notifications and terminals, the Windows ACL sandbox, and native-material appearance remain target-platform verification boundaries.
