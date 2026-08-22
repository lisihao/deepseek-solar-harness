# DSH — DeepSeek Solar Harness

English | [中文](README.zh.md)

**The Solar distribution of DeepSeek Harness, built as a macOS-first Desktop application and an extensible all-in-one AI workbench.**

DeepSeek-Solar-Harness (`DSH`) is a downstream product based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps the upstream plugin architecture and agent runtime, then owns an independent Solar integration branch, Desktop product, managed plugins, release identity, and engineering governance. The project currently supports macOS; other operating systems are outside the accepted product contract.

This repository is the complete development source for the Solar core, Desktop shell, and Solar-maintained plugins. It does not represent an official DeepSeek AI release, and Solar changes are not submitted back to the upstream repositories.

## Product goals

DSH aims to make one local application the daily control center for conversations, tools, sessions, memory, context, coding agents, collaboration, remote interfaces, and observable task execution. The product protects five properties while adding capabilities:

1. **Model capability.** The packaged Anchored Standard preset begins the main agent and delegated workers with only `bash` and `str_replace_editor`, then exposes further tools on demand. This limits first-turn tool-schema pressure without removing later capability.
2. **Continuity.** Session history, runtime ownership, memory, task progress, and resume behavior must survive ordinary UI navigation and process boundaries without silently changing the selected execution path.
3. **Composability.** Core behavior, Desktop presentation, and product features remain Cordis plugins or explicit product inputs. A feature must not depend on an undocumented patch to generated runtime state.
4. **Reproducibility.** Every Solar-owned source input has a repository path, accepted revision, license record, native tests, and reviewable history. Installed applications and user profiles are outputs, never source.
5. **Controlled evolution.** Upstream changes are discovered as candidates, qualified against Solar contracts, and merged only after conflicts, compatibility, behavior, packaging, and governance evidence are accepted.

## Product characteristics

- A macOS Desktop application with compatibility and advanced presentation modes, native lifecycle integration, isolated profiles, an embedded DSH terminal, update discovery, and explicit product-version display.
- The DeepSeek Harness agent, model, tool, session, Web, sandbox, workflow, and plugin foundations, developed on the protected `solar` integration line.
- A two-tool first-turn bootstrap for the accepted Anchored Standard product preset, including delegated AgentTeams workers, followed by on-demand capability discovery.
- Smart and resident operator paths, AgentTeams collaboration, Mnemon memory, native DeepSeek V4 Flash Vision, Web billing, and the managed Web UI collection.
- A sealed controlled-plugin suite for the Better Sidebar, GenUI, plugin diagnostics, model fallbacks, code graphs, and bounded stat, time, regex, and Markdown tools.
- A repository-owned Code-as-Harness completion authority that selects native checks from the outgoing diff, records attestation evidence, and fails closed on missing or stale governance wiring.
- One source repository for coordinated core, Desktop, and managed-plugin changes, while each component retains its native package manager and test contract.

## Architecture

DSH preserves the upstream Cordis principle that capabilities compose through plugins, services, events, and profile configuration. The Solar product adds a controlled repository and distribution layer around those runtime mechanisms.

```text
DeepSeek-Solar-Harness
├── Core Harness (pnpm workspace)
│   ├── agents, models, tools, sessions, workflows, sandboxes
│   └── Web host/client and Cordis plugin runtime
├── products/desktop (Yarn workspace)
│   └── Electron shell, profiles, native lifecycle, packaging, product UI
├── plugins/managed
│   ├── governance (the user-created Code-as-Harness project)
│   ├── agent-teams, mnemon, aegis, better-sidebar, genui
│   ├── plugin-check, llm-fallbacks, codegraph, tool plugins
│   └── web-billing, web-ui, plugin-console
├── distribution
│   └── product identity, Desktop version, tag contract, upstream records
└── protected solar branch
    └── reviewed task branches + CI + Code-as-Harness attestation
```

The core stays at the repository root so its pnpm workspace remains valid. Desktop lives at [`products/desktop`](products/desktop) as an independent Yarn workspace and must not contain another Harness checkout. Solar-owned components live under [`plugins/managed`](plugins/managed); [`plugins/registry.yaml`](plugins/registry.yaml) is their machine-readable source, revision, license, and test registry. Product and upstream metadata lives under [`distribution`](distribution).

Desktop installs accepted sealed package inputs during its Yarn build, and every sealed package is mapped back to a tracked source package in [`products/desktop/dsh-plugin-desktop/vendor/manifest.json`](products/desktop/dsh-plugin-desktop/vendor/manifest.json). `yarn verify:vendor` extracts each archive manifest, compares every non-generated packaged file with its tracked source, and rejects untracked, missing, stale, or name/version-mismatched inputs. A fresh clone therefore contains the source for every package sealed into the default Desktop application.

Optional plugins that a user installs into `~/.dsh` are profile extensions, not default Desktop build inputs. They stay external while unmodified; a plugin enters [`plugins/managed`](plugins/managed) with provenance and native tests when Solar changes or bundles it. Personal Remote Modules page names, URLs, and relay ports also stay in local profile settings: the public application ships the configuration surface with an empty instance list.

