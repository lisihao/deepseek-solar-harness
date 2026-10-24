# Memory context hygiene repair

Authorized on 2026-10-24: repair accumulating Graph Memory snapshots,
duplicate and irrelevant automatic recall, then shorten the Hindsight
resident knowledge preamble. Preserve complete capabilities and original
logs. Package/install only after keyless checks; no model calls.

## Observed boundary

The BC-1024-OK send-body SHA-256 was reconciled with the actual send ledger.
It contained five Graph Memory recall snapshots (including an exact duplicate),
one Hindsight knowledge/tool preamble, and no structured historical tool
results. Current installed producers are graph-memory 1.6.0-beta.17 and
@vectorize-io/hindsight-coding-agents 0.8.1. This repair consumes their normal
public message provenance; it does not copy their source or patch their runtime.

## Implementation contract

Deliver one independently removable Solar adapter under
`incubator/memory-context`, using only published rc.2 Agent/Session APIs.
No browser UI, database mutation, upstream fork, model/embedding request,
new model-visible business tool, or unrelated memory policy change.

1. On public `agent/pre-step`, project the current ephemeral Graph Memory
   contribution after its producer has returned. The rc.2 `agent/request`
   hook runs before the accepted user batch is logged; use that hook to retire
   already-persisted snapshots and flush the replacements. Do not assume the
   current pre-step contribution is already in the Session. Identify automatic
   snapshots by exact producer source and form, never by user text containing
   a matching marker alone.
2. Retire historical automatic snapshots from the model surface using official
   Session replacements, with `sourceEventSeqs` pointing to original events.
   Original events, Graph Memory DB, original source messages and tools remain.
3. Only recall contributed in the current turn is eligible as new context.
   On later steps of the same turn keep the same accepted view idempotently.
   When the producer emits no current recall, do not revive an older snapshot.
4. Parse the producer's documented capsule/navigation/evidence sections as
   structured data. Deduplicate exact capsule/evidence/triple bodies, including
   different IDs with equal content; preserve source references for retained
   facts. Never slice a source excerpt mid-text to satisfy a budget.
5. Filter automatic capsules against the current actual human question with a
   deterministic, multilingual lexical relevance policy (no model/embedding).
   Ignore generic action words. Exact identifiers/entities must remain usable.
   An explicit history reference with no lexical anchor may retain a small,
   bounded candidate set instead of guessing it is unrelated. A self-contained
   literal-answer instruction with no history reference needs no recall.
   Preserve and document the limits of lexical matching; do not claim semantic
   equivalence. Explicit user-supplied/quoted memories are never filtered.
6. Keep complete capsule/evidence bundles for accepted facts, bounded by the
   number of selected facts. Do not silently omit all memory capabilities or
   change provider/reasoning/tool permissions. Unsupported producer shapes
   have an explicit, test-covered outcome; do not invent parsed facts.
7. Use one schema-versioned Solar source for replacement views and compact
   retirement records, all in official event kinds. No plugin-defined session
   event. Flush replacements before request admission, including flush-failure
   recovery on the next request.
8. In the second repair step, replace only the verified automatic Hindsight
   knowledge preamble with concise guidance preserving tool discovery,
   historical-evidence limitations, and explicit user instructions. Do not
   remove factual recall, explicit knowledge tool results, or plugin tools.
   The observed 8,316-byte message contains a 4,343-byte knowledge guide and
   a 3,927-byte refresh guide. The two `<page>` strings are citation template
   placeholders, not knowledge-page bodies; both guides state that five pages
   exist and must be discovered with search. Preserve any unrecognized extra
   content rather than treating it as boilerplate.

## Acceptance

Negative controls must demonstrate old snapshot accumulation and unrelated /
duplicate recalls. Cover relevant Chinese/English questions, exact identifiers,
explicit references to prior work, arbitrary literal replies, current user text
with memory markers, continuation steps, reload, abort, and failed flush.
Use the saved real session only in ignored private fixtures; public tests are
synthetic and contain no private prompt, memory, account, or raw log content.
Built plain-Node official disposable CLI registration and public Session
projection tests must prove tools remain registered and original events remain.
Compare all relevant headers/tools unchanged before and after the adapter.

Installation is serialized with the independent Insight repair. Back up the
latest profile, locks and affected plugin data, quit the official App normally,
install stable verified tarballs with its bundled CLI, relaunch and verify
installed bytes/startup. Replay copied private events keylessly through the
installed pure helper to inspect the expected projection. No real model
effectiveness claim follows from keyless tests.

## Installed preview record — 2026-10-24

Runtime source `bbf2d9fa75056cc2636c71b46a77ecfab424ff6f` is recorded in
PR #314; its exact source CI `40119319969` succeeded. The stable preview archive
SHA-256 is `e67b3956ce683e0c55924691c9ac20d74557e4213a12208a57761ffb3ea41c56`.
All 20 installed files matched the archive. Installation used the official CLI
after normal App/Host exit, idle Resident inspection/normal shutdown and latest
profile/data backup. It preserved the existing Graph/Hindsight data, unrelated
plugins, configuration and original session logs before relaunch.

The source package passed 35 tests, build, strict types and the official CLI
baseline/Graph-first/Solar-first scratch checks with fake model behavior.
A private replay through the published Session surface retained original event
history and all non-target messages. The selected historical step's Graph and
Hindsight reference-token groups changed from 17,966 to 419 using `o200k_base`;
this is an offline reference measurement, not provider input usage or a live
saving. The actual no-tools marker removed five stale automatic Graph snapshots
from the effective surface; original archive markers remained.

Desktop was normally restarted. One existing header-only empty session file
changed after that restart; its current journal contains no message/request
history. The pre-relaunch byte check passed, but there was no retained prior
body copy for attributing that header rewrite. Do not claim every compressed
file stayed byte-identical after restart. Existing Solar JSON hashes were
unchanged and this installation made no model/browser submission.

Human confirmation of the enabled **Solar 记忆上下文** installed-list entry was
requested and is pending in this record. No new live efficacy test was run.
A later Grok installation retained this exact package as an unrelated dependency.
