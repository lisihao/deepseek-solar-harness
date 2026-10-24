# Solar memory context

`@lisihao/dsh-solar-memory-context` is a private preview bundle. Its Graph
Memory phase projects automatic Graph Memory recall into a bounded request
view, and retires accumulated earlier automatic snapshots from the model
surface. It uses published DeepSeek Harness `0.2.1-rc.2` Agent and Session
surfaces; it does not patch the official App, Graph Memory database, or the
Graph Memory package.

The second phase also shortens the verified Hindsight 0.8.1 resident tool
guide. Each producer has a separate exact source contract; a similar-looking
user quote never identifies an automatic memory contribution.

## Graph Memory boundary

The adapter recognizes an automatic producer message only when all of these
conditions hold:

1. Its source is exactly `kind: "plugin:graph-memory"` and `form: "snapshot"`.
2. It is a user-role message with one text block.
3. Its one documented `graph-memory:recall` source section has exactly the
   same text as that block.

The text is parsed with `saxes` as the documented
`memory_capsules`, `navigation_graph`, `knowledge_graph`, and
`episodic_context` sections. It is not parsed with a general XML regular
expression. A source with an unsupported shape stops admission with
`MEMORY_CONTEXT_SNAPSHOT_UNSUPPORTED`; it does not create guessed facts or
partially retire earlier records.

Text supplied directly by a person remains a `kind: "user"` message. A user
quote containing `<memory_capsules>` is not an automatic snapshot and is not
removed or filtered by this adapter.

## Request lifecycle

In rc.2, the accepted `agent/pre-step` batch is not committed before
`agent/request`. Therefore the current Graph Memory contribution is handled
at Agent scope after downstream pre-step listeners return, before that batch
is admitted. The compact current view keeps the original
`plugin:graph-memory` source/form and adds a logged `solarMemoryContext`
object containing the format version, policy version, owning turn, source
snapshot count, and selected-fact count.

The adapter schedules its own Agent-scoped listener after synchronous
`agent/created` callbacks. This is intentionally limited to the tested rc.2
Agent startup path: it is not a general guarantee for arbitrary producers
that register asynchronously after an Agent has begun work.

At `agent/request`, old already-durable Graph Memory snapshots are replaced
one surface node at a time by empty official `developer/message` retirement
records. Each replacement cites its exact original event through
`sourceEventSeqs`. The original event log entries remain unchanged; Graph
Memory's DB, assistant tools, tool declarations, and non-memory conversation
events are not deleted or rewritten.

Replacements are flushed before the request reaches an adapter. A false or
throwing flush raises `MEMORY_CONTEXT_FLUSH_FAILED` and prevents that request.
The pending barrier retries the real Session flush on a later request. An
abort before admission appends nothing. A view already committed for the same
turn suppresses another current snapshot on later steps; an aborted pre-step
proposal does not count as a committed view, so a same-turn retry can project
the new recall again.

## Selection policy

The policy is deterministic and lexical. It normalizes Unicode, matches
Latin identifiers (including `BC-1024-OK`-style tokens), and makes 2–4 Han
character terms for Chinese text. Generic action words are ignored. This is
not semantic retrieval, translation, or a relevance guarantee.

- A matched capsule retains its complete matching navigation triples and exact
  source evidence; text is never cut mid-excerpt to satisfy a character
  budget.
- Exact-equal capsule bodies, triple bodies, and evidence bodies are
  deduplicated even when their producer IDs differ. Retained output records
  every original source ID/reference.
- A question that explicitly refers to earlier history but supplies no lexical
  anchor may retain the first bounded candidates in producer order.
- A self-contained literal reply instruction without a history reference adds
  no automatic recall.
- When ordinary lexical anchors exist but do not match, the adapter does not
  substitute a guessed fallback.

The two configuration fields are validated at load:

| Field | Default | Range | Meaning |
|---|---:|---:|---|
| `maxFacts` | 4 | 1–20 | Maximum selected top-level facts in one current view. |
| `historyFallbackFacts` | 2 | 1–min(8, `maxFacts`) | Maximum producer-order candidates for an explicit unanchored history reference. |

