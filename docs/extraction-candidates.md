# DSH 3.x extraction candidates

Source: package directories present in DSH 3.x (`origin/solar` 9330e3d801) but absent at its fork point (upstream rc.5, `47f94385`), plus `plugins/managed/` and the third-party packages DSH Desktop vendors. The original 2026-10-18 inventory used directory names only. The scoped native-provider and subscription assessment was added on 2026-10-19 in the [integration and migration plan](integrations/dsh-codex-subscription.md); other rows remain unassessed. "Possible upstream overlap" means rc.2 has a package with a similar name, not that it covers the feature.

Status values: `unassessed`, `use-upstream`, `use-existing` (reuse an existing third-party plugin), `blocked` (see `blocked-seams.md`), `porting`, `shipped`, `dropped`. Reuse recommendations do not mean a new V4 migration plugin has been implemented, formally accepted, or released.

| Feature | DSH 3.x packages | Possible upstream overlap in rc.2 | Status |
|---|---|---|---|
| DSH task orchestration (legacy dual-mode) | `orchestration/orchestration(-local)`, `tool-orchestration`, `ui-orchestration`, `bundle/orchestrations`, `intent-compiler`, `context-compiler`, `capability-capsule` | `workflow`, `goal`, `experimental/agent-team` | unassessed |
| Debate | `orchestration/debate(-local)`, `debate-orchestration`, `tool-debate`, `ui-debate` | — | unassessed |
| Kennel / gouzi members | `host/gouzi-member`, `orchestration/ui-gouzi`, `kennel-review` | `experimental/agent-team` | unassessed |
| RLM runtime and strategy | `orchestration/rlm-runtime(-local)`, `rlm-strategy(-local)` | — | unassessed |
| Model allocation and workers | `orchestration/model-allocation(-local)`, `model-worker`, `model-worker-deepseek`, `llm/model-catalog-local` | `llm/*` | unassessed |
| Scheduling evidence | `orchestration/scheduling-evidence(-rpc)`, `client/ui-settings-scheduling-evidence` | — | unassessed |
| Continual harness | `orchestration/continual-harness(-local)` | — | unassessed |
| Physical operator (ChatGPT Web, resident, subagent) | `physical-operator/*`, `bundle/chatgpt-web-operator`, `bundle/resident-operators` | `browser-use`, `experimental/browser-use-*` | unassessed |
| Codex subscription model in the main DSH conversation | Native-model menu/routing in `tool-physical-operator`, `ui-physical-operator`, and Resident integration | Existing third-party `dsh-codex-subscription`; see the plan for the search-boundary correction and non-equivalent native-session behavior | use-existing |
| Browser (ego-lite) | `browser/browser`, `browser-ego-lite`, `tool-browser`, `bundle/ego-lite-browser` | `browser-use`, `experimental/browser-use-stagehand-native` | unassessed |
| Task templates | `prompt/task-template`, `task-template-context`, `task-template-rpc`, `client/ui-task-template` | — | unassessed |
| Output style | `core/output-style` | — | unassessed |
| Remote access | `host/remote-auth`, `client/ui-remote-modules` | — | unassessed |
| Basic Codex / Claude Code task delegation | edits to 10 upstream `subagent/*` source files listed in `distribution/upstream-source-edits.json` | Official `subagent-codex`, `subagent-claude-code`; user reports both installed and working | use-upstream |
| Managed plugins | `plugins/managed/`: aegis, agent-teams, archify, better-sidebar, codegraph, genui, governance, llm-fallbacks, mnemon, plugin-check, plugin-console, synapse, tool-markdown, tool-regex, tool-stat, tool-time, web-billing, web-ui | varies | unassessed |
| Vendored third-party | `dsh-web-billing`, `@linxin666/dsh-remote-web-ui`, `@ycp424c/dsh-luna-vision-bridge` | — | unassessed (already external packages) |

The proposed bounded native-collaboration migration is **one independently installable Solar plugin**, described in the [integration plan](integrations/dsh-codex-subscription.md#the-migration-plugin). It reuses the installed providers and adds only reviewed collaboration behavior. The broader physical-operator family is not approved for wholesale migration. No candidate is marked `porting` or `shipped`; the first implementation remains unscheduled under D7.
