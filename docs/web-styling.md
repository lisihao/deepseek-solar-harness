# Web UI style reference

English | [中文](web-styling.zh.md)

This reference defines styling ownership and component rules for browser client packages. The current token values live in [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/); this document does not duplicate that generated-by-source inventory.

## Ownership

[`ui-theme`](../packages/client/ui-theme/README.md) owns the `--dsw-*` static scale, semantic aliases, typography, motion, gradients, shadows, scrollbar styles, and light/dark preference. [`ui-layout`](../packages/client/ui-layout/README.md) applies the resolved theme snapshot to the document. Feature packages consume semantic aliases and do not define another global theme.

Global style sheets belong in `ui-theme/src/styles/`. Component styles live beside their component as CSS Modules. A component may define a local custom property when its value is part of that component's layout or presentation contract; shared colors, typography, elevation, and motion belong to the theme package.

## Component rules

- Use CSS Modules and `clsx`; do not add a component library or Tailwind.
- Use `--dsw-alias-*` semantic tokens in feature components. Do not copy static palette values or write literal colors there.
- Keep theme selectors out of feature component CSS. Light/dark overrides belong to the theme owner.
- Pair font sizes with line heights and use the theme typography variables when an existing role matches.
- Keep source text, terminal output, and diff lines unwrapped when their component contract requires column preservation; use the shared scrollbar styles rather than component-specific scrollbar selectors.
- Put presentation in CSS. Inline React styles may pass component-local custom-property values but must not encode theme branches.
- Preserve keyboard focus visibility and reduced-motion behavior when adding transitions or hover-only controls.

## Layout and visual hierarchy

These rules come from defects seen in shipped panels: browser-default buttons stacked beside a title, a button label wrapping to two lines, a form card overlapping its heading, and an empty-state sentence floating next to a form. A passing test does not show that a layout is acceptable.

- Build from `ui-primitives` (`Button`, `Input`, `Modal`, `Menu`, `Pill`). A bare `<button>`, `<input>`, or `<select>` with browser styling is a defect. Each view has one primary action; other actions use the secondary, ghost, or icon variant.
- A header is one flex row: the title block (title, then a one-line description) on the left and the actions on the right. Actions stay in a row, never stack vertically, and never share a column with the title. A dismiss control is an icon button in the top-right corner.
- Button labels do not wrap: set `white-space: nowrap` and give the action group `flex: none`. When a label does not fit, shorten it or move the action.
- Place regions in the normal flow of a grid or flex container with explicit gaps. Sibling regions do not overlap, nothing is absolutely positioned over text, and nothing is clipped at a 1000 px window width. A form is a single column with a readable maximum width, or a grid of equal columns. Each field stacks label, control, then hint, and the hint is smaller muted text.
- Reuse the spacing, radius, and type sizes of the neighboring primitives and the theme tokens. Do not invent one-off pixel values. Related items sit closer together than groups, and groups closer than sections.
- Design the empty state: one sentence naming what is missing and the action that fixes it, inside the container, not a stray paragraph beside the form.
- Before reporting a UI change done, render it in the Browser pane or a Playwright snapshot at the default and a narrow width, in the dark and light themes. Fix wrapped buttons, overlap, clipped text, and uneven alignment, and state what you inspected.

## Changing the system

Add or change a shared token in the owning `ui-theme` sheet, then consume its semantic alias from feature packages. Update the owning package reference when a public styling contract changes. Visual behavior follows the [testing policy](testing.md); the [styling-system Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) records framework rationale.
