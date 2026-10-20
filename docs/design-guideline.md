# Web and Insight settings design

Scope: the Solar ChatGPT Web plugin's settings panel. This is a component guideline, not a redesign of the official Harness shell or the workflow canvas.

## Intent and hierarchy

The primary task is choosing how a future Web answer runs. The first view therefore shows a short title, a compact browser/current-selection summary, model and reasoning controls, and save/reload actions. A separate Insight tab exposes research stages. Avoid nested bordered cards, repeated labels, large status banners and implementation prose in the primary path.

Use the host's theme tokens and native macOS/system font stack. A restrained violet accent identifies the active tab and primary action. Typography, spacing and alignment establish hierarchy; decoration is secondary. Inputs remain readable at both normal and narrow widths.

## Progressive disclosure

Manual exact labels and model-scoped catalogue inspection remain available under a labelled disclosure. Insight stages show their position, purpose and configured model in a collapsed row; opening a stage reveals its model controls and prompt template. Full Insight JSON and Gemini selectors stay in a separate advanced disclosure. A missing configuration is stated at the relevant action, rather than replacing the entire panel with warnings.

## Behavior to preserve

- Empty ordinary-Web model/effort fields follow the target browser. Saved explicit choices, including unmatched values, remain visible and unchanged until the user edits them.
- Opening settings or switching tabs reads only cached/local state. Catalogue refresh is explicit and sends no prompt. Save remains explicit and revision-checked.
- A catalogue observation describes Ego Lite only. Keep its current selection separate from the model being inspected for available efforts.
- Stage choices apply to their provider. ChatGPT options are never shown as Codex or Gemini options.
- Errors remain visible and explain the failed operation; advanced disclosure must not hide save or refresh failure.
- Tabs, summaries, fields and buttons retain keyboard access and descriptive names. At narrow widths, columns stack and actions wrap without horizontal page overflow.

## Acceptance

Inspect actual rendering at normal and narrow widths, keyboard/tab switching, exact-value preservation, explicit refresh, explicit save, and error presentation. Fixture model labels are synthetic. Rendered local components, built-profile loading, installed-app UI and real model execution are separate evidence. No aesthetic score or standards certification is claimed.
