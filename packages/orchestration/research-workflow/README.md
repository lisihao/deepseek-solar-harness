# @deepseek-ai/dsh-research-workflow

English | [中文](README.zh.md)

This private host-only Consumer associates a live Agent, its actual Session and a single research run. ResearchWorkflowHosts mints a scoped control through the existing [research Service Definition](../research-handoff/README.md); the local Provider remains the sole external-action owner. Saved IDs cannot restore callable authority.

## Complete input and action records

ResearchSessionActions copies a request before its first asynchronous wait. The required-on-read research/input event retains that complete request and, when selected, its full original prompt template, values and rendered text. Direct Host text remains explicitly represented by a null preparedPrompt. The event records Consumer intent, not submission or acceptance.

Execution requires a successful SessionStore durability flush with at least one listener, followed by a check that the same Session remains live in that store. A listener's success relies on that persistence Provider's guarantees; the adapter does not independently inspect disk during ordinary execution. Missing listeners, flush rejection and detachment prevent the Host call. The existing Host still owns unknown intent, current confirmation, original targets and physical deduplication.

The research/action event projects only retained Host facts: the original complete snapshot, qualification or null, and all observations of that exact action. sync reads those records without external activity; observe asks only about the original resource. A post-execution log failure propagates without automatic resubmission. An explicit retry keeps the original action ID and the Host's existing deduplication; it can append another input intention without implying another physical attempt.

## Current live Host ownership

ResearchWorkflowHosts checks agent.session, the exact AgentRegistry entry, the exact SessionStore entry and its current object-keyed registration. Only the invoking Agent object selects a registration; another object with the same ID cannot select it. An existing canonical workflow must belong to that Session. Replacement and disposal abort local access; an old disposer cannot remove a later registration.

The same Provider grant carries the trusted live-owner callback through retained reads and existing Driver, source Reader and collector guards. A relationship changed during an asynchronous wait therefore prevents a fresh external operation when its guard runs. Trusted run callbacks must call their guard after internal waits; the outer operation also rechecks before returning. Already admitted late acceptance or output is preserved by the original SQLite owner, then the revoked workflow Host refuses advancement. This is same-process ownership checking, not independent verification of an arbitrary remote Agent.

## Workflow records

Action projection also retains the original Host delivery history, including external identity, complete or partial read-back text and Provider-computed content status. Missing delivery remains an empty history. sync does not observe a website or convert a later match into resolution of an earlier mismatch.

The live Host can pass a trusted synchronous request check through ResearchSessionActions to the original Provider. It combines that check with current Agent/Session ownership and retains complete input logging. The callable check is not serialized or reconstructed from input data. previewGuard includes the Provider's stage-specific prerequisites; complete command registration remains unfinished.

The embedding command Host supplies the actual invocation Agent and source to confirmRunFromCommand or confirmPreviewFromCommand. Only source.kind=user and that exact currently registered live Agent/Session can confirm; the Provider also requires its human input channel. Saved by=human fields and preview identifiers cannot restore this callable route. This is trusted same-process routing, not independent proof of human presence. treatDeliveryFromCommand uses the same actual user-source and live-registration route for exact mismatch treatment. previewGuard rechecks the frozen request and its previous-stage delivery basis after asynchronous waits. Complete command/UI registration, the report verification editor and Loader application snapshots remain unfinished.

ResearchWorkflowCoordinator retains the canonical definition in the required-on-read research/workflow event, with payload version 1, before standard execution. research/workflow-update retains the complete current original-owner snapshot, including full report text, previews, confirmation attribution, original actions, delivery history and separate verification state. Successful persistence and the same live Agent/Session are required before external work or a successful state return. Event payload version 1 does not change SESSION_FORMAT_VERSION or the private SQLite schema.

The coordinator constructs original-template messages and the full Gemini report attachment under the fixed four stage identities. Previewing revises only a changed binding; the trusted user entry separately confirms the exact run and preview before freeze and execution. Repeated execution reads the original action; concurrent duplicates share the pending original operation. Explicit observe reads only a correlated original resource and collects completed stage output; no-resource unknown only syncs retained facts. Collection is automatic after a completed data-producing action, but the next stage still requires its own explicit confirmation. A late revoked result stays with the original Provider and does not authorize advancement.

Coordinator operations and scoped asynchronous Host calls accept an optional per-call cancellation signal. It is combined with registration revocation for that operation, without revoking the long-lived Host. Internal persistence waits and submission checks observe cancellation before fresh work; already admitted late facts remain with the original Provider, without automatic collection or further progression. A duplicate waiter's cancellation affects only its wait. After the original operation settles, a later explicit call may use the same stable ID when no action was recorded; recorded unknown or accepted actions are only read or explicitly observed.

The AndSync human-entry methods retain the complete resulting workflow event before returning confirmation or treatment success. syncReceipt returns the exact event sequence appended and successfully flushed by that call, so concurrent consumers need not select the last Session event. A failed return flush does not erase accepted actions, outputs or human decisions; explicit sync recovers those facts without submitting again. The event invariant checks actual Session/run/stage relationships and rejects inconsistent completion projections before append.

## Model Experience

### Retained research records

#### What the model sees

The `ResearchSessionActions` Consumer logs original inputs and prepared templates but registers no model tool or prompt section. Direct Host text remains distinguishable.

#### Token effect

Full supplied inputs increase Session storage; this package does not reduce actual model requests or claim token savings.

#### KV Cache effect

This Consumer does not modify model request prefixes or claim KV-cache savings.

## Known Limitations and Deferred Work

- This adapter does not enforce Session logging for callers of the raw Host API. The standard coordinator builds and executes the four fixed stages with independent human confirmation. Website Drivers, human command/UI registration, the report verification editor and source/built Loader application verification remain separate work. Local input retention does not prove website receipt, model understanding, factual truth or research completion.
