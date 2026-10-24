# Grok operator candidate acceptance — 2026-10-24

This is a preview installation record, not a plugin release or proof of a new
live Grok answer. The official Desktop application was not modified.

## Source and artifact

| Candidate | Runtime source | Artifact SHA-256 | Verified installed files |
| --- | --- | --- | --- |
| Web/Grok | `6a9c4c9f31f77d61c4f979a451fb84d24107bf8e` (PR #316) | `5ce7566c9edb6dd0dfeafed462a1c599edb31ddc70fa69441f3a151c3f912bfa` | 61 |
| Companion handoff | `e8b1e3e37e8ff0f233dff6468bf87454f2e65154` (PR #317) | `76432c75a26322112c901cc25a1472610b7b355dee6f638e5c28430455e47bd7` | 17 |

Exact runtime CI runs were successful: Web/Grok `40123408022`, handoff
`40123446720`. Both pull requests remain open. No merge, release, tag, market
publication or application rebuild took place.

## Checks actually run

- Web/Grok repository gate: build, strict types, 525 tests across 57 files,
  two official CLI scratch-profile probes and homepage/curated checks passed.
- Affected follow-ups: 13 controller tests and 15 DOM/transport tests passed,
  followed by rebuilt artifacts and strict types. Independent read-only review
  confirmed the cleanup-admission and multiline-receipt fixes.
- Handoff source suite passed 172 tests before the added audit-projection case;
  all 5 history tests then passed. Built runtime passed 40 tests. Two official
  CLI fake-provider probes and generated homepage check passed.
- Signed-in Grok observation used visible DOM only. One expressly authorized
  draft was filled, the enabled Submit control observed, then the draft cleared.
  A production DOM observer confirmed one empty composer, zero messages and no
  page errors. The dedicated TaskSpace was normally finished. No Submit ran.

## Installed boundary

The current profile and lockfiles, previous affected packages and plugin-owned
data were backed up before the official bundled CLI installed the two fixed
archives. Desktop/Host had normally exited; Resident was inspected for idle
state and normally stopped. A lingering process exited naturally before the
backup guard admitted installation; no process was forcibly killed.

All 78 installed files matched their archive bytes. The 43 other direct plugins,
profile settings, billion-context state/configuration/logs, Hindsight configuration,
existing Solar JSON records and 472 original compressed session logs passed the
pre-relaunch preservation checks. Desktop was normally restarted. The official
CLI then listed 45 direct plugins, including the new candidates and the retained
memory-context and billion-context packages. A read-only post-restart audit
found zero changed original session files, zero new session files and zero
changed/new Solar JSON files.

## Unrun or pending

The native UI observer could not uniquely match the selected CoreGraphics window
to an Accessibility window; this is not a plugin-button acceptance. Human
confirmation that the model picker shows **Grok 网页算子** was requested and is
pending in this record. No new Grok generation, live result receipt, live reply
capture, result-carrying handoff or complete Insight research chain was run.
Local tests and signed-in draft observation do not establish these effects.
Private backup paths, account/conversation content and UI captures are not
committed.
