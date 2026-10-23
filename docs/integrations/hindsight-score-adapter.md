# Hindsight score contract adapter

Authorized on 2026-10-23 after the user reviewed the observed 11/12 App result
and the frozen-response 12/12 candidate comparison. Installation and real App
verification were explicitly included. This is a plugin-only repair.

## Inputs and boundary

- Integrated project: https://github.com/omdsh-dev/dsh-mnemon
- Published inputs: `dsh-mnemon-provider-hindsight@0.5.6` and
  `dsh-mnemon-source-memory-spaces@0.5.22`, both MIT; official Harness
  `0.2.1-rc.2`, Cordis `4.0.5`.
- Read the installed published JavaScript, declarations, bundle configuration,
  and licenses before designing this adapter. No source is vendored or patched.
- The Hindsight driver declares `normalized-relevance`, but forwards the server's
  final ranking score, including boosts. Observed scores can exceed one; a
  relevant result below 0.25 is rejected by the host's `strict-v1` policy.

## Implementation

An unreleased bundle under `incubator/hindsight-score-adapter` uses the existing
Memory Spaces entry's public `providers` configuration through the official
profile patch layer. Only the Hindsight module reference changes in the default
nine-child composition of Mnemon 0.5.32; the remaining eight entries are checked
against that published bundle. The Source implementation, identity and storage
locations stay intact. Custom Provider lists require separate explicit
composition and are not covered by this candidate.

The adapter delegates the original driver's methods unchanged, omits the runtime
normalized-score promise and declares `provider-native` in its own manifest.
It preserves result bytes, scores, ordering, URLs and cancellation. Under the
unchanged `strict-v1` policy these are unknown-confidence results, capped by the
existing `maxUnknownResults` (normally two per bank). This repairs a score
contract; it does not calibrate relevance or prove unrelated queries return no
results. It does not improve memory content or call a generation model.

No Python runtime, new embedding/reranker, credentials, cloud service or database
migration is introduced. The already installed local Hindsight service and its
three approved project-bank connections remain separately owned configuration.
The plugin writes no data and adds no session events or model messages.

## Acceptance

1. Synthetic regression: original normalized-score declaration drops a relevant
   low numerical score; the adapter preserves the score and returns it as
   unknown confidence. The default unknown-result cap remains effective.
2. Verify unchanged transport, response ordering and cancellation delegation;
   compare every other Provider declaration against the pinned default bundle.
3. Build and strict type checks; official CLI installs the built tarball into a
   disposable home and boots it under plain Node. Exercise the actual Source
   loader and verify removal restores the original Source entry.
4. Install only the identified tarball after explicit App ownership handback and
   a fresh profile backup. Read the real Host timeout and project routes, then
   run the original twelve ordinary queries without batch/body/document filters.
   Verify retained facts or observation provenance. Preserve all failures.

No official-upstream contribution, merge, release, tag or market publication is
authorized. Public source/test fixtures contain synthetic data only; private
queries, imported memories, paths, runtime receipts and backups stay outside Git.

## Recorded installed acceptance (2026-10-23)

The exact behavior archive from source commit
`6a2f8a1d66f32898f620ff7e34c6c02605994088` was installed through the official
Desktop CLI after explicit App ownership handback and a fresh profile backup.
Its SHA-256 was
`f3fdc232d182c09fb0b5655193a1631d94a8c6f834a1c0400e3196d643d3d02c`.
The runtime package files matched that archive; package.json was checked against
its actual packed bytes, not source JSON formatting.

The running App Host executed the twelve original ordinary queries across three
isolated project routes. All twelve matched retained fact provenance without a
batch, body or document filter. Runtime timeout was 60,000 ms; strict-v1 thresholds
remained 0.25/0.6 and maxUnknownResults remained 2. Every returned result was
unknown-confidence, with at most two per bank. No unexpected provider or expected
fact from another project was returned. The adapter preserves raw scores/order;
this acceptance does not calibrate confidence or establish arbitrary-query
precision, visual UI behavior or automatic memory injection.

The temporary probe was removed through the official CLI. The nine remaining
adapter files still matched the archive; original plugin entries, user patch
and global Native data were preserved. The probe invoked no generation model,
retain/import or session API. Private queries, observation provenance, backups
and raw runtime receipts are excluded from Git.