## Relationship with upstream projects

| Subject | Upstream role | Solar rule |
| --- | --- | --- |
| DeepSeek Harness | Runtime and plugin-architecture origin | Read-only upstream input; Solar changes stay in this repository |
| Desktop ancestor | Product-shell design origin | Imported history; Solar owns the current macOS product |
| External plugins | Independent plugin releases | Remain external when unmodified; lock accepted versions |
| Managed plugins | Upstream or fork source for Solar-modified capabilities | Preserve imported history under `plugins/managed`; never push Solar changes upstream |
| Code-as-Harness | User-created Codex project `agent-development-governance` | Exact authority imported at `plugins/managed/governance`; never substitute a generic or same-named project |

The accepted source revisions are data, not prose: consult [`distribution/upstreams.yaml`](distribution/upstreams.yaml) and [`plugins/registry.yaml`](plugins/registry.yaml). Their verifier rejects missing paths, malformed revisions, missing license evidence, unbound subtree imports, nested gitlinks, a mismatched governance bundle, or an invalid Desktop tag contract.

## Upstream update policy

“Latest” means the newest revision detected for evaluation; it never means automatically accepted. Every core, Desktop ancestor, or managed-plugin update follows this sequence:

1. **Discover.** Record the current accepted revision and the new remote revision without changing `solar` or a running installation.
2. **Classify.** Assign risk `R0` to metadata-only changes, `R1` to isolated leaf-plugin changes, and `R2` to session, agent loop, sandbox, persistence, default composition, or Desktop packaging changes.
3. **Import mechanically.** Create an isolated candidate worktree and commit the upstream movement separately from Solar adaptations. Preserve upstream history and report every conflict.
4. **Analyze compatibility.** Compare manifests, APIs, event and persistence vocabularies, profile composition, tool exposure, Desktop package closure, and user-visible behavior.
5. **Qualify.** Run the complete affected component suites, the root product contract, Code-as-Harness full verification and attestation, and any applicable runtime or Desktop D00–D08 acceptance.
6. **Review and merge.** Open a PR to protected `solar` with old/new revisions, conflict decisions, evidence, rollback point, and unresolved limits. `R2` requires human approval; automation never merges it directly.
7. **Record acceptance.** Update the registry or upstream manifest only for the reviewed revision. Failed candidates leave the accepted revision unchanged.

The governing decisions are [ADR-003](docs/architecture/adr-003-managed-plugin-lifecycle.md) and [ADR-004](docs/architecture/adr-004-upstream-qualification.md). Upstream automation may open candidate branches or reports, but it receives no authority to publish packages, push to upstream repositories, or mutate an installed application.

## Development with AI coding agents

In this repository, **Code-as-Harness means only the project created by the user in Codex: `agent-development-governance`**. Its authoritative skill and implementation are imported under [`plugins/managed/governance`](plugins/managed/governance); the repository entry skill at [`.agents/skills/dsh-code-as-harness`](.agents/skills/dsh-code-as-harness/SKILL.md) binds that authority to DSH. The exported runner and digest manifest live under [`tools/agent-development-governance`](tools/agent-development-governance).

Every AI coding agent must follow this lifecycle:

1. Resolve the physical Git root under `/Users/sihaoli/Projects`, read root and nearest `AGENTS.md` files, then read the repository Code-as-Harness skill and its imported authoritative skill and contract.
2. Work in an isolated task worktree based on protected `solar`; never edit generated runtime state, `/Applications/DSH Desktop.app`, or another task's worktree as source.
3. Run strict audit and a full change-aware plan before editing. Preserve dirty-worktree ownership and exact component boundaries.
4. Implement the smallest complete change with its written rule, executable control, wiring, invalid-case test, and fail-closed aggregate when governance changes.
5. Run component-native checks plus Code-as-Harness full verification and attestation against the complete `origin/solar` diff.
6. Commit the accepted bytes, rerun verification against that exact commit, push the task branch, fetch it, and prove local and remote SHAs are equal.
7. Report local and remote SHAs, PR or release URL, gate evidence, runtime evidence where applicable, and every `warn`, `error`, or `pending` result. Creating a PR or artifact is not completion.

Use these entry commands from the repository root:

```sh
python3 tools/agent-development-governance/governance.py audit --project . --strict-warnings
python3 tools/agent-development-governance/governance.py plan --project . --scope auto --level full --changed-from origin/solar
python3 tools/agent-development-governance/governance.py verify --project . --scope auto --level full --changed-from origin/solar --report @git
python3 tools/agent-development-governance/governance.py attest --project . --report @git --require-level full
```

Desktop changes additionally follow the complete D00–D08 protocol in [`products/desktop/AGENTS.md`](products/desktop/AGENTS.md). A migration-only, documentation-only, or governance-only change does not install or restart the application and must state that exception explicitly.

<a id="run"></a><a id="run-from-source"></a>

## Local development

Prerequisites are macOS, Git, Node.js `22.19+` or `24+`, and Corepack. The root and Desktop dependency graphs remain intentionally separate.

