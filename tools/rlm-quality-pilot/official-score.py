"""Parent-only loader: run the unchanged pinned OOLONG numeric scorer functions.

No imports or other top-level code from the upstream module are executed. This
avoids installing its unrelated provider/tokenizer dependencies. The complete
original module remains unmodified and hash-pinned outside the worker sandbox.
"""
import ast
import hashlib
import json
import sys
from pathlib import Path

PINNED_SHA256 = "247583a3b653b91c39fb88a102460802f1493175b23d05a7217aead0d685c64c"


def main():
    payload = json.load(sys.stdin)
    source = Path(payload["sourcePath"]).read_bytes()
    if payload["expectedSha256"] != PINNED_SHA256 or hashlib.sha256(source).hexdigest() != PINNED_SHA256:
        raise ValueError("OOLONG_SCORER_HASH_MISMATCH")
    datapoint = payload["datapoint"]
    if datapoint["answer_type"] != "ANSWER_TYPE.NUMERIC":
        raise ValueError("OOLONG_SCORER_NUMERIC_ONLY")
    gold = ast.literal_eval(datapoint["answer"])
    if not isinstance(gold, list) or len(gold) != 1 or type(gold[0]) is not int:
        raise ValueError("OOLONG_SCORER_INVALID_GOLD")
    names = {"synth_attempt_answer_parse", "synth_process_response"}
    selected = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in selected} != names or len(selected) != 2:
        raise ValueError("OOLONG_SCORER_FUNCTIONS_MISSING")
    namespace = {"ast": ast}
    exec(compile(ast.Module(body=selected, type_ignores=[]), payload["sourcePath"], "exec"), namespace)
    result = namespace["synth_process_response"](datapoint, payload["output"], "openai-codex/gpt-6.1-sol/high")
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)


if __name__ == "__main__":
    main()
