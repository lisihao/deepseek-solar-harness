# DSH Scheduling Evidence Collectors

English | [中文](README.zh.md)

Python collectors for the public model evidence that DSH scheduling reads: `codex_radar_provider` (Codex Radar) and `ai_frontier_provider` (AI Frontier). They are copied unchanged from Codex Workbench and keep their own SQLite generation store, so a failed fetch or an invalid payload never replaces the last valid generation. This directory is not published and not installed with pip.

## Requirements

Python 3.11 or newer and the standard library only. Put `src` on `PYTHONPATH`; nothing else is configured.

## Command line

Each collector is a module with a JSON command line. Every command takes `--state-root`, prints one JSON line, and exits nonzero when the result is not `ok`.

```sh
export PYTHONPATH=python/scheduling-evidence/src
python3.12 -m codex_radar_provider.cli --state-root "$DSH_HOME/scheduling/radar" status
python3.12 -m ai_frontier_provider.cli --state-root "$DSH_HOME/scheduling/ai-frontier" status
```

`status` and `show` read the stored generations. `consent`, `refresh`, and `import` write them, and `refresh` and `import` require an authorization file that the owner supplies. Only `refresh` uses the network, and each collector enforces its own minimum refresh interval. Nothing in this directory starts a collector on a schedule; the scheduling Consumer owns that.

## Provenance

The sources are the Codex Workbench main at `b358d53978ebc90c53e842c1626011cf40e73b6a`. [The source manifest](../../distribution/workbench-scheduling-sources.json) records each file's sha256, and `tests/test_source_manifest.py` fails when a copied file differs from it. The Radar collector derives from `wineandchord/codex-radar`, whose MIT notice is in `LICENSE-WineChord-Codex-Radar`.

## Tests

```sh
cd python/scheduling-evidence
PYTHONPATH=src python3.12 -m unittest discover -s tests
```

The 27 collector tests run against local fixtures and need no network. CI runs them on Python 3.12.

## Known Limitations and Deferred Work

- The collectors fetch only from the public Codex Radar and AI Frontier endpoints recorded in their sources, which were not contacted while copying; a changed upstream schema fails the import without replacing stored data.
- Nothing here classifies, ranks, or selects a model. The allocator consumes the stored generations through a later TypeScript package.
