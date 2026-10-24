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

## Human confirmation and unrun scope

The native UI observer could not uniquely match the selected CoreGraphics window
to an Accessibility window; this is not automated plugin-button acceptance.
On 2026-10-24 the user directly confirmed that the normal model picker shows
**Grok 网页算子**. This closes the installed-entry visibility check only.
No new Grok generation, live result receipt, live reply capture,
result-carrying handoff or complete Insight research chain was run.
Local tests and signed-in draft observation do not establish these effects.
Private backup paths, account/conversation content and UI captures are not
committed.

## Literal paragraph-readback repair installed — 2026-10-24

The first user-triggered attempt failed before durable send intent with
`GROK_PROMPT_READBACK_MISMATCH`. Its exact original draft was retained: 90 direct
ProseMirror paragraphs, 26 empty, with 115 extra layout LF characters in native
`innerText`. The fixed production DOM observer reconstructed exactly 12,153 input
bytes on that same page, with no page writes, no messages and no Send. Strict
comparison still rejects real space/line differences and unsupported structures.

Runtime source `e8f23504cd99b21682bb9274805462096a01e50f` passed the full gate:
531 tests across 57 files, build, strict types, two official CLI scratch-profile
probes and homepage/curated checks. The focused DOM/transport suite passed 19
cases; the three new reproduction cases had failed before the fix. Independent
read-only review found no blocker. Exact source CI `40127887359` succeeded.

The new archive SHA-256 is
`250d78ee0fbf85332ba9fa51167c756d6832562f8b092c4b56403fe79aecb207`.
Only Web was updated using the official CLI, after the latest profile/lock/Web
data and affected original session backup. All 61 installed files matched.
The 44 other plugins, profile settings, billion-context state/config/logs,
Hindsight configuration, existing Solar JSON and 472 original session files
passed preservation checks before normal relaunch. The client artifact is
byte-identical, so the earlier user-confirmed model-entry UI remains applicable.

Post-restart the original failed Grok run still had the same four revisions;
no new Solar JSON or Grok task appeared. One original compressed session file
changed. Full multi-frame Zstandard decoding showed its 72 previous records
preserved exactly in order, with one native `session/end-seed` record appended.
There was no new request or model event in that append. The official CLI listed
45 direct plugins and the normal App process was running.

The original browser page/draft and failed attempt remain retained, not retried.
No real new Send, user receipt or completed-answer capture was run by this
repair. A passive record baseline is ready for a later user-initiated check;
installation and the successful original-draft readback do not establish that
remaining live chain.
