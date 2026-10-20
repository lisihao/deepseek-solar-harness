# Model handoff

An independent Solar plugin for official DeepSeek Harness `0.2.1-rc.2`. A provider/model switch arms a gate before the target model's next request. GPT-6 luna prepares a structured session summary and two or three clarification questions; the user answers, reviews the exact handoff, and confirms before the old conversation surface is replaced by a native compaction checkpoint. The original event log is retained.

## Configuration

The bundle adds one Host row, `solar-model-handoff`. Its validated fields are:

| Field | Default | Meaning |
|---|---|---|
| `summaryProvider` | `openai-codex` | Existing registered provider; no account or authentication changes. |
| `summaryModel` | `gpt-6-luna` | Exact provider-owned model ID; absence is an error, never a fallback. |
| `maxInputBytes` | `1500000` | Maximum complete serialized source bytes; no tail truncation. |
| `maxOutputTokens` | `8192` | Requested summary output cap; its reasoning accounting follows the selected provider. |
| `maxHandoffBytes` | `48000` | Maximum confirmed checkpoint bytes; answers are not truncated. |
| `maxSummaryCalls` | `8` | Maximum logical summary calls, including final reduction; bounded 1–32. |

Luna is called once when the complete history fits. Longer histories are packed at tool-pair-balanced boundaries and reduced with one additional final call. If one balanced unit is too large, its records are serialized into contiguous Unicode-safe text fragments. Every fragment retains its record role, source kind, position and integrity metadata; tool results also retain their call ID and error flag when present. These are quoted historical material, not orphan native tool messages. The final reduction receives deterministic attribution alongside each draft. No original content is truncated.

The UI first asks approval of the complete chunk count and output caps. Exceeding `maxInputBytes`, `maxSummaryCalls`, final merge capacity or the minimum fragment-envelope size fails before any Luna stream starts. A later provider/output failure can still consume completed calls; no automatic extra attempt is made. Waiting and merging human answers make no model call. The actual provider context window is required; a conservative text-byte admission bound plus output reservation and framing headroom must fit. This is not an exact tokenizer count. Images, attachments and unsupported rich content are refused rather than misrepresented as read.

## Use and recovery

Use the existing model picker. If the Session is idle, the handoff starts after its canonical selection event. If work is running, the gate waits until the next request for a changed route. Same-route and effort-only changes do not trigger a summary. Initial model choice without a previous routed request does not need a handoff.

The plugin uses native question cards. Answer the two or three questions, then confirm the preview. A custom answer to the preview is treated as a complete replacement summary and must be confirmed in the next preview. Choosing cancel prevents the target request; selecting the original route permits continuing there.

`/handoff status` shows the current phase without a model call. `/handoff retry` explicitly permits one new summary attempt; it does not itself run it. An interrupted or unknown Luna request is never automatically repeated. After a lost Client connection, a stored completed draft/answer may be offered again when the changed route is next requested. Unsubmitted question draft text has the standard Client's own persistence limits.

## Data and composition

Private versioned receipts live under `$DSH_HOME/solar/model-handoff/`, one hashed current filename per Session and retained attempt identities under `receipts/`, with owner-only files and atomic replacement. They contain complete summary requests, output and human answers and must not be published. Canonical model-visible content is also recorded by the native `compaction/start`, `compaction/summary`, replacement `user/message`, and `compaction/end` transaction. Full original append-origin messages, including history shadowed by previous compactions, and prior summary checkpoints (which retain earlier human clarifications) feed the summary; hidden reasoning and adapter-private replay state are excluded. Tool errors, pairing and historical schema references remain explicit. Existing prompt/tools/runtime envelope and a newly submitted prompt remain outside the replaced historical range.

The plugin loads a manual `CompactionEngine` implementation in a public Cordis `compaction` isolation realm. The official preset's automatic backend remains unchanged. Both engines honor the native Session compaction lock. A short handoff may grow the history; preview estimates disclose this instead of applying the ordinary pressure backend's shrink-only rule after charging for a summary. It uses public Session Query reads and `SessionStore.flush`, not deprecated synchronous Session reads, private provider methods, DOM interception, or upstream patches.

The native summary record uses an unmarked, versioned backend trace in `compaction/summary.rawOutput`, with each exact request, raw output, call identity, finish and reported usage. One-call summaries also carry that request's reported usage at the usual top level. Multi-call summaries do not pretend to be one native LLM call or attach a fabricated aggregate usage. The installed cost meter does not automatically expand this custom multi-call trace; log-rebuilt aggregate counters may omit that usage. Read the individual trace/receipts for it. Missing usage remains unknown; API estimates do not establish subscription quota consumption or net savings.

## Verification boundary

Development checks use fake providers and scratch homes. Build, strict types, unit/runtime tests, built-package profile tests, and installed-App checks are reported separately in the task receipt. A fake-provider pass does not establish real Luna availability, semantic summary quality, or net token savings. Real model evaluation requires cost authorization. Installation does not rebuild or modify the official App.
