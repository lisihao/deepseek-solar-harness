# Desktop product inputs

This directory contains immutable release inputs that are installed into the Desktop application dependency tree or exposed as a system-trust agent preset.

- Resident Physical Operator tarballs are built from the tracked packages mapped in `manifest.json`. They qualify subscription authentication per execution mode, isolate concurrent native work by caller-owned lane, migrate historical state into the compatibility lane, carry bounded task labels into durable receipts, and keep client disconnects from interrupting native turns.
- Persistent TaskGraph orchestration tarballs are built from the tracked packages mapped in `manifest.json`. They retain Intent, Context, Capsule, Graph and execution contracts as separate capability seams, inject a clean-task Capsule and fresh Resident lane per Attempt, expose Codex and Claude Code per-node routing, persist scheduler wait reasons, and keep the local daemon as their only state writer.
- AgentTeams is built from `lisihao/dsh-agent-teams` commit `ff3369241dbf9763e34e11292823d5d78a9d8713`; Desktop forces `memberPersonaPlacement: prompt` so the worker inherits its selected preset persona.
- Anchored Standard is the accepted eight-file snapshot whose promotion trackers pass `includeSubagents: true`, keeping delegated workers on the same two-tool first turn as their captain.
- Remote Web UI is built from `lisihao/dsh-web-ui` commit `7b99d9eb69202199fffe378b289425b224691d23` and restores a visible expanded-sidebar entry.
- Billing is built from `lisihao/dsh-web-billing` commit `5b3974f386fc744f7d099f85273c3136636e9026`, keeps cumulative usage visible in the sidebar without crowding composer controls, and separates local DSH usage estimates from the official DeepSeek balance.
- Luna Vision Bridge is built from this monorepo's managed source at commit `363c8915bd2acaed6e311cb960de2e574b5ff918`; version `0.1.3` runs subscription-authenticated vision turns without the surrounding Codex developer harness and makes successful settings writes visible.
- Configurable Remote Web Modules ships without private targets. Users keep their page names, URLs, and relay ports in the local DSH profile settings.

`manifest.json` is the authority for every vendored byte and maps every Desktop tarball to its tracked package source in this monorepo. `yarn verify:vendor` rejects missing, extra, or changed files, mismatched source package names or versions, untracked source manifests, and an Anchored Standard snapshot that drops the delegated-worker gate. The tarballs remain out of the packaged `.app`; Electron Builder packages their installed modules instead.
