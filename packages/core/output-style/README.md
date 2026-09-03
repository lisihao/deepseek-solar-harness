# dsh-output-style

English | [中文](README.zh.md)

Composable, unloadable response-presentation guidance for DeepSeek Harness. The plugin contributes one ordered `ctx.systemPrompt` section; it does not rewrite model output, append synthetic Session messages, or intercept the agent loop.

The default policy asks models to make formatting follow the answer's logic: lead with the result, use short headings for multi-part work, lists for parallel items, tables for repeated comparisons, fenced blocks for code, and avoid raw HTML, internal IDs, and run-on text. Greetings and simple one-line questions remain direct and brief, and an explicit user-requested format always wins.

## Cordis surface

- Plugin name: `output-style`
- Injects: `ctx.systemPrompt`
- Section: `output-style:response`, order `25`
- Disposal removes the section immediately.

Complete personas intentionally replace additive prompt sections. A complete preset that wants this policy must explicitly compose `ANCHORED_STANDARD_PERSONA` or `OUTPUT_STYLE_GUIDANCE`; the shipped Anchored Standard preset does so. The raw Minimal preset remains an exact-prompt exception.

## Model experience

The guidance is stable model input, so it remains visible and auditable without changing the answer after generation. Domain UIs still own deterministic presentation where correctness cannot depend on prompt compliance; for example, Debate renders its roster, turns, claims, and lifecycle from structured state.
