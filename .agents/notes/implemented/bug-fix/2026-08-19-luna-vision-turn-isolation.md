# Agent Note: Luna vision turn isolation

Status: implemented

English | [中文](2026-08-19-luna-vision-turn-isolation.zh.md)

## Problem

Luna Vision Bridge must use the current user's authenticated Codex subscription for image transcription without turning that transcription into a full coding-agent run. Inheriting user configuration, repository instructions, skills, plugins, apps, and tools expands the model context, permits unrelated tool use, and makes a single image transcription depend on the surrounding development harness. The settings form also leaves a successful save visually indistinguishable from an ignored click.

## Decision

The bundled Luna launcher starts an ephemeral, read-only Codex turn with the selected image and transcription prompt while retaining the current Codex authentication. It ignores user configuration and repository rules, excludes project, application, collaboration, environment, and permission instructions, and disables skill injection, plugins, apps, tool discovery, execution tools, hooks, memories, and unrelated multimodal facilities. The turn has no model-visible developer harness and returns only the JSONL response consumed by the Host adapter.

The settings section displays a live status message after `settings.update` or the default-restoring `settings.mutate` succeeds. Editing any field clears the prior success message, so the message always describes the currently displayed draft.

## Verification

Launcher tests capture the exact Codex arguments and require the isolation switches. Client tests save a changed downstream target and restore defaults through the settings API, then require the corresponding live status message. Package acceptance runs a real supported image through the installed launcher and confirms a Luna description without shell or other tool calls.

## Alternatives considered

**Inherit the user's complete Codex environment.** This reuses a coding harness for a narrow vision turn, injects unrelated instructions and skills, and can trigger tools or excessive context usage.

**Call the OpenAI API with an API key.** This changes the product's authentication and billing contract; the bridge is intentionally backed by the user's logged-in Codex subscription.

**Keep successful writes silent.** The API applies settings live, but a silent form cannot distinguish success from an unresponsive control and led users to repeat valid actions.

## Consequences

Image transcription remains subscription-authenticated but is independent of the user's coding configuration and available tools. Settings persistence becomes observable without a restart. New Codex CLI releases must retain the launcher switches used by the packaged plugin; the focused launcher test detects a missing argument before release, and installed-image acceptance detects an incompatible runtime behavior.
