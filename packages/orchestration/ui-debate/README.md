# UI Debate

English | [中文](README.zh.md)

This dual-face plugin exposes the provider-neutral Debate projection at the authenticated same-origin `/api/debates` endpoint and contributes a `Debate` action to `conversation.session.header.actions`.

GET without `run_id` lists bounded persistent runs. GET with `run_id` adds the selected run, public roster responsibilities, every round's bounded per-agent output summaries and Artifact references, claim ledger, preserved dissent, unresolved items, usage/cost accounting status, moderator synthesis, and a bounded cursor event page. POST accepts revision-fenced `approve`, `reject`, `pause`, `resume`, or `stop` controls only with the dedicated control header and an authorized loopback or paired remote-device identity.

The browser panel uses the shared theme tokens but owns its styles and transport. This package depends only on the provider-neutral `ctx.debates` Service Definition and Host/client platform seams; it does not import the local Debate Provider, orchestration daemon, or physical-operator runtime.

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
