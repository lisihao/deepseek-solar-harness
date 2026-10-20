# Model-switch handoff implementation

User authorization: design, develop, test, then install the standalone model-handoff plugin. It is independent of native-resident/native-collaboration and RLM. Official upstream remains read-only.

The approved design uses GPT-6 luna, two or three human clarification questions, a preview, and a confirmed native context checkpoint before a changed model receives its first request. The canonical implementation and configuration are in [the plugin README](../incubator/model-handoff/README.md).

## Public rc.2 seams

- `session/event` observes the durable `model/selection` emitted by `SessionController.selectModel()`; no method override is needed.
- `agent/request` awaits the resolved route before prompt admission and provider execution. A changed provider/model must await the handoff. Same model with a new reasoning effort keeps its ordinary behavior.
- `CompactionEngine` is the documented backend seam. An isolated manual-only implementation validates balanced boundaries, shares the standard durable lock, writes canonical summary/replacement events and uses `SessionStore.flush`. Short histories may grow after user confirmation; the original pressure backend retains its own policy.
- `ctx.userQuestions.ask({ agent, ... })` uses native live root-Agent cards without fabricated tool IDs. The plugin owns recovery receipts because these unnamed cards are not durable tool-question projections.
- `ctx.sessionQuery.readSession()` captures full original events, including shadowed message bodies, without deprecated Session methods.

## Explicit limitations

Text/tool history is fully covered within the configured input budget. Oversize single-request history is chunked at balanced tool boundaries and reduced, with the planned call count approved first. An oversized balanced unit uses ordered, attributed JSON-text record fragments with per-record SHA-256, byte offsets and exact UTF-8 envelope bounds. The final reduction retains programmatic attribution as well as model drafts. Unsupported modalities, an envelope too small for metadata and one character, an over-budget call plan or an oversized final reduction fail explicitly without truncation. Multi-call traces are retained canonically and privately, but the original cost meter does not automatically expand them into per-call aggregate usage. It must not be advertised as handling every arbitrarily large conversation or as producing a complete native billing aggregate.

The picker records the chosen target before the handoff finishes; the execution gate, rather than a pre-selection hook, prevents that target receiving old history. On cancellation the user can select the original model. No rollback of a durable compaction is implied. Repeated switch, cancellation, Client loss and crash recovery must preserve exact receipts and avoid automatically replaying unknown requests.

## Acceptance

Observe zero target model dispatches before clarification and explicit confirmation. The first accepted target request must contain the confirmed summary and exact answers, preserve its newly submitted user prompt, exclude the replaced bulk, and retain the original raw log. Check source and built Node modes, installation into a scratch profile, original compaction isolation, recovery/error paths, and actual App load. Report real-model coverage separately; no benchmark benefit follows merely from a passing integration test.

## Source verification (2026-10-19)

The stable local `pnpm check` passed build/declarations, strict TypeScript, 117 tests, a separate 13-test built runtime run, both official CLI scratch-profile plugin checks, and the generated homepage check. The model-handoff CLI probe installed built packages under plain Node and drove a real AgentLoop with fake providers. It observed no target call before the human-answer gate, then verified summary, exact answers and the new prompt in the target request, exclusion of the original bulk, and preservation of raw history and canonical request traces. Existing compaction remained isolated.

The runtime tests include rapid B→C selection, cancellation while receipt reading or final flushing is pending, confirmed-receipt recovery without another summary/checkpoint, earlier human answers in a later handoff, bounded multi-call reduction and malformed completed-response persistence. Independent source review findings were fixed before this final gate. The complete input manifest SHA-256 was `f9819e0f1cb2e9f90d1a28165e33dd438b73cc8870fbc0ae441557ab14bc70b0`; the local gate log SHA-256 was `9423c52e3cf8b8d64e4719f6456704aa803b7e24249436d6186a48d2731588f9`.

These are local source/integration results, not remote CI, installation, live-provider availability, semantic quality, or savings evidence. No paid call, upstream change, merge, release, market tag or index publication was performed by these checks.

## Oversized-history correction (2026-10-20)

A user test exposed `one balanced history unit exceeds maxBytes`: a single skill-catalog record exceeded one summary request's planning budget. The fix fragments oversized records without dropping their original JSON bytes, preserves message attribution in every fragment and the reduction input, and includes that metadata in the pre-call capacity calculation. A separate regression fixes model-selection events containing `reasoningEffort`: the persisted target now explicitly copies only provider and model, while the actual route keeps its effort.

The old implementation failed the new oversized-unit and effort-selection regressions. After the fix, `pnpm check` passed 121 source tests, a separate 15-test built runtime run, strict types, both keyless CLI profile probes and the homepage check. An additional actual-stream oversized-record regression then passed independently in source and built modes; its final request retained fragment attribution. Type checking passed again after that test was added. No real model was called.

The original failing sample was also reconstructed exactly in a private offline probe: 12 records, 1,027,384 serialized source bytes. At a synthetic 200,000-byte chunk budget the plan is seven map calls plus one reduction; at 100,000 bytes it exceeds the unchanged eight-call limit and remains refused. The original provider context window was not recorded, so these probes do not establish admission under that original live configuration. Raw session material is not part of this repository.
