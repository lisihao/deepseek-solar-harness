# Agent Note: Structured output presentation policy

Status: implemented

English | [中文](2026-09-03-structured-output-presentation-policy.zh.md)

## Problem

Model providers and domain tools could return logically related facts as unbroken prose, raw HTML, or internal identifiers. The shared Markdown renderer could display valid structure but could not make an unstructured answer structured, while post-processing generated text would alter the durable model output and its Evidence.

## Decision

`@deepseek-ai/dsh-output-style` contributes one unloadable `ctx.systemPrompt` section to the base composition. It asks models to make presentation follow reasoning: lead with the result, use short headings for multi-part work, lists for parallel items, tables for repeated comparisons, and fenced blocks for code. Simple greetings and one-line questions remain brief, and an explicit user format wins.

The policy remains model input. It does not rewrite generated output, append synthetic Session messages, or intercept the agent loop. A complete persona owns its full prompt by design, so Anchored Standard explicitly composes the same exported guidance into its persona; the raw Minimal preset retains its exact prompt as the deliberate exception.

Domain capabilities whose correctness cannot depend on prompt compliance own deterministic renderers. Debate therefore renders its public topic, participant table, turns, claims, Evidence, lifecycle, and synthesis from structured state, while retaining the original bounded public agent output in Trace and Artifact records.

## Alternatives considered

**Rewrite arbitrary model text after generation.** Rejected because the displayed answer would differ from the durable model output and Evidence, and heuristic formatting can change meaning.

**Append a synthetic user message after preset promotion.** Rejected because it would pollute Session history and trajectory and assign deployment policy to the user role.

**Rely only on domain renderers.** Rejected because ordinary chat, analysis, planning, and comparison answers also benefit from stable presentation guidance, while not every free-form response has a domain schema.

## Consequences

Ordinary compositions receive one stable formatting contract without coupling providers to a UI. Complete presets must opt in explicitly, and the Minimal exact-prompt mode does not receive the policy. Prompt guidance improves defaults but is not treated as a guarantee; deterministic domain presentation remains the acceptance boundary for structured product surfaces.
