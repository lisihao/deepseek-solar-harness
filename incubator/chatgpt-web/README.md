# ChatGPT Web operator

Unreleased V4 candidate: `@lisihao/dsh-solar-chatgpt-web`. It uses the official Harness unchanged and the separately installed Ego Lite browser. It does not use the Codex subscription API, native Codex, or Claude Code. It is a single text-task operator, not the later Gemini/ChatGPT research workflow.

## User paths

- Open **ChatGPT 网页算子** in a conversation or Settings. Enter a text request, optionally the exact displayed model and reasoning-effort labels, then use the explicitly quota-labelled submit button. Loading and refreshing the panel do not submit requests.
- The public `chatgpt-web` subagent provider accepts text-only tasks. It does not inherit the parent conversation, DSH tools, files, or main-model route.
- `solar_chatgpt_web` exposes explicit run/read/observe/cancel operations. A run uses a stable command identity. Observing an unresolved run never resubmits its prompt.

A task needs an available Ego Lite CLI, an agent-owned TaskSpace and a logged-in, empty ChatGPT conversation. A login prompt, user takeover, an existing draft/attachment/conversation, an unknown model, or an unavailable requested label stops execution. No API fallback or automatic retry is provided. The browser is external: plugin installation does not download it or copy a login. The adapter targets the locally inspected public v2 API with CLI `0.5.1.13`; other CLI/website versions have not been accepted.

Model and effort labels are distinct. When present, the page’s `data-selected-reasoning-effort` is retained as its raw effort identifier (for example `medium`), not a translated display label. A website label such as `GPT-6` is recorded verbatim; it is not renamed `GPT-6 Astra`. Empty preferences mean the actual observed webpage selection, not a promised model. Exact requested labels must match the observed page before submission; unsupported selection UI is a named failure, not permission to substitute another model.

## Configuration

Profile fields: `executablePath` (absolute Ego CLI path; default `~/.local/bin/ego-browser` resolved to the current home), `taskSpaceId` (default 0: create one space for the new request; a positive configured id resumes that exact already agent-owned space without claiming control), `commandTimeoutMs` (default 25000), `runTimeoutMs` (default 300000), `pollMs` (default 2000), `maxOutputBytes` (default 1048576), `modelLabel`, and `effortLabel` (both default empty). Bounds are validated by the plugin configuration. These are local execution defaults, not provider latency or model-capability claims.

## Persistence and stopping

Records live only in `$DSH_HOME/solar/chatgpt-web/`, format version 1. They contain the complete text request, requested/observed labels, original TaskSpace/page/conversation identity, revisions, result and named errors. They may contain private task data; do not publish or commit this directory. Legacy V3 data is not imported.

The controller persists the intent before any browser creation and records `submission-unknown` before the single send attempt. Losing the receipt fences further submissions. Read-only reconciliation addresses only that original resource. Stopping the local wait or killing its CLI does not prove that ChatGPT stopped generating. Unknown/partial outcomes remain explicit. Complete visible Markdown is retained within the configured byte bound; overflow is reported rather than silently clipped. This is visible page output, not hidden reasoning or a complete internal provider trace.

## Verification

The controller, process transport, DOM observer, durable store, public bindings and built UI have focused keyless regression tests. The actual published rc.2 CLI installed the built package into a disposable home, observed its tool/provider and empty status, then verified their removal on disposal. No browser or model task was started by that probe.

Real Ego preparation verified exact `GPT-5.6 Sol` / `GPT-6` selection and `medium` / `high` effort selection, restoring `GPT-6 / medium` on the same empty page. No message was sent. Menu animation, simple/advanced transitions, hidden controls and stdin/stderr framing are handled from these observed controls. These checks do not prove answer submission or extraction. See [the verification record](../../docs/chatgpt-web-verification.md) for the current gate, installation and live-request status. 

The identified installed candidate passed one synthetic text-only GUI request at `GPT-6 / medium`, including recovery through **读取最新状态** after the first receipt was uncertain. The complete answer was retained and displayed. Normal/narrow conversation layout, the Settings entry and read-only refresh passed. This run required explicit reconciliation; it does not prove unattended completion or arbitrary workloads. No second request was sent.
