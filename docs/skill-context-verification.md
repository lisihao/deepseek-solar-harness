# Skill context repair verification

## Identified artifacts

The production runtime is source `9fb931bb39913463fce79ad2955a160934a368d3`, package `@lisihao/dsh-solar-skill-context@0.1.0-dev.0`, archive SHA-256 `4c75036ce7a910c1d1c3660199ed149e2ba4d578791c030c4b5d9265754992c4`. All 11 packed files matched the installed profile. No official App file, global skill library or model capability/window was changed by this repair.

The source gate passed 97 tests in 12 files, build/types, two built scratch-profile CLI probes and the generated homepage check. Exact CI [39640560192](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39640560192) passed. A later fixture-only correction at `8d34bbd9b91b6f9301689069248a1ef95c6d35df` added the Desktop-scoped loader case; 10 affected AgentLoop tests and types passed, as did exact CI [39642142906](https://github.com/lisihao/deepseek-solar-harness/actions/runs/39642142906). Production source and archive bytes did not change for that fixture correction.

## Request and installed Host evidence

The published rc.2 AgentLoop reproduced three full catalog versions containing 1,467, 1,475 and 1,477 entries before repair. Repaired requests contain zero full catalogs and one discovery notice below 1,024 UTF-8 bytes. Existing user messages, tool call/result ordering and original event prefixes remain. Search covers the complete scoped registry with bounded result JSON; the official loader still returns full selected instructions. Malformed catalogs, incomplete snapshots, hidden/shadowed search tools and failed/throwing persistence barriers have explicit failure checks.

The first installed-Host fixture stopped before any fake request because it incorrectly required the official `skill` tool in the global registry. Inspection of the published `dsh-web-app/cordis.patch.yml` confirmed that Desktop disables the host loader and mounts it through each Agent preset. The corrected fixture records that global observation, then mounts the official loader in the isolated Agent's scope; it does not inspect or modify user Agents.

On 2026-10-22 (Asia/Hong_Kong), the App Host ran the corrected internal bundle against the installed production import. The observed `lib/index.js` SHA-256 was `84b59328eabd731c414f8e5b8ed2e86d67a4bca5ff712dc4c8608d28205881a4`; four request-spine dependencies resolved to rc.2. In a new isolated Context, all three fake requests excluded historical catalogs, search found the newest of 1,477 skills and the official scoped loader returned its body. Original fixture events remained intact. No real provider call or user Session write occurred. The temporary bundle was removed through the official CLI, and both production packages plus unrelated dependency manifests/profile configuration were rechecked.

## Limits and remaining confirmation

The isolated flush listener counts callbacks; it is not the installed filesystem backend. Seed replay and an isolated App Host check do not prove a real user's disk-backend restart or a future real-model request fits its window. Loaded skill bodies, arbitrary system prompts, documents and tool outputs remain outside this repair's compression scope. Installation does not replay the old failed request or proactively rewrite stored conversations: catalog retirement happens on the next ordinarily authorized native admission.

Manual installed-plugin-list confirmation is pending. No Send, connection test, live Web/Insight request or real model acceptance was run.
