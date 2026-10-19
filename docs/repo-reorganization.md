# Reorganizing `lisihao/deepseek-solar-harness` for V4

**Confirmed direction (D5, Q1–Q3, 2026-10-19):** keep `lisihao/deepseek-solar-harness` public and organize it for V4. Do not create a separate V4 repository or change its visibility to private. The selected V4 branch is `v4`; the authorized transition makes it the default branch.

This is a personal project even though its repository is public. All pushes in this transition target `lisihao/deepseek-solar-harness`; no official-upstream push, PR, or merge is authorized. Official `deepseek-ai/deepseek-harness` is read-only for reference and updates.

This transition preserves every existing branch, pull request, tag, and Release. It does not delete or close any legacy object. The 27 added DSH 3.x archive branch identities have been verified against GitHub; development is frozen. The [archive record](legacy-source-archive.md) lists exact commits and known verification failures. GitHub readback confirmed the default branch as `v4` on 2026-10-19.

## Historical observed state (2026-10-19)

This is the recorded snapshot from the original proposal, not a fresh check made while recording the D1–D8 decisions. Recheck the affected remote state before executing any step.

- Public repository; default branch `solar`; latest GitHub Release `DSH-desktop-v3.38.0`.
- 191 tags, all `DSH-desktop-v*`; none match the bare `vX.Y.Z` form the market generator applies to every package.
- 232 remote branches besides `solar` and `master`: 13 are the head or base of an open PR, 182 of the rest are ancestors of `solar` or `master` (merged), 37 are neither. Branches merged by squash count among the 37.
- Open PRs: #269–#274 (RLM stack into `solar`), #120, #117, #111, #77, #66, #28.
- The Pages API reports no site. `docs-pages.yml` on `solar` is a Pages deploy workflow triggered by pushes. `e2e.yml` is the only workflow with a `schedule`; `issue-lifecycle.yml` reacts to `issues` events, which GitHub runs from the default branch's files.
- `solar` has branch protection.

## Authorized repository transition

| # | Action | Outward | Reversible |
|---|---|---|---|
| 1 | Create the orphan `v4` branch, holding only V4 files: `AGENTS.md`, `README.md`, `upstream.json`, and empty `plugins/` and `incubator/` directories. | yes | yes (delete the branch) |
| 2 | Switch the default branch from `solar` to `v4`. The V4 `README.md` becomes the repository homepage. | yes | yes (switch back) |

## Explicitly outside this transition

- Do not modify Pages, repository description or homepage URL, branch protection, automation, CI, market indexes, or plugin implementation.
- Do not merge, close, reopen, retarget, or otherwise change any existing pull request.
- Do not delete or modify `solar`, `master`, any other existing branch, any tag, or any Release.
- Do not move DSH 3.x source into the V4 branch. Preserve it as the verified legacy source archive documented above.

## Completed transition verification (2026-10-19)

GitHub readback matched all 27 new archive commits and confirmed `v4` as the default branch. Comparison with the pre-transition inventory found all 234 old branches, 191 tags, 34 Releases, and 12 open pull requests unchanged. The V4 tree is an independent root history containing documentation, the upstream identity, and empty plugin directories; no 3.x source or workflow was imported.

The first V4 commit uses the selected author email, but GitHub returned `author.login: null`. The email was not linked to a GitHub account at that observation. The transition did not change account settings or substitute another author identity; account linkage remains a separate user action if desired.
