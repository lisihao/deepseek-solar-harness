# Bounded ARC workflow pilot

This manual evaluation runner compares the frozen ordinary game-tools baseline (B), direct original Prime (R), and the Solar plugin (S). The approved cases, prompts, limits and interpretation are in [`prime-rlm-arc-pilot-plan.json`](../../docs/testing/prime-rlm-arc-pilot-plan.json). The original ARC protocol forbids subagents. R/S therefore load native `rlmMaxDepth: 0` before the first prompt; this panel cannot establish a recursion-specific benefit.

The cumulative model-request cap is 522, including 138 retained historical charges (135 confirmed and 3 unknown). Each of twelve conditions has at most 32 physical requests. No retry, failed-condition replay, paid API fallback or credit purchase is enabled. B and R/S have separately frozen prompts: B versus S compares the complete workflows, including guidance, Python and autonomous execution. It does not isolate the effect of any one mechanism.

## Zero-model checks

`pnpm test:arc` runs portable synthetic checks for message/replay handling, official durable image storage, guarded broker behavior, independent scoring and durable logical/physical admission. It does not import the private provider or credentials. `pnpm test:arc:native` is a separate Node 22 macOS sandbox/IPC boundary check; it does not by itself prove that Prime and Python run inside that sandbox.

On macOS arm64, use Node 22 for the manual runner:

```sh
node tools/rlm-arc-pilot/run.mjs --prepare --output /private/tmp/rac-example --author-preparation /private/tmp/previous-arc-preparation
node tools/rlm-arc-pilot/run.mjs --keyless --output /private/tmp/rac-example
```

After preparation, the separate native engine smoke can use the prepared shared runtime and the pinned author/corpus preparation:

```sh
node tools/rlm-arc-pilot/native-acceptance.mjs --shared /private/tmp/rac-example/shared --author /private/tmp/pinned-author-checkout --author-preparation /private/tmp/previous-arc-preparation
```

It uses the excluded ar25 smoke game and deterministic local responses, and checks actual inherited Python denials and image readback. It does not solve or model-test any of the four frozen games.

These are examples; both paths must refer to the intended local preparation. `prepare` requires a new short output path, verifies the fixed author checkout and exact corpus hashes, compiles the current adapter, validates the offline capsule, restores historical accounting into a separate ledger, and freezes all condition directories/order/prompts. It does not download, install dependencies, load a provider or read credentials. `keyless` exercises the actual compiled message codec and synthetic score/budget controls. Both modes retain failed evidence.

## Real execution boundary

Only `--run` loads the explicitly supplied private provider module and credential file. It requires the module SHA-256, existing provider-package path, and a separate accepted receipt bound to the complete prepared fingerprint. Before accepting that receipt, the operator must inspect actual original-Prime and plugin runs with a persistent Python cell, the guarded game endpoint, inherited file/network denial and owned-process cleanup. A pure Node socket probe or a fixture WIN is insufficient.

```sh
node tools/rlm-arc-pilot/run.mjs --run --output /private/tmp/rac-example \
  --provider-module /private/tmp/private-provider.mjs --provider-sha256 VERIFIED_SHA256 \
  --provider-package /absolute/path/to/existing-provider --credential-file /absolute/path/to/existing-credentials \
  --acceptance-artifact /private/tmp/accepted-receipt.json --acceptance-sha256 VERIFIED_SHA256
```

The private provider adapter is deliberately not distributed here. Its separately verified route must preserve Codex `gpt-6.1-sol / high / 16384`, disable provider/SDK retries, expose synchronous physical admission before every model POST, and use the supplied official attachment store. The runner records full model intents/chunks locally, counts requests before dispatch and stops on unresolved effects or failed cleanup. A durable panel start marker prevents automatic replay.

R/S execute inside a per-condition macOS sandbox. Only the assigned `guard.sock`, native IPC and a fixed local model-relay port are available. The parent holds the corresponding IPv6 port with a rejecting listener. Game implementation files, other conditions, private provider state, credentials and the trusted engine socket remain outside the worker's readable namespace. Prime, Python, the author source and the ARC SDK are not patched. The explicit SDK `step` facade is an evaluation-only compatibility adaptation documented in the [protocol record](../../docs/testing/prime-rlm-arc-protocol.md).

## Results

```sh
node tools/rlm-arc-pilot/run.mjs --analyze --output /private/tmp/rac-example
```

The trusted parent reads the original broker's state; model text never awards a WIN. All four games remain in each arm's denominator, including unrun/failed cells. A confirmed WIN remains recorded if later execution or cleanup fails; completion and cleanup are separate fields. The runner retains raw private evidence and produces `analysis.json` and `analysis.md` from the same receipts and ledger. It does not calculate RHAE, certify historical author-result reproduction, or claim general reasoning improvement. Do not commit the corpus, credentials, model traces or generated runtimes.
