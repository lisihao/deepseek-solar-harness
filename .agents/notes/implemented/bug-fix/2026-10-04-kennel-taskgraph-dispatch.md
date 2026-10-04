# Agent Note: Kennel TaskGraph dispatch

Status: implemented

English | [中文](2026-10-04-kennel-taskgraph-dispatch.zh.md)

## Problem

A kennel steward can construct an incomplete graph, receive `GRAPH_INVALID`, then try the same Gouzi id through `physical_operator`. That tool's host registry does not own Gouzi TaskGraph execution, so the second failure can misleadingly appear to establish a disconnected member.

## Decision

The orchestration tool describes a complete read-only graph template using the real graph fields. The kennel persona routes every explicitly named member task through a TaskGraph, including one read-only node. Gouzi ids are reserved for node `operator.preferredIds`; the direct physical-operator tool refuses them with an actionable routing error before execution. A graph validation error remains a graph validation error and requires correcting the reported field. Connection state does not establish native provider qualification or task completion.

## Alternatives considered

**Register Gouzi in the host tool registry.** Direct execution would lack the TaskGraph attempt and execution grant that the member requires. Keeping the scheduler as the admission and acceptance authority preserves that requirement.

**Repair omitted graph fields automatically.** Inferring a workspace, permissions, or acceptance criteria would add authority that the model did not submit. The complete template supplies construction guidance while validation continues to reject incomplete input.

## Consequences

Named-member work keeps durable scheduling and execution grants, and incorrect direct calls fail before side effects. The stable tool description costs additional prompt tokens. Model guidance and keyless replay cannot guarantee that a live model will choose the right graph or establish the health of an installed release.

## Verification

The focused graph test checks the actual validator against the model-visible template and rejects a missing title. The assembled headless snapshot pins the schema delivered to the model. Direct-tool tests cover rejection before provider dispatch, and real member-process tests cover the TaskGraph route without a paid model call.
