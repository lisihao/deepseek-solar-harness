#!/usr/bin/env python3
"""Controller-only exact OOLONG synth scorer. No dataset/model/network imports.

The two original functions execute without AST rewriting after the complete
upstream file and both function trees pass immutable fingerprints. The external
file's training/network imports and DnD helpers are never executed.
"""
import argparse
import ast
import base64
from datetime import datetime
import hashlib
import json
from pathlib import Path

SOURCE_SHA256 = "247583a3b653b91c39fb88a102460802f1493175b23d05a7217aead0d685c64c"
SOURCE_GIT_BLOB = "5c8113ee360957cff010d27310e844630216b21d"
FUNCTION_SHA256 = {
    "synth_attempt_answer_parse": "42fd8d34ce3792b6772cba0e4f189ffa2d62c5b3e8fdf5e74c02eb19d226a719",
    "synth_process_response": "da6739a02720f3e9cfba6ca2521e8344b8eec3e53969700086c302b409428e98",
}


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def load_functions(source=None):
    """Load exactly the pinned pure scorer functions; reject source drift."""
    if source is None:
        source = base64.b64decode(Path(__file__).with_name("oolong_eval_helpers.py.base64").read_bytes(), validate=False)
    if sha256(source) != SOURCE_SHA256:
        raise ValueError("Official OOLONG source SHA256 mismatch")
    blob = hashlib.sha1(b"blob " + str(len(source)).encode() + b"\0" + source).hexdigest()
    if blob != SOURCE_GIT_BLOB:
        raise ValueError("Official OOLONG Git blob mismatch")
    nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in FUNCTION_SHA256]
    if len(nodes) != len(FUNCTION_SHA256):
        raise ValueError("Official scorer function set mismatch")
    for node in nodes:
        tree = ast.dump(node, include_attributes=False).encode()
        if sha256(tree) != FUNCTION_SHA256[node.name]:
            raise ValueError("Official scorer function AST mismatch: " + node.name)
    # dateutil.parser is the official DATE dependency. Absence is an explicit
    # preparation error; substituting a date parser would change the scorer.
    import dateutil.parser
    namespace = {"ast": ast, "datetime": datetime, "dateutil": dateutil}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "pinned-oolong-synth-functions", "exec"), namespace)
    return namespace


def grade(datapoint, output, model, status="completed"):
    """Keep official content scores and completion-aware scores separate."""
    if not isinstance(output, str) or not isinstance(model, str):
        raise ValueError("Raw output and model identity must be strings")
    if not isinstance(datapoint, dict) or not all(k in datapoint for k in ("answer", "answer_type", "id", "context_window_id", "dataset")):
        raise ValueError("Complete controller-only official oracle required")
    if not isinstance(datapoint["answer"], str) or not isinstance(datapoint["answer_type"], str):
        raise ValueError("Preserve original official answer and answer_type strings")
    if status not in ("completed", "truncated", "budget_exhausted", "timeout", "aborted", "failed"):
        raise ValueError("Unknown trial terminal status")
    functions = load_functions()
    result = functions["synth_process_response"](datapoint, output, model)
    return {"official": result, "official_source_sha256": SOURCE_SHA256,
            "official_source_git_blob": SOURCE_GIT_BLOB, "raw_output_sha256": sha256(output.encode()),
            "terminal_status": status, "completion_aware_score": result["score"] if status == "completed" else 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Controller-only JSON with datapoint, output, model, status")
    parser.add_argument("--out", type=Path, required=True, help="New output path; never overwrites a result")
    args = parser.parse_args()
    value = json.loads(args.input.read_text())
    result = grade(value["datapoint"], value["output"], value["model"], value.get("status", "completed"))
    with args.out.open("x") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