## Hindsight resident guide

Only `plugin:hindsight` / `recall` messages are considered. The adapter
recognizes eight exact output variants of the 0.8.1 knowledge/refresh guide,
normalizing only the reported page count. It replaces those known blocks
with one concise on-demand guide, preserving search/read/list/reflect,
initiative capture, document ingestion, correction, attribution and stale
evidence guidance. Custom additions or unknown guide versions do not match
the fingerprint and remain intact. Factual recall outside the matched block,
explicit tool output and user messages remain unchanged.

The saved request contained both the full guide and its refresh: 8,270 UTF-8
bytes of repeated guide blocks inside an 8,316-byte message. The `<page>`
strings there are citation placeholders; those blocks contain no actual
knowledge-page bodies. No Hindsight setting, database or tool is disabled.

Historical known guides are projected through official Session replacements;
factual text around them stays in place. Keep the latest committed guide
until a newer guide is itself committed, so an aborted pre-step proposal
cannot remove the only resident guidance. A refresh may therefore overlap
one previous compact guide on its first request; the next request retires
the older copy. Unknown Solar projection versions stop with
`MEMORY_CONTEXT_PROJECTION_UNSUPPORTED`. Hindsight replacements use the same
flush-before-request admission rule as Graph replacements.

## Data and permissions

The Graph Memory phase creates no private database, calls no model or
embedding endpoint, and registers no new model-visible business tool. Its
only durable output is an ordinary official Session message with a
schema-versioned source. It adds no plugin-defined Session event, so it does
not introduce a new session-format migration dependency.

## Verification boundary

The following Graph-specific checks were run while this phase was implemented:

- 18 focused Graph Vitest cases covered Chinese, English, and identifier matching;
  duplicate bodies with different IDs; literal replies; user marker text;
  same-turn continuation; Session reload; flush failure/retry; abort; and
  preserved raw log prefixes.
  Negated references such as “do not continue the previous task” do not count
  as a request to recall it. A separate clause that explicitly asks about a
  previous fact remains eligible; the rule is bounded by visible clause
  punctuation rather than arbitrary following text.
- TypeScript typecheck and a built `lib/` bundle completed locally.
- A disposable official-CLI profile probe used a fake local adapter only. Its
  baseline second request contained two raw Graph Memory snapshots. In both
  Graph-first and Solar-first bundle orders, including an immediate
  `agent/created` follow-up, the integrated second request contained only the
  current projected view, one source-citing historical retirement, and the
  same tool declarations. No provider or model request was allowed.
- A read-only private shape smoke test removed the outbound ACP envelope from
  five saved real producer bodies and passed the resulting bodies through the
  built pure projector. For the literal `BC-1024-OK` question all five parsed
  successfully and selected zero facts. The private text was neither printed
  nor committed.
- 17 Hindsight cases covered all eight generated known-guide variants,
  unknown/custom instructions, preserved facts, exact source identity,
  original logs, source event references, reload, abort and failed flush.
  The fixtures are pure producer outputs with synthetic page IDs, not
  personal memories or copied producer implementations.

After integration, all 35 cases, build/declarations, strict types and the
official-CLI baseline plus both activation orders passed. The CLI fixture
also retains synthetic Hindsight factual recall and the same tool declarations
while replacing the full resident guide. Root-workspace build/types and
homepage/curated installer checks passed; generated homepage content did not
change because this is an unreleased preview.

A copied real Session replay using the full literal-reply instruction retired
all five automatic Graph snapshots and preserved its six existing archive
markers. The Graph text changed from 56,139 to 955 UTF-8 bytes; the Hindsight
text changed from 8,272 to 1,198 bytes. The original event prefix and all
non-target message hashes were unchanged. An `o200k_base` reference tokenizer
counted these two groups as 17,966 tokens before and 419 after; those are
message-body reference counts, not final wire size, actual model tokens,
billing, or a live effectiveness measurement.

These checks do not prove installed Desktop behavior, persistence across a
real on-disk restart, or semantic recall quality. Installation acceptance,
actual App inspection, release, publication, and a real provider request were
not run.