```sh
git clone https://github.com/lisihao/deepseek-solar-harness.git
cd deepseek-solar-harness
corepack pnpm install --frozen-lockfile
corepack pnpm run build

cd products/desktop
corepack yarn install --immutable
corepack yarn check
```

Run graphical Desktop development only when a graphical session is intended:

```sh
cd products/desktop
corepack yarn dev
```

Managed components use the commands recorded in [`plugins/registry.yaml`](plugins/registry.yaml). Do not install every plugin into one package-manager workspace: component lockfiles and native checks remain part of their accepted provenance.

Configure personal Web pages after launch under **Settings → Plugins → Remote Modules**. Those values are written to the local DSH profile and are intentionally absent from Git, vendor archives, and public product defaults.

## Branches, commits, and pull requests

- `solar` is the protected integration branch. All changes enter through a task branch in an isolated worktree; direct pushes, force pushes, and branch deletion are forbidden.
- Use Conventional Commits such as `feat(desktop): ...`, `fix(memory-evolve): ...`, `sync(plugin/web-ui): ...`, or `docs(readme): ...`. Mechanical upstream imports and Solar adaptations must be separate commits.
- A non-draft PR targets `solar`, references its requirement or issue, identifies affected components and risk class, and explains user-visible behavior and compatibility impact.
- The PR records source and license provenance for new managed code, exact old/new revisions for an upstream movement, test commands and results, a Code-as-Harness attestation, rollback information, and any unresolved limitation.
- Desktop product or package changes include the assigned Semantic Version, source/package/running version equality, D00–D08 evidence, installed-app backup path, process/listener/HTTP proof, remote SHA, and release URL. A task outside app-delivery scope states why these checks do not apply.
- Required CI, conversation resolution, CODEOWNERS review, and the latest-push approval must pass. The authoring agent cannot replace required human approval for an `R2` change.

## Release identity

DSH Desktop versions independently from DeepSeek Harness and every plugin. A stable release uses an annotated tag that matches exactly `^DSH-desktop-v[0-9]+\.[0-9]+\.[0-9]+$`, for example `DSH-desktop-v2.6.0`. The old `desktop-v2.4.3` shape is invalid.

A release identifies the Solar commit, Desktop version, accepted core and managed-plugin revisions, test and attestation evidence, artifact checksums, supported platform, and rollback target. Building `dist/`, observing an Electron process, or pushing a tag without installed-version acceptance does not constitute a Desktop delivery.

## Development roadmap

| Phase | Required outcome |
| --- | --- |
| Repository foundation | Protected `solar`, monorepo boundaries, preserved Desktop/plugin history, provenance registry, Code-as-Harness skill and executable controls |
| Upstream watch | Scheduled read-only discovery for core, Desktop ancestor, and every managed plugin; candidate report with old/new revisions and risk class |
| Candidate intake | Reproducible candidate worktree, mechanical import commit, Solar adaptation commit, conflict and interface-change report |
| Source integration | Replace temporary published or sealed Desktop inputs only where same-repository builds pass closure, compatibility, and rollback tests |
| Product acceptance | Automated session/resume, first-turn tool exposure, memory/context, managed-plugin, Desktop lifecycle, packaging, and update-path scenarios |
| Release automation | Signed and notarized macOS artifact, exact version display, checksums, release manifest, fixed GitHub Release, recovery and rollback evidence |
| Product expansion | Evaluate additional platforms, plugin marketplace curation, remote access, observability, and richer agent collaboration only after macOS contracts remain green |

Roadmap work must preserve the protection goals above. A new feature is not accepted when it weakens model capability, session durability, provenance, release identity, or the ability to qualify upstream movement.

## Source and runtime boundaries

- The physical development checkout and every linked worktree live under `/Users/sihaoli/Projects`. The Documents path is compatibility-only and must not contain physical Git metadata, dependencies, or build output.
- `/Users/sihaoli/Library/Application Support/DeepSeek-Solar-Harness` and `/Applications/DSH Desktop.app` are generated runtime deployments. Never edit them as source or copy their changes back into Git.
- Credentials, profiles, sessions, memories, caches, `node_modules`, and build artifacts never enter source imports. A fresh clone must reconstruct the product from tracked sources and declared inputs.
- This repository never grants authority to deploy a Mac mini. A later remote deployment pulls an identified GitHub Release and verifies it independently.

## Documentation and decisions

Start with [`AGENTS.md`](AGENTS.md) for standing agent rules, [`docs/architecture.md`](docs/architecture.md) for the upstream runtime map, and the Solar ADRs for downstream ownership: [product identity](docs/architecture/adr-001-downstream-solar-product.md), [monorepo](docs/architecture/adr-002-monorepo.md), [managed plugins](docs/architecture/adr-003-managed-plugin-lifecycle.md), [upstream qualification](docs/architecture/adr-004-upstream-qualification.md), and [AI agent authority](docs/architecture/adr-005-ai-agent-authority.md).

## License

The core repository is licensed under [MIT](LICENSE). Imported components retain their own license files and declarations; [`plugins/registry.yaml`](plugins/registry.yaml) records the accepted evidence. Third-party runtime dependencies are disclosed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
