# GenesisPod governance profile

This profile is an extracted adapter for `/Users/sihaoli/Projects/GenesisPod`; it does not make GenesisPod rules universal.

## Authority and routing

- Primary AI instructions: `.claude/CLAUDE.md`
- Detailed standards: `.claude/standards/*.md`
- Role workflows: `.claude/agents/*.md`
- Task commands: `.claude/commands/*.md`
- Executable entry points: root/backend/frontend `package.json`, `.husky/*`, `.github/workflows/*.yml`, and architecture specs
- Portable Harness: `.agent-governance/profile.json` plus the digest-checked `tools/agent-development-governance/` bundle
- Dependency direction: `L4 -> L3 -> L2.5 -> L2 -> L1`
- AI applications must use the declared facades and registries instead of internal imports.
- Frontend work must reuse canonical components and design tokens before adding feature-local UI primitives.

## Scope mapping

| Scope      | Representative paths                                                   | Required control families                                                               |
| ---------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| backend    | `backend/**`, Prisma                                                   | lint, type, full coverage tests, architecture, build/boot, capability and script audits |
| frontend   | `frontend/**`                                                          | lint, type, coverage tests, build, UI/i18n/mission audits                               |
| governance | `.claude/**`, `.github/**`, `.husky/**`, scripts and package manifests | both product scopes plus governance wiring audit                                        |
| docs       | `docs/**`, Markdown                                                    | changed-file formatting and instruction consistency                                     |

## Important limitations

- `verify:full` is not CI parity: it omits architecture, boot, UI discipline, capability index, facade, and secret scanning controls.
- `verify:changed` ignores untracked files and runs a reduced set without lint, architecture, UI, build, or CI-equivalent tests.
- Local hooks are bypassable and their executable mode must be checked. CI is the merge-control source of truth.
- `governance-contract` must run first and fail on bundle drift, non-executable required hooks, or missing CI wiring.
- Local full verification mirrors CI environment for Node heap, test secrets, boot smoke, and frontend build; formatting is strict for changed files so pre-existing debt cannot mask regressions.
- npm governance entrypoints store attestation through `--report @git`, so regular checkouts and linked worktrees remain isolated.
- Some rules in `.claude/CLAUDE.md` explicitly remain honor-only.
- The bundled profile runs deterministic local equivalents. Gitleaks, dependency audit, branch protection, hosted CI, and scheduled runtime smoke tests still need their own evidence.

Use `audit` to see current drift rather than assuming this note remains current.
