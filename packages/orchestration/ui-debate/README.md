# UI Debate

English | [中文](README.zh.md)

This dual-face plugin exposes the provider-neutral Debate projection at the authenticated same-origin `/api/debates` endpoint and contributes a `Debate` action to `conversation.session.header.actions`.

GET without `run_id` lists bounded persistent runs. GET with `run_id` adds the selected run, public roster responsibilities, every round's bounded per-agent output summaries and Artifact references, claim ledger, preserved dissent, unresolved items, usage/cost accounting status, moderator synthesis, and a bounded cursor event page. POST accepts revision-fenced `approve`, `reject`, `pause`, `resume`, or `stop` controls only with the dedicated control header and an authorized loopback or paired remote-device identity.

Each role turn retains the requested operator/model separately from the actual late-bound route. When the Scheduler uses an explicit fallback, the browser shows the fallback reason, attempt, and bounded blocker code/message. A blocked role remains distinct from a failed role, and a settled role remains visible when another role blocks the round; long route identifiers are visually truncated with their complete value available through the accessible title.

The browser panel uses the shared theme tokens but owns its styles and transport. This package depends only on the provider-neutral `ctx.debates` Service Definition and Host/client platform seams; it does not import the local Debate Provider, orchestration daemon, or physical-operator runtime.

## BBS-style panel

The selected Run is rendered as a forum thread:

- The topic post is shown first, followed by a full-width collapsible roster with localized role categories and the configured public persona title and mandate.
- Each round is a separate section and each terminal participant turn is an independent, globally numbered floor; planned and dispatched turns remain roster status rather than empty posts. Later-round turns identify the claim-ledger phase; submitted claims display their real statements, but the UI does not claim a reply relationship that the v1 protocol does not record.
- The visible card contains only the durable public output preview, status, and evidence count. Provider/model routing, fallback, attempt, artifact, usage, timestamps, and identifiers are available under collapsed technical details.
- The decision judge appears once as the pinned moderator synthesis rather than again as a discussion floor. Unresolved claims, preserved dissent, and convergence metrics remain separate sections so disagreement is not hidden by the final answer.
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
