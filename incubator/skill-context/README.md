# Solar on-demand skill context

This preview bundle changes automatic skill discovery through the published DeepSeek Harness `0.2.1-rc.2` plugin APIs. It does not delete or disable the skill library and does not modify the official App.

## Behavior

The official skill catalog normally republishes a complete list after its name/description digest changes. Its replacement wording does not itself retire earlier bodies from the Session surface. With a large global library, several nearly identical catalogs can remain in the same native request.

This plugin intercepts automatic catalog proposals at the normal `agent/pre-step` admission hook and substitutes one short, logged discovery notice. Old visible official catalog records are individually replaced through canonical `Session.append` surface operations. Their replacements have empty developer content, which the official Session derives to no model message. Every replacement cites its original event. Original log entries remain intact; intervening user messages, assistant replies, tool calls/results and loaded skill bodies are preserved. Reopening a Session applies the same admission rules before the next request.

The official `skill` tool and explicit user skill invocation stay unchanged. A new read-only `solar_skill_search` tool searches the complete agent/cwd-scoped registry, returns a bounded page of names and descriptions, and exposes `nextOffset` when more matching entries exist. The caller then loads the selected full instructions through the official tool. Search does not execute a skill, call a model or access a remote search service. An incomplete registry snapshot produces a named error rather than a false complete listing.

An agent-scoped tool policy that permits `skill` must also permit this plugin's `solar_skill_search`. If it hides or shadows search while leaving the loader visible, admission stops with `SKILL_CONTEXT_SEARCH_UNAVAILABLE` before changing that Session surface. The plugin never changes an allowlist or silently removes the only discovery mechanism. A scope that cannot load skills receives no discovery notice.

## Configuration

| Field | Default | Allowed range | Meaning |
|---|---:|---:|---|
| `maxResults` | 8 | 1–20 | Maximum matches in one page. |
| `maxDescriptionChars` | 240 | 40–500 | Maximum Unicode characters per returned description; the byte cap may shorten it further. |
| `maxResponseBytes` | 8192 | 1024–32768 | Maximum UTF-8 bytes for the complete search result JSON. |

Search accepts a nonempty query of at most 256 characters and an optional nonnegative `offset`. Use a few descriptive keywords or an exact skill name. The result is keyword matching over names/descriptions, not semantic model search; translating task terms to the catalog's language may be necessary. Pagination is over the current snapshot; if available skills change between pages, restart the query rather than assuming stable offsets across versions.

Disable/unload removes the plugin's hook and search tool through the normal lifecycle. The official loader and its default catalog mechanism remain available. The short notice is conditional on the search tool still being available, so a historical notice does not instruct use of a removed tool. Retired original catalog events are not destructively restored or deleted.

## Data and failure boundaries

The plugin creates no private database and writes no skill files. Its only persistent changes are ordinary official Session messages with canonical source references; there are no custom plugin event types or imported credentials. Unsupported catalog shapes or unconfirmed persistence stop admission with `SKILL_CONTEXT_CATALOG_INVALID` or `SKILL_CONTEXT_FLUSH_FAILED`. Configuration errors use `SKILL_CONTEXT_CONFIG_INVALID`. Full skill bodies and explicit tool results are intentionally not compressed by this plugin.

## Verification

Source verification, built scratch-profile checks, exact package installation, App loading and actual-request verification are tracked separately in the [contract](../../docs/skill-context-contract.md). The stable local gate passed 97 tests across 12 files, types/build, two built scratch CLI profile probes and the generated-homepage check. Nine integration cases use the published AgentLoop with a capturing fake adapter: the pre-fix request contains 1,467/1,475/1,477-entry catalogs; repaired requests contain zero full catalogs and one notice below 1,024 UTF-8 bytes. Search and official loading, scoped tool restrictions, failed/throwing flush retries, canonical event replay and disposal are covered. The flush listener in the isolated request harness counts calls; it is not the installed filesystem backend, and seed replay alone is not an App restart/persistence test. All 11 production archive files were verified after installation. An internal temporary bundle then exercised that installed package inside the App Host with an isolated AgentLoop, a 1,477-entry registry and a fake adapter; three historical catalogs were retired, newest-skill search/load passed and no real provider call or user Session write occurred. The Desktop-specific follow-up mounts the official loader in Agent scope, matching the published Web App preset, and its 10 affected tests passed. The temporary bundle was removed through the official CLI. This is not real user-session disk-backend restart or provider acceptance. Manual plugin-list confirmation is recorded separately. No real provider/model request or old failed request replay is part of this repair's acceptance.
