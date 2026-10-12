# Agent Note: A run can be bound to a set of Gouzi members

Status: implemented

English | [中文](2026-10-08-gouzi-recipient-sets.zh.md)

## Problem

A TaskGraph run admitted for the kennel carries one `gouziRecipient`: a member, its generation, and its execution entries. The daemon pins every node to those entries, and grant issuance refuses any other member. A graph whose nodes run on different members, such as a Debate whose roles are members or one member reviewing another's result, could not be admitted with a Host-confirmed binding. Naming member operators without a recipient skips the generation and availability checks, which are the point of the binding.

## Decision

[`OrchestrationAdmissionTraceV1`](../../../../docs/subsystems/orchestration.md) gains `gouziRecipients`, a set of at least two distinct members, each with its own generation and execution entries. The singular field stays the form for one member. A run carries one or the other, never both, and no two members share an entry, so a binding has a single encoding. `admissionGouziRecipients` reads either form as a list, and the daemon, grant issuance, the room, and the dispatcher read through it.

The [daemon](../../../../packages/orchestration/orchestration-local/README.md) checks the wire shape and then, at compile and before start, that every node uses only the union of the members' entries without fallback, that each member is current and available, and that each holds the graph workspace. A directory snapshot needs every member on this machine, and the local-directory check is skipped only when every member is remote. Grant issuance finds the issuing member's own recipient and applies the singular checks to it, so a set that omits a member cannot be used to run on that member.

Records written before this change carry only the singular field and read as before. Which members a graph uses, and the graph itself, remain the producer's choice; the kennel dispatcher still admits one member per message.

## Alternatives considered

**Make `gouziRecipient` an array.** Every stored record and every older reader of the singular field would change shape, and a one-member run would have two spellings.

**Bind members through node operators alone.** That is what happens without a recipient, and it skips the generation, availability, and workspace checks.

**One run per member, joined by the caller.** A Debate or review needs one graph with dependencies between members' nodes, which separate runs cannot express.

## Consequences

Nothing admits a set yet; the producers are the planned Debate roster and member review. An older build does not know the plural field, so after a downgrade it would not enforce a recipient set on an existing run. Builds are paired with their daemon by the handshake, which keeps two builds from sharing one state directory at once. Every member of a set must hold the same workspace path, which is natural on one machine and a constraint across hosts. RLM and Autonomous stay disabled for bound runs, as for one member.
