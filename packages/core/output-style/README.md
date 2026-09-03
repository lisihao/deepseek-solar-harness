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

## Model Experience

### Response presentation system prompt

#### What the model sees

Normal compositions receive the stable `output-style:response` section below after identity and persona. A complete persona replaces additive sections and must compose the same exported guidance explicitly; Anchored Standard does so. The policy remains auditable model input and never changes an answer after generation.

##### Default response guidance

```markdown
Output style:
- For analysis, plans, comparisons, implementation work, or any multi-part answer, lead with the conclusion or result. Use short descriptive headings and one blank line between sections. Use lists for parallel items, tables only for repeated comparisons, and fenced code blocks for code or structured payloads.
- Make hierarchy, ordering, and visual formatting mirror the reasoning. Keep user-facing output free of raw HTML, internal IDs, or run-on unstructured text unless the user explicitly asks for diagnostics or an exact format.
- For greetings and simple one-line questions, answer directly and briefly. Follow an explicit user-requested format over these defaults.
```

#### Token effect

The fixed guidance is included once in every request whose effective persona is not complete; an explicitly composed complete persona carries the equivalent text once.

#### KV Cache effect

Prefix-stable while the section text and order remain unchanged. Loading, unloading, or editing the section invalidates reuse from the first changed system-prompt token.

## Known Limitations and Deferred Work

- Model guidance cannot guarantee that every Provider follows the requested presentation exactly; deterministic Debate and trajectory surfaces must still render structured state themselves.
- The raw Minimal preset deliberately omits this guidance because its prompt is an exact compatibility contract.
