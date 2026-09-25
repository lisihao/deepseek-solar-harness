# ADR-002: One product monorepo

Status: accepted

English | [中文](adr-002-monorepo.zh.md)

## Context

The DSH core, Desktop shell, and modified plugins lived in separate repositories. Absolute file links, packaged archives, and a nested upstream submodule made a working installation possible but did not provide one reviewable source closure.

## Decision

The Solar repository is the single product source. The existing core stays at the repository root to preserve its pnpm workspace. Desktop source lives at `products/desktop` without a nested DeepSeek Harness submodule. Solar-owned plugin source lives under `plugins/managed`, and product manifests live under `distribution`.

The first migration preserves each imported repository's history and lockfile. Core continues to use pnpm and Desktop continues to use Yarn until a separate decision proves that package-manager unification reduces risk. Source imports never include `node_modules`, build output, credentials, user profiles, sessions, memories, or an installed application.

## Consequences

A fresh clone can inspect and modify every Solar-owned input without consulting sibling source repositories. Component-native tests remain valid during migration. Build integration, profile assembly, and final source closure are later phases and cannot be inferred merely from colocating source.
