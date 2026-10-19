# headless-agent

English | [中文](README.zh.md)

This directory owns the replay and real-model test composition for a headless coding agent: DeepSeek V4 + local bash and filesystem tools + subagent delegation + workflows and fresh-agent Ralph iteration + `todo_write` + JSONL persistence. It explicitly mounts the shared agent spine, one root agent, persistence, and checkpoint policy; it is not a second product entry point.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm dsh --profile headless "fix the failing test in this workspace"
```

The product command is [`dsh --profile headless`](../../apps/cli/README.md): it accepts one nonblank task, creates and persists a fresh session, prints the final assistant text, and exits.

Snapshot suites run this directory's configuration through [`tests/fixtures/headless-driver.ts`](tests/fixtures/headless-driver.ts), an unexported test-only process that emits canonical session events as JSONL before its result record. That stream is test infrastructure, not a supported CLI output format. Child sessions surface only through parent tool events and results.

## E2B POC overlay

[`e2b.cordis.yml`](e2b.cordis.yml) replaces the local filesystem and subprocess providers with one shared E2B sandbox while retaining `dsh-bash-local` and the same model-facing tools. Put `E2B_API_KEY` beside `DEEPSEEK_API_KEY` in the gitignored root `.env`, then run the credential-gated live composition, which drives FS, Bash, PTY, and LSP in one sandbox and proves final deletion:

```sh
pnpm exec vitest run --config vitest.e2e.config.ts packages/e2b/e2b/tests/composition.e2e.ts
```

The overlay creates the same absolute cwd inside the sandbox, but it does not upload or mount the host workspace. File and Bash mutations exist only in E2B; Cordis, model calls, agent/session state, session logs, skills, and SDK buffers remain on the host. The composition kills its sandbox on timeout and disposal. It is a provider-composition POC, not a whole-harness migration or a workspace-sync feature.

## Advanced configuration

[`advanced.cordis.yml`](advanced.cordis.yml) adds Code Mode and the Cordis tools to the test composition.

## Keyless standalone RLM

[`standalone-rlm.cordis.yml`](standalone-rlm.cordis.yml) composes an explicitly owned root with the standalone RLM Provider and the existing execution owner. Its API and Codex snapshot scenarios replace only the external transports; they exercise the real Loader, tool, daemon, and RLM core without credentials. Run `pnpm run test:snapshot -- examples/headless-agent/tests/standalone-rlm.snapshot.ts`; after the host build, set `DSH_EXAMPLE_MODE=lib` to check built package exports under plain Node. This fixture is not a general CLI or Desktop Host integration.

## Local HTTP admission

[`http-admission.cordis.yml`](http-admission.cordis.yml) connects the real Loader, Worker, Runtime, DeepSeek adapter and shared evaluation ledger to a loopback HTTP server with synthetic authentication and responses. Run `pnpm run test:snapshot -- examples/headless-agent/tests/http-admission.snapshot.ts`; after the host build, set `DSH_EXAMPLE_MODE=lib` to check built exports under plain Node. The server records every arrival independently, and the fixture matches request-body hashes and observer events to ledger attempts across root, child and tool rounds. The parent reads the complete child result before its next request; concurrency remains one.

Unproven input bounds refuse before any HTTP arrival. A connection lost after arrival stays durably unknown without a hidden retry and holds the concurrency-one slot; a separate concurrency-two diagnostic proves a later independent success does not erase that unknown. Mutated body associations, unclassified arrivals and missing unknown events must fail validation. The byte-based synthetic scope does not establish real provider token bounds, operating-system isolation or paid-run readiness; this composition makes no external model requests.
