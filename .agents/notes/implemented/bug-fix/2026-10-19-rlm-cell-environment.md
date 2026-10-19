# Agent Note: RLM cell environment

Status: implemented

English | [中文](2026-10-19-rlm-cell-environment.zh.md)

## Problem

Generated REPL code runs in a Worker that can inspect its own process environment. Inheriting the daemon's environment exposes configuration unrelated to the task, including provider authentication supplied to the daemon through environment variables.

## Decision

The local RLM kernel creates every Worker with an empty environment. The same construction applies to fresh sessions, children and source recovery. Task inputs remain explicit runtime context; privileged operations remain Host bindings. The environment rule is fixed, with no deployment option to inherit the daemon's environment.

## Alternatives considered

**Filter sensitive variable names.** A denylist preserves ambient variables whose names do not identify their contents. An empty environment avoids relying on those naming conventions.

**Change only the experiment launcher.** A launcher-specific environment does not cover cells created by other Consumers or declaration-source recovery through the actual Runtime.

## Consequences

Cells that depend on ambient configuration must receive the required task data explicitly. Unit checks cover fresh and recovered Workers and isolate cell environment mutations from the host. A runtime-only Loader snapshot covers root, child and Provider restart without a model provider. This is not an OS sandbox: file access, credential files, native process capabilities and network access remain governed separately, and the change does not establish experiment readiness or RLM benefit.
