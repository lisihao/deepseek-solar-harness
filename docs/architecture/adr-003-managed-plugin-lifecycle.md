# ADR-003: Managed plugin lifecycle

Status: accepted

English | [中文](adr-003-managed-plugin-lifecycle.zh.md)

## Context

DSH installs many third-party plugins, but only plugins changed for Solar need product ownership. Treating every installed dependency as source would create unnecessary maintenance, while leaving modified plugins outside the product repository would make fixes irreproducible.

## Decision

Plugins are either `external` or `managed`. An external plugin is consumed at a locked version and revision without Solar source changes. A managed plugin has Solar fixes or features and is imported under `plugins/managed` with its history, package identity, source and upstream URLs, accepted revision, license status, and local test commands recorded in `plugins/registry.yaml`.

Promotion to managed requires source and license review, removal of absolute runtime links, component tests, a composed DSH or Desktop acceptance path, and upstream monitoring. Subsequent Solar changes stay in this monorepo and are never sent upstream.

## Consequences

The repository owns only the code it must maintain. Missing provenance, an unknown license, a dirty source checkout, or an unverified revision fails import closed. Runtime shims remain temporary and require an explicit retirement condition.
