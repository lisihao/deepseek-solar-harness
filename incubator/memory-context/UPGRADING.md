# Upgrading the Graph Memory adapter

## Current producer boundary

This adapter observes the installed Graph Memory producer's public durable
message provenance, not its implementation. The implementation work used the
observed `graph-memory` `1.6.0-beta.17` DSH producer form:

```text
source.kind     = plugin:graph-memory
source.form     = snapshot
source.sections = [{ name: graph-memory:recall, text: <same message text> }]
```

The package has no npm dependency on Graph Memory and carries no Graph Memory
source patch. Its direct adapter files are `src/index.ts` and
`src/graph-memory.ts`. The latter owns source identification, documented XML
section parsing, selection, Session replacement planning, and the flush
barrier.

## Upgrade procedure

1. Read the candidate producer's published source/form and confirm that it
   still emits the exact source boundary above. Do not infer producer identity
   from marker text.
2. Capture only an approved synthetic fixture, or inspect a private receipt
   read-only. Keep real prompts, credentials, account data, and raw session
   logs out of the repository and public test output.
3. Confirm the documented capsule, navigation, knowledge, and episodic XML
   shapes with the maintained parser. An unknown shape needs an explicit
   source-contract change and regression; do not loosen matching or add a
   general XML regular expression.
4. Run the Graph-specific unit/Session checks, build the package, and run the
   disposable official-CLI fake-adapter probe in both producer/adapter load
   orders. The probe must continue to prove old-snapshot retirement,
   `sourceEventSeqs`, unchanged tool declarations, and no external model call.
5. Perform any install acceptance only when separately authorized. A scratch
   profile probe does not establish App startup, disk-backend restart, or
   user-visible effectiveness.

## Compatibility constraints

The adapter relies on published rc.2 `agent/pre-step`, `agent/request`,
Agent-scoped contexts, `Session.surface`, `Session.append`, and
`ctx.sessions.flush`. Current recall is handled before its batch is committed;
historical records are retired at request admission. If a later DSH version
changes either ordering or the source replacement contract, stop at the named
unsupported/flush boundary and update the adapter with a new focused
regression instead of changing upstream or silently falling back to an old
snapshot.

There are no carried Graph Memory patches, forks, database migrations, or
copied producer sources in this package.

## Hindsight guide adapter

The observed producer is `@vectorize-io/hindsight-coding-agents@0.8.1`.
`src/hindsight.ts` recognizes only the exact generated knowledge and refresh
guide fingerprints, allowing the page count to vary; `src/hindsight-session.ts`
owns source-preserving Session projection and durability. There is no direct
runtime dependency, copied producer implementation or producer patch.

On upgrade, compare the candidate's pure guide output using synthetic empty
and populated page lists, with and without new-goal guidance. Keep custom
`toolGuideExtra` output and factual recall unchanged. Change the fingerprint
allowlist only after reviewing the complete new output and adding synthetic
fixtures. Run the Hindsight projection/Session tests and the built official
CLI fixture, which also proves the factual recall and tools remain available.
Never infer guide identity from a tag or a source name alone. The adapter
must not call the Hindsight service, reflect, embedding or model endpoints
while performing these checks.
