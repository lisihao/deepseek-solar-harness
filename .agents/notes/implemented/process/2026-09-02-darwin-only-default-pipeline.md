# Agent Note: Darwin-only product and default pipeline

Status: implemented

English | [中文](2026-09-02-darwin-only-default-pipeline.zh.md)

## Problem

DSH retained Windows and PowerShell compatibility packages after the supported product had narrowed to macOS. The packages and several Win32-only source and test files still entered ordinary workspace installation, build, typecheck, lint, test, coverage, hygiene, CI, release, and Desktop verification. That work consumed developer and hosted-runner time, introduced native dependencies that the product never loaded, and could fail a Darwin delivery for an unsupported platform.

## Decision

The supported DSH product and its default development pipeline are Darwin-only. Pull-request CI, release families, Desktop packaging, workspace installation, TypeScript projects, Oxlint, Vitest coverage, and Knip exclude the four Windows/PowerShell packages and their Win32-only companion files. Active repository filesystem and JSONL persistence packages no longer import or depend on Koffi-backed Win32 publication helpers. Desktop can retain platform-conditional records inherited from upstream lockfiles, but it does not run Koffi's build script and does not select a Windows artifact, runner, or verification lane. Generic Node fallbacks may remain where they do not select a Windows package, artifact, runner, or verification lane.

The compatibility implementation remains dormant source for upstream comparison and explicit diagnostics. It is not a workspace member, release member, supported tool schema, product dependency, or ordinary verification input. Re-enabling Windows support requires an explicit product decision and restoration of its dependency, build, test, CI, release, and packaging closure before support can be claimed.

Package-wide hygiene discovery uses the same Darwin package boundary. A clean runner therefore never requires built publication or declaration artifacts from the dormant packages.

## Alternatives considered

**Delete all compatibility source.** Rejected because keeping the isolated source helps future upstream comparison and does not cost the default pipeline once every active reference is removed.

**Keep Windows packages in ordinary validation but skip only GitHub jobs.** Rejected because local install, lint, typecheck, test, coverage, hygiene, release, and Desktop assembly would still spend time on an unsupported product surface and could still block delivery.

## Consequences

DSH makes no Windows artifact or support claim. Repository builds and validation no longer resolve, compile, test, package, or release the dormant Windows/PowerShell implementation; Desktop does not build or verify it. The dormant source and third-party lockfile records may drift; that is an accepted property of unsupported compatibility material, and any future reintroduction must restore complete platform evidence rather than treating source or lockfile presence as support.
