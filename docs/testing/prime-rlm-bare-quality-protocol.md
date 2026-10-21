# Bare model versus full RLM: fixed original OOLONG case

Date: 2026-10-21, Asia/Shanghai. This experiment follows the user's direct instruction to establish whether full RLM can produce a better answer than the bare model before deriving task routing or cost conditions.

The observable target is a completed, independently graded pair on the same original material and question: full RLM has a higher official score than the bare model. A successful fixture, a running plugin, or observed child calls alone does not satisfy this target. One positive case would establish an observed instance, not a general improvement rate, statistical significance, or a guarantee. A tie or negative result is retained without changing this question and trying again.

## Frozen case

Use the official [OOLONG synthetic dataset](https://huggingface.co/datasets/oolongbench/oolong-synth/tree/616cca899e8b51ea0ad5446ebab39aa72b3192bc), revision `616cca899e8b51ea0ad5446ebab39aa72b3192bc`, from the paper period. The selected validation row is TREC `id=16000219`, `context_window_id=3`, `context_len=65536`, in `data/validation-00005-of-00007.parquet`, row index 36. Its shard SHA-256 is `8c0d27a796b471b93cd9323646f80a1b1216f88e16612cfb67df1bbe33dbae4b`.

The question is unchanged:

> In the above data, how many data points should be classified as label 'description and abstract concept'? Give your final answer in the form 'Answer: number'.

The public material is the row's original `context_window_text`, 153459 UTF-8 bytes, SHA-256 `03225188cce633b40f4ec6c96a3979969dadb3c60b6d494449493912a0cb82bb`. Never provide `context_window_text_with_labels`, the gold answer, scorer, another arm's output, or earlier experimental outcomes to either arm. Selection and this protocol precede both new model outcomes. This is an original numeric TREC benchmark item, unlike the earlier custom MultiNLI aggregation tasks.

## Arms and accounting

Both arms use the installed Codex subscription provider, `openai-codex/gpt-6.1-sol`, reasoning `high`, maximum output 16384, with no API fallback, credit purchase, or provider retries.

| Arm | Model-visible input and tools | Maximum new requests |
| --- | --- | ---: |
| D, bare model | One user message, `context_window_text + "\n" + question`, no system instructions and no tools | 1 |
| S, full RLM | The same context bytes in `inputs/context.txt`, the unchanged question, and the answer-file contract; original Prime persistent Python and native depth-one recursion | 14 for the complete tree |

Run D then S once. The extra RLM computation is intentional: this comparison asks whether spending more computation improves the answer. It does not isolate the contribution of recursion from REPL/tools, prompt scaffolding, or context management. The earlier S0/S comparison remains the separate recursion-specific negative result. Record actual descendant calls, the root's use of their results, and full prompts rather than assuming recursion happened.

Continual Harness state starts fresh and refinement/Factory learning stays disabled equally for this quality comparison. This does not remove or rewrite those original mechanisms. The model chooses its decomposition; the parent supplies no gold-derived partition or successful solution strategy.

The retained prefix is 506 charged requests, comprising 495 confirmed and 11 unknown. This phase admits at most 15 additional requests, reaching at most 521 under the user's unchanged cumulative cap of 522. Every admitted root or descendant call counts; transport unknowns are not refunded. New namespace, one-shot markers and prior closure receipts prevent accidental replay or budget reset. An unresolved external effect or failed cleanup stops subsequent admission.

## Independent scoring and validity

Use the official [OOLONG evaluator](https://github.com/abertsch72/oolong/blob/0bb7eabe839218fee7fe8d007f41cfc2fd3ae24c/src/eval/eval_helpers.py), commit `0bb7eabe839218fee7fe8d007f41cfc2fd3ae24c`, complete file SHA-256 `247583a3b653b91c39fb88a102460802f1493175b23d05a7217aead0d685c64c`. The parent compiles its unchanged `synth_attempt_answer_parse` and `synth_process_response` AST functions. It skips unrelated top-level provider/tokenizer imports and permits only the numeric branch; it does not replace the scorer's parsing or formula. This loader boundary is a documented adaptation, not use of the entire official runner.

Score the bare assistant's final content and the RLM answer file's string with the same functions, without an arm parameter. Preserve both raw answers, parsed values, exact match and numeric score. The official numeric score is `0.75 ** abs(gold - parsed_integer)`. A missing or malformed answer is recorded as such, not silently converted to a valid zero. Infrastructure failure, provider context rejection and an uncompleted run are separate from answer quality and cannot establish an RLM win.

The bare provider stream must reach EOF before offline message decoding, so usage/settlement after a finish chunk is not lost. RLM input bytes must remain unchanged. Root/child provider access passes through the same parent ledger, while the native sandbox denies direct public-network calls, input writes, private gold and credentials.

The original [RLM paper](https://arxiv.org/abs/2512.24601) used other model configurations and budgets. This is a transfer test of an original task and scorer to the authorized model and original Prime mechanisms, not a numerical reproduction of the paper's table.

## Acceptance and scope

Affected paths are `tools/rlm-quality-pilot/`, this protocol and its result report, and package scripts that select these checks. Prime, production plugin code/defaults and installed bytes are unchanged. Before a real call: test the new runner's full-input/no-tools request, EOF settlement, whole-tree cap and one-shot preflight; validate the official scorer with known-answer mutations; bind exact source, public task, scorer, runtime and keyless evidence hashes. Reuse the already accepted native depth-one/sandbox proof only while its mechanism sources, compiled bundle and offline runtime match.

Private artifacts retain source rows, gold, provider transcripts, credentials references and native state locally. Committed reports contain only the necessary sanitized provenance and measurements. No installed-app change, merge, release, market publication, Jev restoration or recurring automation is part of this experiment.

The pre-dispatch `pnpm check` passed build, strict typecheck, existing unit/ARC/recursion checks, all eleven new quality checks, scratch-profile registration/runtime availability, and the generated homepage check. The new checks cover bare full-input/no-tools and EOF consumption, the raw bare answer's grading path, public native-start projection, preflight before provider loading, retained unknown/missing output, and the complete D1 plus fourteen-S hard limit. The separate official-scorer mutations passed exact, one-off, two-off and unparsable cases. The older full native self-test was not rerun; its hash-bound depth-one/sandbox evidence is reused for the unchanged mechanism.
