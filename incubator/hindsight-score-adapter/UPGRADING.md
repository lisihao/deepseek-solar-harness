# Upgrade boundary

The package pins `dsh-mnemon-provider-hindsight` 0.5.6 and
`dsh-mnemon-source-memory-spaces` 0.5.22 as shared peer and development inputs.
`src/provider.ts` delegates the Provider definition. `src/index.ts` exports that
Provider child. The patch changes the Hindsight reference in the public
`providers` list on the existing `mnemon-source-memory-spaces` entry. Its other
eight entries match the default composition of pinned `dsh-mnemon` 0.5.32.

1. Adapter override: the Hindsight manifest uses `provider-native`; the delegated
   adapter omits `scoreSemantics`. Reason: server final scores are ranking
   values, not a calibrated 0..1 confidence. No integrated-project source patch
   is carried. No external issue was submitted.

For an upgrade, inspect the driver's final-score mapping and score contract,
the Source's unknown-score cap, Provider module API and bundle configuration.
Compare the complete default Provider list to the patch before changing pins;
custom lists are outside this bundle's tested scope.
Update pins only after the synthetic score/cancellation/preservation regressions
and the built/plain-Node CLI install/remove test pass. Repeat actual App
ordinary-search acceptance for changed inputs. Remove this override when the
integrated Provider accurately declares its server's score semantics.
