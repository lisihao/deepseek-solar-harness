# @deepseek-ai/dsh-research-handoff

English | [中文](README.zh.md)

The private Service Definition separates current embedding-Host access, explicitly registered platform Drivers, and retained research data. The researchHandoff service does not grant model or generic RPC callers the ability to register Hosts. Trusted plugins in the same process share the embedding Host's trust domain.

## Current Host and exact actions

A Host registers explicit owner, workspace, source-configuration digests, destinations, Driver selections, judgment input channel, policy version, and full-input byte limit. Callable access expires with that registration. A saved owner ID, confirmation, digest, or imported policy cannot recreate it. Selection includes model, mode, requested effort, and tools; requested effort distinguishes required, not requested, and not applicable from an actual unobserved interface control.

Each action retains its full confirmation binding, original target, Driver, selection, complete input, and an explicit prepared-prompt identity or null for direct Host text. A Host can prepare and read a complete versioned prompt without submitting it or confirming a run. Driver qualification runs after the durable unknown intent exists. An execution Driver must call the supplied guard after internal awaits, immediately before irreversible submission. Qualification and receipts bind the complete action digest. Abort is local evidence, not remote cancellation.

The original target remains immutable. Observed acceptance can bind the assigned conversation and report with correlation evidence. Each non-null resource identity cannot be replaced; an identity not yet assigned can later be filled from an observation of the same action. Observation uses this retained association and never opens a replacement task to resolve uncertainty.

The Host can claim one canonical workflow per owned run and collect output from its completed original stages using an explicit read-only collector. Observation identity, full bytes and artifact version are retained atomically; identical observations are idempotent and changed observations append. Collectors must call their current-access guard before reading and after internal waits. Local revocation stops fresh reads; late facts from an already admitted call remain attributable to that original action. The [workflow Consumer](../research-workflow/README.md) supplies the current Agent bridge and standard coordinator; website transport remains separate.

An optional trusted lifecycle scope rechecks the live embedding owner on retained reads and before existing external-operation guards. The Provider checks that the same grant remains active after that callback returns. This callable check is separate from imported policy data; raw Host registrations without it retain their lower-level behavior. The workflow Consumer installs the actual Agent/Session association.

## Source Reader access

An optional live Host source capability selects explicit Reader IDs and supplies an attributed URL authorization callback. Without it, source execution is unavailable. A Reader must call the synchronous guard after asynchronous preparation immediately before the initial visit and every redirected visit; an adapter unable to do so must refuse before visiting. The Provider checks current registration, revision and confirmation. These are trusted same-process adapter obligations, not proof that an existing browser transport can intercept redirects.

Source requests and observed captures remain separate from semantic citation judgments. Missing resources cannot be recovered by opening their URL again. Owner-scoped retained reads preserve the supplied UTF-8 extraction, metadata nulls, independent extent and original request digest. No source observation declares research verification complete.

## Workflow records

Source captures record reading extent independently from complete, partial or unknown completeness; partial or unknown captures require a limitation. A matching text digest cannot replace this observation. A run revision alone does not prevent observing the correlated original resource, but current Host, Reader, source configuration and original-target permissions still apply. Observation neither opens a new page nor rereads the requested URL.

Citation assessments bind the exact inventory digest, current claim text digest, original source read and normalized observation digest. Their nonempty short quotes must match complete UTF-8 byte ranges in retained full-text or relevant-passage captures; URLs, search snippets and titles alone cannot satisfy this source requirement. Capture completeness remains independent and must be inspected by the later completion logic. Relations, source-family dependence and primary-record designations remain attributed judgments. The declared model or human author is separate from the actual Host input channel. Responses append and cannot erase counterevidence; no support count, truth guarantee or verification-complete flag is produced.

Counterevidence dispositions bind the complete original Citation or material-judgment record digest, historical inventory and claim text. Same-target treatment appends with compare-and-swap, retaining all history and allowing explicit reopening as unresolved. Another supported citation does not change that treatment. Explained requires actual Citation evidence; corrected-in-final uses Citation evidence or an explicit finalCorrection mapping reference, and remains an attributed interpretation. Declared author and actual Host input channel persist separately; imported completion fields cannot authorize or settle counterevidence. Disposition records alone provide neither final-report mappings nor current verification completion.

Final mappings retain exact latest two-stage report identities, complete final UTF-8 text, current candidate text digests, report byte locations and an acyclic dependency graph. Historical critical corrections and removals require explicit lineage and report revision locations, including removals with no replacement. A separate live Host call confirms the exact current mapping and candidate denominator; a newer mapping, report, inventory or run revision invalidates current confirmation. Imported confirmation and completion fields are excluded. Classification, source assessment, counter-check scope and semantic sufficiency remain attributed interpretations. Confirmation does not compute verification completion.

The finalCorrection basis is restricted to corrected-in-final withdrawal of an exact historical target. The append transaction validates the current confirmed map, matching retired inventory version, claim ID, original text digest and report revision location; no final adopted-fact may still use that original text digest. The map exists before its new disposition, and need not list that new disposition ID in reverse. Historical reads retain the fixed mapping association; newer maps or reports cannot make an old withdrawal basis current or trigger fallback to an unrelated Citation. Retained-unresolved stays unresolved, withdrawal supplies no factual support, and withdrawal does not imply process completion.

The live Host can read recomputed process completeness and record immutable historical decisions with their full original basis. See the [local Provider](../research-handoff-local/README.md) for calculation conditions and limits; a status is not factual truth certification.

Actual Driver receipts may include one message or single text-attachment identity with complete, partial or unavailable read-back. The live Host exposes retained history without granting a new submission capability; see the [local Provider](../research-handoff-local/README.md) for exact matching and failure semantics. Absence is not proof of receipt or non-receipt.

execute accepts an optional trusted synchronous check of the exact request. This callable value is separate from logged or durable data and cannot restore human confirmation or Host access; the local Provider owns its invocation timing. Raw callers may omit it.

A complete workflow preview retains its exact normalized request, original template and slots, full material identities and text, and complete previous-stage action and delivery evidence. Run confirmation and exact-digest human preview confirmation are separate. The Host freezes only a current confirmed preview into the fixed prepared-input ID without admitting an action. Stage delivery gates and immutable human mismatch treatments are defined by the [local Provider](../research-handoff-local/README.md); the standard coordinator is provided by the [workflow Consumer](../research-workflow/README.md).

## Model Experience

### Retained research records

#### What the model sees

The `researchHandoff` Definition registers no model tool or prompt input. Captured input and attributed judgments are data and do not establish factual verification.

#### Token effect

This Definition does not change token budgets or submit external input automatically.

#### KV Cache effect

The consuming Driver owns any model request prefix; this Definition does not change a KV cache.

## Known Limitations and Deferred Work

- This Definition supplies no website transport. A Driver must use an observed supported interface and report unsupported or not observed when evidence is absent. Versioned prompt preparation, per-action Session input logging and original-resource collection provide local primitives; the live Agent/Session Host and standard fixed-stage coordinator are implemented; human command/UI registration and Loader application snapshots remain pending. Interface tests are not website compatibility, research verification or benefit evidence.
