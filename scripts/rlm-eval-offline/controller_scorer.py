#!/usr/bin/env python3
"""Grade scheduled local OOLONG synth outputs using the pinned official functions.

Inputs and the report belong to the controller. This module performs no model,
transport, usage settlement, or trial execution.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path

import official_scorer


def require(condition, message):
    """Reject an inconsistent durable input before publishing a report."""
    if not condition:
        raise ValueError(message)


def sha(raw):
    """Return the SHA256 of the exact file bytes."""
    return hashlib.sha256(raw).hexdigest()


def read_json(path):
    """Read and parse one exact UTF-8 file snapshot."""
    raw = Path(path).read_bytes()
    return raw, json.loads(raw)


def index_unique(rows, key):
    """Index nonempty string identities, rejecting duplicate durable rows."""
    result = {}
    for row in rows:
        value = row[key]
        require(isinstance(value, str) and value, "Invalid " + key)
        require(value not in result, "Duplicate " + key)
        result[value] = row
    return result


def score(source, freeze, schedule, results):
    """Validate frozen identities and grade only supplied terminal raw outputs.

    Missing scheduled trials remain missing. Unknown lifecycle states are not
    terminal outputs and are rejected. Official content credit remains separate
    from the zero completion-aware credit of incomplete terminal trials.
    """
    source, freeze = Path(source), Path(freeze)
    metadata_raw, metadata = read_json(source / "metadata-reviewed.json")
    require(metadata["recordExtractionReviewed"] is True, "Unreviewed record extraction")
    require(metadata["dataset"] == "oolongbench/oolong-synth", "Unsupported benchmark")
    required_files = {"rows.jsonl", "selection.json", "source-manifest.json", "record-map.json", "extractor.py"}
    pins = metadata["files"]
    require(len(pins) == len(required_files) and {p["path"] for p in pins} == required_files,
            "Unexpected source file set")
    snapshots = {}
    for pin in pins:
        raw = (source / pin["path"]).read_bytes()
        require(sha(raw) == pin["sha256"], "Source file drift: " + pin["path"])
        snapshots[pin["path"]] = raw
    require(sha(snapshots["rows.jsonl"]) == metadata["rowsSha256"], "Rows identity mismatch")
    require(sha(snapshots["selection.json"]) == metadata["selectionSha256"], "Selection identity mismatch")
    require(sha(snapshots["extractor.py"]) == metadata["extractorSha256"], "Extractor identity mismatch")
    freeze_raw, manifest = read_json(freeze / "freeze.json")
    public_raw, cases = read_json(freeze / "runner-inputs/cases.json")
    oracle_raw, oracles = read_json(freeze / "controller-only/oracles.json")
    require(manifest["sourceMetadataSha256"] == sha(metadata_raw), "Frozen metadata drift")
    require(manifest["selectionSha256"] == sha(snapshots["selection.json"]), "Frozen selection drift")
    require(manifest["publicSha256"] == sha(public_raw), "Frozen cases drift")
    require(manifest["oracleSha256"] == sha(oracle_raw), "Frozen oracle drift")
    require(manifest["dataset"] == metadata["dataset"] and manifest["revision"] == metadata["revision"],
            "Frozen source revision mismatch")
    rows = [json.loads(line) for line in snapshots["rows.jsonl"].decode().splitlines()]
    row_index = index_unique([{**r, "case_id": str(r["id"])} for r in rows], "case_id")
    case_index = index_unique(cases, "case_id")
    oracle_index = index_unique(oracles, "case_id")
    selection = json.loads(snapshots["selection.json"])
    picks = index_unique([{**r, "case_id": str(r["id"])} for r in selection["cases"]], "case_id")
    require(set(case_index) == set(oracle_index) == set(picks), "Frozen case set mismatch")
    require(manifest["caseCount"] == len(cases), "Frozen case count mismatch")
    for key, case in case_index.items():
        row, pick = row_index[key], picks[key]
        require(case["benchmark"] == "oolong", "Unsupported scheduled benchmark")
        require(case["context"] == row["context_window_text"] and case["question"] == row["question"],
                "Original input text mismatch")
        require(case["dataset"] == row["dataset"] == pick["dataset"]
                and case["context_window_id"] == row["context_window_id"]
                and case["context_len"] == row["context_len"] == pick["context_len"]
                and case["partition"] == pick["partition"] and row["split"] == pick["split"],
                "Original input metadata mismatch")
        require(case["input_sha256"] == sha((case["context"] + "\n" + case["question"]).encode()),
                "Original input hash mismatch")
        require(oracle_index[key]["answer_type"] == row["answer_type"], "Original answer type mismatch")
        require(oracle_index[key]["gold"] == ast.literal_eval(row["answer"]), "Original oracle mismatch")
        require(case["metric"] == pick["metric"] == oracle_index[key]["metric"], "Frozen metric mismatch")
    schedule_raw, schedule_data = read_json(schedule)
    require(schedule_data["cases_sha256"] == sha(public_raw), "Scheduled cases drift")
    trials = index_unique(schedule_data["trials"], "trial_id")
    require(trials, "Empty schedule")
    for trial in trials.values():
        case = case_index[trial["case_id"]]
        require(all(trial[k] == case[k] for k in
                    ("input_sha256", "benchmark", "cluster_id", "partition")),
                "Scheduled input identity mismatch")
    results_raw = Path(results).read_bytes()
    supplied = [json.loads(line) for line in results_raw.decode().splitlines()]
    result_index = index_unique(supplied, "trial_id")
    require(set(result_index) <= set(trials), "Unscheduled trial output")
    graded = []
    for value in supplied:
        trial = trials[value["trial_id"]]
        require(value["case_id"] == trial["case_id"]
                and value["input_sha256"] == trial["input_sha256"], "Result input identity mismatch")
        require(isinstance(value["model"], str) and value["model"], "Missing recorded model identity")
        # grade validates terminal status and raw output without normalizing it.
        result = official_scorer.grade(row_index[value["case_id"]], value["output"],
                                       value["model"], value["status"])
        graded.append({"trial_id": value["trial_id"], "case_id": value["case_id"],
                       "input_sha256": value["input_sha256"], **result})
    return {"scope": "pinned_oolong_synth_controller_only",
            "official_source_sha256": official_scorer.SOURCE_SHA256,
            "official_source_git_blob": official_scorer.SOURCE_GIT_BLOB,
            "adapter_sha256": sha(Path(__file__).read_bytes()),
            "inputs": {"metadata_sha256": sha(metadata_raw), "rows_sha256": sha(snapshots["rows.jsonl"]),
                       "freeze_sha256": sha(freeze_raw), "schedule_sha256": sha(schedule_raw),
                       "results_sha256": sha(results_raw)},
            "expected_trials": len(trials), "supplied_trials": len(supplied),
            "missing_trial_ids": sorted(set(trials) - set(result_index)), "results": graded,
            "usage_accounting": "not_performed", "os_isolation_certified": False,
            "experimentReady": False, "paidLaunchAllowed": False}


def main():
    """Write one new controller report only after all inputs pass validation."""
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "freeze", "schedule", "results", "out"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    report = score(args.source, args.freeze, args.schedule, args.results)
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
