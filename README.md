# DeepSeek Solar Harness V4

DSH V4 uses the official DeepSeek Harness Desktop application unchanged together with an independent collection of Solar plugins. V4 has no core of its own: it does not vendor, fork, build, re-sign, or otherwise modify the official application.

V4 is a personal project hosted publicly at `lisihao/deepseek-solar-harness`. Official `deepseek-ai/deepseek-harness` upstream is read-only for reference and updates: this project does not push, submit PRs, or merge changes into it. V4 feature PRs belong in the personal repository.

## Current state

No Solar plugin has been published. No market index or installation URL exists, and no V4 CI or automation has been implemented or activated. D7 continues to defer the first plugin.

The `v4` branch is the V4 repository entry point. It contains the V4 rules, documentation, pinned upstream identity, and empty plugin directories. GitHub readback confirmed `v4` as the default branch on 2026-10-19.

## Upstream baseline

The recorded baseline is [`@deepseek-ai/dsh@0.2.1-rc.2`](upstream.json), with tag `dsh-v0.2.1-rc.2` and commit `687f282e8625c6b8d11ff58211a90524be2e4317`. This record is not a claim that the baseline is the current upstream release or that it has passed installed-app acceptance.

## DSH 3.x archive and freeze

DSH 3.x remains in the same repository as preserved legacy history: [`solar`](https://github.com/lisihao/deepseek-solar-harness/tree/solar), [`master`](https://github.com/lisihao/deepseek-solar-harness/tree/master), [tags](https://github.com/lisihao/deepseek-solar-harness/tags), and [Releases](https://github.com/lisihao/deepseek-solar-harness/releases). All existing branches, pull requests, tags, and Releases remain retained. The 27 additional archive branches have been uploaded and their commit identities verified. DSH 3.x development is frozen. See the [source archive and known verification limits](docs/legacy-source-archive.md).

V4 must not copy or move DSH 3.x source into this branch. A future plugin may assess a legacy capability only through the V4 plugin rules and an explicitly authorized migration plan.

## Documentation

- [V4 operating rules](AGENTS.md)
- [Repository transition and preservation record](docs/repo-reorganization.md)
- [Three-loop development workflow](docs/development-loops.md)
- [DSH 3.x extraction candidates](docs/extraction-candidates.md)
- [DSH Codex Subscription integration and migration plan](docs/integrations/dsh-codex-subscription.md)

Unreleased plugin work belongs in `incubator/<name>/`; only an authorized first release moves it to `plugins/<name>/`. The empty directories currently present do not contain plugin implementation or a market index.
