# DSH 3.x extraction candidates

Source: package directories present in DSH 3.x (`origin/solar` 9330e3d801) but absent at its fork point (upstream rc.5, `47f94385`), plus `plugins/managed/` and the third-party packages DSH Desktop vendors. The original 2026-10-18 inventory used directory names only. The scoped native-provider and subscription assessment was added on 2026-10-19 in the [integration and migration plan](integrations/dsh-codex-subscription.md); other rows remain unassessed. "Possible upstream overlap" means rc.2 has a package with a similar name, not that it covers the feature.

Status values: `unassessed`, `use-upstream`, `use-existing` (reuse an existing third-party plugin), `blocked` (see `blocked-seams.md`), `porting`, `shipped`, `dropped`. Reuse recommendations do not mean a new V4 migration plugin has been implemented, formally accepted, or released.

| Feature | DSH 3.x packages | Possible upstream overlap in rc.2 | Status |
|---|---|---|---|
| Local durable TaskGraph and scheduling | `orchestration/orchestration(-local)`, `tool-orchestration` | `workflow`, `goal`, `experimental/agent-team` do not establish equivalent durable scheduling | porting: native-resident |
| Conversation collaboration mode and execution-flow editor | `ui-orchestration`, `bundle/orchestrations`, `intent-compiler`, `context-compiler`, `capability-capsule` | varies | porting: native-collaboration session mode and `执行流程` source/draft/run editor; source implementation only, installed acceptance not claimed |
| Debate | `orchestration/debate(-local)`, `debate-orchestration`, `tool-debate`, `ui-debate` | — | unassessed |
| Kennel / gouzi members | `host/gouzi-member`, `orchestration/ui-gouzi`, `kennel-review` | `experimental/agent-team` | unassessed |
| RLM runtime and strategy | `orchestration/rlm-runtime(-local)`, `rlm-strategy(-local)` | — | unassessed; explicitly excluded from this task |
| Native model/executor allocation | `orchestration/model-allocation(-local)`, native catalog/routing | `llm/*` | porting: native-collaboration rules and advertised catalogs |
| Other workers/model allocation | `model-worker`, `model-worker-deepseek`, `llm/model-catalog-local` | varies | unassessed |
| Scheduling evidence | `orchestration/scheduling-evidence(-rpc)`, `client/ui-settings-scheduling-evidence` | — | unassessed |
| Continual harness | `orchestration/continual-harness(-local)` | — | unassessed |
| ChatGPT Web text and Insight analysis workflow | `physical-operator/physical-operator-chatgpt-web`, `bundle/chatgpt-web-operator` | Public browser-use exists, but the V3 private browser/physical-operator seams do not | porting: [chatgpt-web](integrations/chatgpt-web.md); current source paths are `ChatGPT 网页算子`, `洞察分析`, and session-scoped `执行流程`; installed/full real Insight acceptance is not claimed |
| Native Resident, session lanes and tool bridging | `resident-operator*`, native Drivers and model-tool bridge | official external providers are one-shot | porting: native-resident |
| Codex subscription model in the main DSH conversation | Native-model menu/routing in `tool-physical-operator`, `ui-physical-operator`, and Resident integration | Existing third-party `dsh-codex-subscription`; see the plan for the search-boundary correction and non-equivalent native-session behavior | use-existing |
| Browser (ego-lite) | `browser/browser`, `browser-ego-lite`, `tool-browser`, `bundle/ego-lite-browser` | `browser-use`, `experimental/browser-use-stagehand-native` | unassessed |
| Task templates | `prompt/task-template`, `task-template-context`, `task-template-rpc`, `client/ui-task-template` | — | unassessed |
| Output style | `core/output-style` | — | unassessed |
| Remote access | `host/remote-auth`, `client/ui-remote-modules` | — | unassessed |
| Basic Codex / Claude Code task delegation | edits to 10 upstream `subagent/*` source files listed in `distribution/upstream-source-edits.json` | Official `subagent-codex`, `subagent-claude-code`; user reports both installed and working | use-upstream |
| Managed plugins | `plugins/managed/`: aegis, agent-teams, archify, better-sidebar, codegraph, genui, governance, llm-fallbacks, mnemon, plugin-check, plugin-console, synapse, tool-markdown, tool-regex, tool-stat, tool-time, web-billing, web-ui | varies | unassessed |
| Vendored third-party | `dsh-web-billing`, `@linxin666/dsh-remote-web-ui`, `@ycp424c/dsh-luna-vision-bridge` | — | unassessed (already external packages) |

The authorized migration is **two independently installable Solar plugins**, described in the [implementation contract](native-plugins-contract.md). Collaboration owns handoff and allocation; Resident owns native execution, lanes, tool bridging and durable graph scheduling. No candidate is marked `shipped`: installed-app acceptance and publication are separate. The earlier one-message `GPT-6 / medium` synthetic Web canary belongs to an older candidate and does not establish the current conversation or full Insight path. Gemini Deep Research semantic selectors and requested model availability remain unverified. This documentation change made no paid model calls; the explicit Claude check remains quota-consuming when separately authorized. RLM remains separately excluded.
