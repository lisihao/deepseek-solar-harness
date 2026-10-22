# Imported-session memory pilot

Preview-only tooling for distilling already imported Codex and Claude Code conversations. It reads the DSH import registry and the corresponding DSH journals, not the original agents' credential or memory directories. It does not install a plugin, change the Desktop profile, run tools from transcripts, or write to Hindsight.

Requires Python 3 and the existing `zstd` executable for compressed journals. No dependency installation is needed. Keep generated plans, responses and review reports outside this public repository: they contain private conversation excerpts. Output files are owner-readable only.

## Prepare and inspect

```sh
python3 tools/session_memory/pilot.py prepare \
  --home "$HOME/.dsh" --count 10 --out /absolute/private/pilot-directory
python3 tools/session_memory/pilot.py preview \
  --plan /absolute/private/pilot-directory/plan.json
```

Only registry entries whose authoritative format is `codex` or `claude` are eligible by default. The pilot requires at least three visible messages and 1,000 clean characters and excludes named connection/protocol probes. The deterministic selection balances origin, workspace diversity and clean-text length. It is a purposive pilot, not a statistically representative sample. Superseded import copies are excluded; distinct forks may still overlap and must not be counted as independent incidents.

The plan freezes the exact model request and records source SHA-256, session identity, message sequence and excerpt offsets. Large conversations use bounded fragments: first request, recent corrections and passages mentioning failures, corrections or verification. Coverage is explicit; an excerpted session is not a full-history review. Do not silently interpret an unchanged source file path as an unchanged conversation snapshot.

System prompts, runtime snapshots, skill catalogs, reasoning and tool blocks are excluded. Obvious secrets are redacted, but heuristic redaction is not a guarantee that every sensitive value is found. Inspect the private plan before sending it. User and assistant claims keep their provenance; candidates cannot establish that an implementation or test actually succeeded.

## Authorized extraction only

```sh
python3 tools/session_memory/pilot.py extract \
  --plan /absolute/private/pilot-directory/plan.json --budget-cny 2
python3 tools/session_memory/pilot.py report \
  --plan /absolute/private/pilot-directory/plan.json
```

The runner uses `DEEPSEEK_API_KEY` from the invoking environment without printing it. It sends one direct request per selected session to `https://api.deepseek.com/chat/completions`, using `deepseek-flash`, no tools, no streaming, thinking disabled and a capped output. The user must authorize sending the specific reviewed private excerpts to that endpoint, in addition to approving the paid-call budget. The HTML preview performs no network I/O and escapes transcript markup. The runner never inherits the App's system prompt, persona, memory hooks or skill catalog. It does not set the user's App model or effort.

The entire plan must fit the supplied cap before the first call. Admission reserves two tokens per serialized UTF-8 request byte plus 4,096 framing tokens, capped output, peak prices and a 10% price margin. This is a conservative engineering allowance, not an exact tokenizer count or a vendor billing guarantee. Pricing assumptions must be rechecked before later paid runs. The pilot rejects budgets above CNY 2; it cannot buy retries or extra sessions from unused allowance.

Each call is durably marked started before submission. Completed calls are reused. A timeout, malformed answer, invalid quote, truncated completion or interrupted attempt stops the run and prevents automatic replay. Keep the ledger and original response to reconcile the original attempt; do not erase them to get another attempt. Missing usage retains the full allowance and is never treated as zero. A response reporting usage above its allowance stops subsequent calls. Reports label cost as an estimate, separate from a settled account bill.

Every candidate needs verbatim evidence from the selected session and remains `pending-human`. The report includes scope, uncertainties and excerpt coverage. Exact same-scope repeated rules are identified in the report; semantic duplicates, contradictions, stale facts and independence of incidents require review. There is deliberately no Hindsight import command in this pilot: user confirmation of the actual candidates is a separate boundary.

## Reference and verification

The reference principle is rule, reason and evidence, described in [yetone/magpie LESSONS.md](https://github.com/yetone/magpie/blob/main/LESSONS.md). This is not a claim to reproduce a Magpie historical-session extraction feature. No Magpie code is copied or executed. Hindsight's installed coding-agent documentation states that historical conversation ingestion re-extracts transcripts and consumes tokens; writing candidates to Hindsight is not a free file copy.

Run the focused synthetic gate:

```sh
python3 -m unittest discover -s tools/session_memory -p 'test_*.py' -v
```

The fake executor tests have no keys or model calls. Real pilot receipts and private extracted data are kept separately from source checks and never committed. This script does not prove improved agent performance or memory recall; those require separately authorized downstream validation.
