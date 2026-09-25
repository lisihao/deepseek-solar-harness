# Agent Note: Controlled Desktop plugin composition

Status: implemented

English | [中文](2026-08-22-controlled-desktop-plugin-composition.zh.md)

## Problem

DSH Desktop combined product-owned capabilities with profile-installed plugin versions. An old Better Sidebar could mount beside the aggregate Web UI copy, while Desktop put Physical Operators and Orchestrations in the sidebar footer. Memory Evolve and Luna Vision Bridge duplicated capabilities that the accepted Mnemon plugin and native DeepSeek vision model provide. Aegis also shipped an agent bootstrap that could become a second completion authority beside the user's Code-as-Harness project.

## Decision

The Desktop dependency graph seals each accepted controlled plugin and maps its archive to tracked source under `plugins/managed`, extending the [Desktop source-closure decision](../process/2026-08-20-desktop-source-closure.md). Product-first dependency resolution supplies the accepted Better Sidebar to direct and aggregate consumers, and Better Sidebar refuses a second mount when an aggregate owner is already active. Desktop registers Physical Operators and Orchestrations in the current Session header instead of `sidebar.footer.action`.

Mnemon is the only product memory bundle. Profile composition removes Memory Evolve from the product bundle list and disables a stale explicit Memory Evolve row without deleting user files. The native DeepSeek provider declares `deepseek-v4-flash-vision-exp` with text and image input, so Luna Vision Bridge and Modlens are absent from the product dependency graph.

Aegis contributes its skills directory and no bootstrap or prompt injection. The user-created `agent-development-governance` remains the sole Code-as-Harness completion, attestation, and admission authority. Plugin checks, model fallbacks, GenUI, code graph support, and bounded stat, time, regex, and Markdown tools remain ordinary product capabilities under that authority.

## Packaging and verification

[`plugins/registry.yaml`](../../../../plugins/registry.yaml) records accepted revisions, licenses, and native checks. [`products/desktop/dsh-plugin-desktop/vendor/manifest.json`](../../../../products/desktop/dsh-plugin-desktop/vendor/manifest.json) maps sealed archives to tracked packages and bytes. The full controlled-plugin check executes each component's native build or test command, while Desktop profile and packaged-composition checks require one enabled row per product capability, reject retired rows, load the native vision model, and resolve the packaged client modules. Installed acceptance also verifies that the Session header owns the two operational actions and that the sidebar remains interactive.

## Alternatives considered

**Use profile-installed plugin versions.** Rejected because a clean clone and a built application could exercise different packages, and aggregate dependencies could reintroduce an older sidebar implementation.

**Keep Memory Evolve beside Mnemon.** Rejected because two memory settings and prompt policies create conflicting ownership. Disabling stale rows preserves user data while leaving one product memory implementation.

**Keep Luna Vision Bridge as a fallback.** Rejected because the native provider owns the accepted multimodal model and a second image-to-text request path changes provider selection and billing.

**Load the complete Aegis DSH bootstrap.** Rejected because its prompt injection and agent runtime overlap the explicit Code-as-Harness authority. Skills retain the useful method library without creating a second governor.

**Keep operational actions in the sidebar footer.** Rejected because those actions are Session-scoped inspection surfaces and consumed the navigation column needed by the sidebar plugin and session list.

## Consequences

The public repository contains editable source and sealed inputs for the default Desktop composition. A plugin update requires a managed-source revision, a compatible package range, a rebuilt archive, manifest evidence, native checks, and Desktop composition acceptance. User profile data remains outside Git and is not deleted by product retirement. The product gives up Memory Evolve-specific evolution workflows, Luna subscription bridging, Modlens, and Aegis bootstrap behavior in exchange for one memory owner, one native vision path, one governance authority, and one sidebar owner.
