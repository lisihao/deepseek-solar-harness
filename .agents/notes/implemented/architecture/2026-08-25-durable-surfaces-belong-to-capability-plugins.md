# Agent Note: Durable surfaces belong to capability plugins

Status: implemented

English | [中文](2026-08-25-durable-surfaces-belong-to-capability-plugins.zh.md)

## Problem

DSH Server is the sole authority for Resident physical-operator Sessions and persistent orchestration Runs, but their browser panels and Resident HTTP projection lived inside the Desktop product plugin. A pure Server profile could therefore run the daemons while omitting the browser modules and `/api/resident-operators`, and a frontend-only browser would need Electron-owned code to observe those capabilities.

## Decision

`@deepseek-ai/dsh-ui-orchestration` and `@deepseek-ai/dsh-ui-physical-operator` are dual-face capability plugins. Their Host faces register authenticated bounded HTTP projections, while their Client faces register ordinary Cordis slots. The Resident and orchestration Bundles mount the matching UI package, so pure Server, local Desktop, and remote frontend clients use one package graph without importing Electron code.

Generic Client HTTP surfaces use `ctx.connection.request`, which attaches the same memory-only bearer as the primary remote transport. Host routes share `authorizeRemoteRequest`: strict loopback requests are accepted locally, while non-loopback requests require a Remote Auth bearer. Resident projection stays GET-only; durable mutation remains with the existing Resident and orchestration services.

## Consequences

- Desktop owns only product branding and native shell behavior; it no longer duplicates generic Resident, routing, or orchestration surfaces.
- Disconnecting a Client unloads only its slot contribution. It cannot stop a daemon, settle a Run, or create another state writer.
- Pure Server composition must prove both APIs and both boot-manifest modules without mounting the Desktop plugin.
- The first remote vertical slice refreshes bounded snapshots; cursor-based live event streaming remains deferred.

## Alternatives considered

**Keep the surfaces in Desktop.** Rejected because Server and phone/browser clients would depend on an Electron product package and pure Server would keep omitting a required projection.

**Add a separate remote-dashboard application.** Rejected because it would duplicate the existing Cordis Client composition and create another UI package graph instead of reusing capability-owned faces.
