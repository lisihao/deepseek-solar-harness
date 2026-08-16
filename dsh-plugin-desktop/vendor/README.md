# Desktop product inputs

This directory contains immutable release inputs that are installed into the Desktop application dependency tree or exposed as a system-trust agent preset.

- Resident Physical Operator tarballs are built from `lisihao/deepseek-solar-harness` commit `23722c1b749b37d7aaf5e65f9bf309e446eea296`.
- AgentTeams is built from `lisihao/dsh-agent-teams` commit `ff3369241dbf9763e34e11292823d5d78a9d8713`; Desktop forces `memberPersonaPlacement: prompt` so the worker inherits its selected preset persona.
- Anchored Standard is the accepted eight-file snapshot whose promotion trackers pass `includeSubagents: true`, keeping delegated workers on the same two-tool first turn as their captain.
- Remote Web UI is built from `lisihao/dsh-web-ui` commit `7b99d9eb69202199fffe378b289425b224691d23` and restores a visible expanded-sidebar entry.
- Billing is built from `lisihao/dsh-web-billing` commit `6dd40db4ae8c4e723aaa4f2277c677484a2adc49`, keeps cumulative usage visible in blank sessions, and separates local DSH usage estimates from the official DeepSeek balance.
- Luna Vision Bridge is built from `lisihao/dsh-luna-vision-bridge` commit `238b4a4e3c80d069a3bbbd32cb0e4f2a93503e4c` and keeps generated bridge model IDs aligned with downstream provider/model changes.

`manifest.json` is the authority for every vendored byte. `yarn verify:vendor` rejects missing, extra, or changed files and rejects an Anchored Standard snapshot that drops the delegated-worker gate. The tarballs remain out of the packaged `.app`; Electron Builder packages their installed modules instead.
