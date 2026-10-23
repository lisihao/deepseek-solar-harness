# Hindsight score adapter

Unreleased plugin for official Harness 0.2.1-rc.2, Cordis 4.0.5, Memory Spaces
0.5.22 and its Hindsight Provider 0.5.6. It requires the existing Mnemon bundle.

Hindsight's final ranking score is not calibrated confidence. The published
driver labels it normalized relevance; a relevant score below the configured
confidence threshold can disappear from ordinary search. This adapter delegates
the unmodified driver and declares `provider-native` scores. Numbers, ranking,
transport, cancellation and returned content are preserved. The unchanged
strict policy displays unknown confidence and normally keeps up to two results
per bank. It does not establish that every returned result is relevant.

The bundle uses the existing Memory Spaces Source's public `providers`
configuration. Against Mnemon 0.5.32's default nine-child composition, only the
Hindsight module reference changes. The Source implementation/identity and other
eight children stay intact. Removing this bundle restores the original
configuration. Custom Provider lists require explicit composition and are not
covered by this bundle. No App build, runtime patch or database migration is
involved. Do not independently mount this Provider as a Source.

Configuration is the existing Source configuration. Existing Host timeout,
quality thresholds and workspace isolation remain Host settings. This plugin
writes no files, reads no credentials, adds no model messages/session events,
and contains no imported memories. Bank connections are maintained separately
in Mnemon's supported per-workspace metadata.

## Development and verification

Run `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm test:plugin` from this
package. Tests use synthetic results and a disposable Harness home; the plugin
test installs built `lib/` through the official CLI and boots plain Node.
Installed-App acceptance was completed on 2026-10-23 with the identified built
archive. A temporary read-only plugin used the running official App Host's normal
`mnemonRemote.read(search)` endpoint for twelve previously frozen questions,
with only query, limit and workspace parameters. All twelve retained their
expected fact provenance in the results, with no batch filter. Runtime settings
reported a 60,000 ms timeout, workspace isolation and unchanged strict thresholds.
All returned Hindsight results were unknown-confidence and capped at two per bank.
The three approved project routes each exposed only their own active Hindsight
bank. These are scoped recall results, not a guarantee for arbitrary questions,
a visual UI test, or a test of automatic prompt injection.

The temporary acceptance plugin was removed afterwards; the adapter's nine
installed package files still matched the accepted archive, and the existing
plugin entry files, user patch and global Native data hashes were preserved.
The acceptance plugin called no generation model, retain/import or session API.
Private queries, results and provenance stay outside the repository. A scratch
test or an enabled listing alone is not installed-App acceptance.

Install only an identified tarball from a fixed location while the App is fully
quit. User approval is required. This candidate is not a market release.
