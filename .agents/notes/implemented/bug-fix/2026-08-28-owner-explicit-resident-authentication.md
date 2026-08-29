# Agent Note: Owner-explicit Resident authentication

Status: implemented

English | [中文](2026-08-28-owner-explicit-resident-authentication.zh.md)

## Problem

Claude Code subscription qualification could report `auth_required`, but DSH had no owner-controlled recovery action. Repeated dashboard refreshes and product failures must not open multiple OAuth windows, and a paired remote Frontend must not start a browser login on the Server. Qualification and execution also need to use the same resolved product executable so an older system CLI cannot authenticate a different credential client.

## Decision

Resident protocol version 10 adds `operator.authenticate` and the provider-neutral `ctx.residentOperators.authenticate()` management seam. Authentication is optional on a product Driver and is started only by an explicit local owner action from the CLI or Resident panel. The daemon coalesces concurrent requests for one operator into one product login process. If the provider is already qualified, it returns the current status without starting another process.

The Claude Driver invokes `claude auth login` through the exact absolute executable selected by normal qualification and execution. It supplies the same credential-scrubbed native environment, then re-runs qualification. DSH does not read, copy, refresh, or persist OAuth material; Claude Code and the operating-system credential store remain the token authorities. Polling, startup, qualification failure, and a product 401 only report state and never trigger login.

The authenticated Host route keeps GET available to loopback owners and paired devices, but accepts the login POST only from a loopback owner request. A remote Frontend shows Server-local guidance instead of a login button. Provider-cache invalidation after login makes the new qualification visible immediately.

## Verification

Focused daemon tests prove concurrent authentication requests invoke one Driver operation and return the same qualified result. Host-route tests prove a loopback owner can start login while an authenticated remote administrator receives `LOCAL_OWNER_REQUIRED`. Client tests pin that login uses an explicit POST. The affected project-reference TypeScript build passes.

## Alternatives considered

**Launch login automatically after a 401 or during polling.** Rejected because unrelated status reads would create browser side effects and concurrent refreshes could open repeated windows.

**Copy the Claude token into DSH state.** Rejected because it creates a second credential authority and would make logout and refresh semantics diverge from Claude Code.

**Allow a paired remote administrator to start login.** Rejected because the OAuth callback and browser belong to the Server host, not the Frontend device.

## Consequences

Authentication recovery is now an explicit, single-flight management action and remains separate from task execution. An unattended remote Server still requires its owner to complete Claude login on that Server. Codex remains qualified through its existing product-native login path until its Driver explicitly implements the same optional authentication operation.
