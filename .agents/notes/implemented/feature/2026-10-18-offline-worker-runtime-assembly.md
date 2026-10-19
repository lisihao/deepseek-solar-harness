# Agent Note: Offline Worker and Runtime assembly

Status: implemented

English | [中文](2026-10-18-offline-worker-runtime-assembly.zh.md)

## Problem

Offline RLM preparation must distinguish stored context from actual model requests and context placement from the ability to execute tools or spawn children. A synthetic adapter that bypasses the real Worker or Runtime cannot establish those connections.

## Decision

The package root re-exports the existing durable evaluation ledger; there is no second meter or new ledger format. A runnable Loader fixture uses the actual DeepSeek Worker tool loop and Local Runtime while substituting only the model transport. Full and external context pairs share the same original UTF8 file, question, actual model parameters, tool schemas, cell code and independent child-spawn policy. Original source bytes, persistent context, complete requests, individual sends and ledger rows remain available as separate evidence.

One fixture Consumer owns the trial claim, deadline, cell proxy and original ledger. Every registered root, child and grandchild receives the proxy bridge. A stable command occupies a cell before forwarding; its complete arguments determine conflicts, and its promise or outcome is retained without refund or replay. The [package README](../../../../packages/orchestration/orchestration-local/README.md#evaluation-scope) owns the public ledger and fixture limits.

## Alternatives considered

Using direct answers as the full-context baseline would change tool execution as well as context placement. A second usage counter would duplicate the ledger. Counting only ledger rows would miss a physical send without a corresponding row; the fixture instead compares independently captured sends with individual attempts.

## Consequences

The deadline stops new admission and requests cancellation; it does not stop a running Runtime cell. Late cell outcomes remain recorded. In-memory cell counts and deadlines cannot restore a trial, so an existing claim refuses whole-trial reconstruction. Ledger reopening retains unknown reservations independently of that refusal.

Known partial Worker usage remains distinct from complete per-request accounting; output already includes reasoning. Source and plain Node built Loader snapshots test the same composition. This is keyless assembly evidence, not a faithful eight-arm production runner, an OS sandbox, an input/reasoning token hard bound, dataset permission, official Pairs scoring, a paid-run authorization or a benefit measurement. No installed application changes.
