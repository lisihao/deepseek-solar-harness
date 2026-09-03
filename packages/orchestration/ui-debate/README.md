# UI Debate

English | [中文](README.zh.md)

This dual-face plugin exposes the provider-neutral Debate projection at the authenticated same-origin `/api/debates` endpoint and contributes a `Debate` action to `conversation.session.header.actions`.

GET without `run_id` lists bounded persistent runs. GET with `run_id` adds the selected run, public roster responsibilities, every round's bounded per-agent output summaries and Artifact references, claim ledger, preserved dissent, unresolved items, usage/cost accounting status, moderator synthesis, and a bounded cursor event page. POST accepts revision-fenced `approve`, `reject`, `pause`, `resume`, or `stop` controls only with the dedicated control header and an authorized loopback or paired remote-device identity.

Each role turn retains the requested operator/model separately from the actual late-bound route. When the Scheduler uses an explicit fallback, the browser shows the fallback reason, attempt, and bounded blocker code/message. A blocked role remains distinct from a failed role, and a settled role remains visible when another role blocks the round; long route identifiers are visually truncated with their complete value available through the accessible title.

The browser panel uses the shared theme tokens but owns its styles and transport. This package depends only on the provider-neutral `ctx.debates` Service Definition and Host/client platform seams; it does not import the local Debate Provider, orchestration daemon, or physical-operator runtime.

## BBS-style panel

The selected Run is rendered as a forum thread:

- Opening the panel starts from the newest Run; an inspected response is rendered only when it matches the selected Run, so an earlier response cannot show a stale topic after a new selection.
- The topic post is followed by an always-visible semantic roster table with localized role, public responsibility, friendly operator/model names, and current state. Internal role and slot identifiers stay out of the normal browser view.
- Each round is a separate section and every terminal role turn, including the decision judge, is an independent, globally numbered floor; planned and dispatched turns remain roster status rather than empty posts. Later-round turns identify the claim-ledger phase; submitted claims are individual list items, but the UI does not claim a reply relationship that the v1 protocol does not record.
- Durable public output previews and moderator synthesis render through the shared safe Markdown renderer. Headings, lists, quotes, tables, and priority markers remain structured; raw HTML is never executed or displayed as a layout primitive.
- Friendly route, fallback, artifact, usage, and timing data remain available under collapsed execution details. Unresolved claims, preserved dissent, and separate Run, Round, and convergence states keep a budget limit from being presented as a contradictory active or stopped state.
- Replayed copies of the same durable error event are collapsed by sequence, attempt, node, and message. Distinct attempts or messages remain separate even when the error code matches. Missing output stays explicitly missing; the panel does not manufacture text for a role that never produced it.

## Model Experience

### Browser-only `/api/debates` projection

#### What the model sees

Nothing. The `/api/debates` surface is a browser and authenticated Host projection only; it contributes no model tool, prompt section, or execution instruction.

#### Token effect

None. Bounded previews are transferred to the browser and are not appended to model context by this package.

#### KV Cache effect

None. Browser refreshes and control requests do not alter a model prompt or cache prefix.

## Known Limitations and Deferred Work

- The panel cannot start model execution without an installed Debate Consumer and Provider.
- Remote controls depend on the Host's loopback or paired-device authorization; this package does not own authentication.
- The UI presents explicit bounded output summaries and Artifact references, not private reasoning, complete model transcripts, or large synthesis documents.
