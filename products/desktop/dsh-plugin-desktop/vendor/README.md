# Desktop product inputs

This directory contains immutable release inputs that are installed into the Desktop application dependency tree or exposed as a system-trust agent preset.

- Resident Physical Operator tarballs are built from `lisihao/deepseek-solar-harness` commit `c7f2d2b892f5bd40a88d632d2c3b474776266262`. This revision qualifies subscription authentication per execution mode, carries a sanitized display-only task label into durable receipts, preserves deterministic Resident routing and keeps client disconnects from interrupting native turns.
- AgentTeams is built from `lisihao/dsh-agent-teams` commit `ff3369241dbf9763e34e11292823d5d78a9d8713`; Desktop forces `memberPersonaPlacement: prompt` so the worker inherits its selected preset persona.
- Anchored Standard is the accepted eight-file snapshot whose promotion trackers pass `includeSubagents: true`, keeping delegated workers on the same two-tool first turn as their captain.
- Remote Web UI is built from `lisihao/dsh-web-ui` commit `7b99d9eb69202199fffe378b289425b224691d23` and restores a visible expanded-sidebar entry.
- Billing is built from `lisihao/dsh-web-billing` commit `5b3974f386fc744f7d099f85273c3136636e9026`, keeps cumulative usage visible in the sidebar without crowding composer controls, and separates local DSH usage estimates from the official DeepSeek balance.
- Luna Vision Bridge is built from `lisihao/dsh-luna-vision-bridge` commit `0173d93fab9f480d9a7548ac65cf04c3488fb8bb`; version `0.1.2` keeps generated bridge model IDs aligned and maps Electron ASAR launchers to their executable unpacked paths.

`manifest.json` is the authority for every vendored byte. `yarn verify:vendor` rejects missing, extra, or changed files and rejects an Anchored Standard snapshot that drops the delegated-worker gate. The tarballs remain out of the packaged `.app`; Electron Builder packages their installed modules instead.
