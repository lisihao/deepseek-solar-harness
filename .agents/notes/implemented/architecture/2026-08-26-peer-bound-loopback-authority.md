# Agent Note: Bind loopback authority to the observed TCP peer

Status: implemented

English | [中文](2026-08-26-peer-bound-loopback-authority.zh.md)

## Problem

The browser-trust fence validates Host and Origin to stop DNS rebinding, but an arbitrary HTTP client chooses those headers. Treating a loopback Host as local-owner authentication lets a remote peer send `Host: localhost:3080` and reach local-only behavior. The node-to-Fetch bridge also discarded `socket.remoteAddress`, so shared RPC handlers could not distinguish a genuine loopback connection from a forged header. A Typert interceptor can claim an endpoint before the API Proxy fallback, which means fallback-only authentication does not cover the complete `/api` path.

## Decision

Host and Origin remain reachability and browser-confused-deputy checks. Local-owner authority requires both a loopback Host and a loopback TCP peer observed by the Node server. The HTTP bridge carries `socket.remoteAddress` as internal `FetchRequestContext`, and RPC dispatch copies it into `ConnectionRpcRequestContext`; neither value comes from request headers.

The shared `/api` route authenticates every non-loopback peer before either Typert interception or API Proxy fallback. A non-loopback request is refused when Remote Sync is disabled, and otherwise requires a valid Remote Auth bearer. Pocket credentials remain limited to the explicit read and response operations. Dedicated Remote Auth and Remote Sync channels keep their endpoint-specific checks, including peer-bound local pairing issuance and bearer-protected administration. `trustedHosts` only admits a serving authority through the rebinding fence; it never authenticates a client.

## Alternatives considered

- **Keep Host-only local detection.** Rejected because Host is unforgeable to a rebound browser but fully caller-controlled for curl, proxies, and custom clients.
- **Authenticate only in the API Proxy fallback.** Rejected because a registered Typert interceptor claims requests before fallback and would remain an unauthenticated path.
- **Rely only on loopback binding.** Rejected because the Server product supports authenticated remote Frontends and tunnels; the authorization rule must remain correct when network reachability changes.

## Consequences

- A remote peer that sends a loopback Host receives 401 or 403 before application dispatch; a genuine loopback peer keeps local-owner behavior.
- Direct remote Frontends present their short-lived bearer on API and event requests. An authenticated loopback tunnel continues to appear as a local connection to the Server.
- Transport adapters that invoke a shared Fetch handler must supply the observed peer address. An absent address fails closed for local-owner checks.
- Regression coverage exercises API Proxy, Typert interception, pairing issuance, Remote Sync, loopback-only RPC, and WebSocket upgrade paths independently.
