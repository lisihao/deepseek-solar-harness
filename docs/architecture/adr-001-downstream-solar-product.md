# ADR-001: Downstream Solar product

Status: accepted

English | [中文](adr-001-downstream-solar-product.zh.md)

## Context

The Solar code line already carries product behavior that is intentionally independent from the official DeepSeek Harness repository. Treating those commits as temporary patches obscures product ownership, release identity, and the direction of future changes.

## Decision

DeepSeek Solar Harness, abbreviated DSH, is a downstream macOS-first product. `solar` is its protected integration branch; work enters it only through reviewed task branches. Official DeepSeek Harness and every external plugin repository are read-only upstream inputs. Solar automation and agents must not push, open upstream pull requests, publish upstream packages, or use upstream release credentials.

DSH Desktop owns a Semantic Version independent of the upstream core and plugin versions. Every stable release uses an annotated tag matching `^DSH-desktop-v[0-9]+\.[0-9]+\.[0-9]+$`, such as `DSH-desktop-v2.4.3`.

## Consequences

Solar can evolve without disguising modified code as an upstream release. Every product release must identify the Solar commit, accepted upstream revisions, managed-plugin revisions, checksums, test evidence, and rollback target. Upstream changes remain candidates until compatibility and capability checks accept them.
