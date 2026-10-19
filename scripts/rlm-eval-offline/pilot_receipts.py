#!/usr/bin/env python3
"""Validate local fake Worker/Runtime receipts before deriving scorer inputs.

Hashes bind retained observations, not an independent signature or model benefit.
No execution, transport, usage settlement, or retry occurs in this reader.
"""
import argparse
import json
import tempfile
from pathlib import Path

from controller_scorer import index_unique, read_json, require, score, sha
from pilot_preprocess import prepare

MODEL = "scripted-offline-model"
SOURCE = "actual-loader-worker-runtime/scripted-inprocess-adapter"
ARMS = {"codeact_bm25": ("full", "none"), "chunk_map_reduce": ("chunks", "root-only"),
        "rlm_nosub": ("external", "none"), "rlm_full": ("external", "recursive")}
CAPS = {"inputTokens": 200000, "outputTokens": 16000, "httpAttempts": 24,
        "concurrentRequests": 1, "maxOutputTokensPerRequest": 4096}
RUNTIME_LIMITS = {"maxDepth": 2, "maxChildren": 8, "maxTurns": 16,
                  "maxCellMs": 10000, "maxOutputBytes": 8192}
PREPROCESS_DEPENDENCIES = {
    "preprocessing.py": "766f794e40888017fbe9ed7d67cdbdec5d2b64254e70668784ed3010b83e1ce9",
    "arm_adapter.py": "2f7630571737c228d5feda7d8cc7ad4c25a7a8d9c43d2c42e5915916d02510c6",
    "budget.py": "1dd577f9c0d270f4ab7b9a3fc7d7e2bcddc3066f3e63ef431a8c89619c776e82",
}


def verify_dependencies():
    """Bind recomputation to the retained pre-execution algorithm snapshot."""
    for name, expected in PREPROCESS_DEPENDENCIES.items():
        require(sha(Path(__file__).with_name(name).read_bytes()) == expected, "Preprocessing source drift: " + name)


def text(blocks):
    """Preserve the order and complete bytes of final text blocks."""
    return "".join(b["text"] for b in blocks if b["type"] == "text")


def within(root, relative):
    """Resolve only a retained file inside this bundle."""
    path = (root / relative).resolve()
    require(path.is_relative_to(root.resolve()), "Receipt path escapes bundle")
    return path


def ordered(start, end):
    """Check same-process monotonic ordering, retaining raw UTC observations."""
    require(isinstance(start["at"], str) and isinstance(end["at"], str)
            and start["monotonicMs"] <= end["monotonicMs"], "Observation order mismatch")


def verify_trial(report, trial, case, preparation):
    """Bind all requests and children; derive lifecycle from retained facts."""
    r = report
    require(r["trial"] == trial and r["model"] == MODEL, "Trial/model mismatch")
    require(r["source"] == SOURCE and r["fakeOnly"] is True
            and r["fakeUsageOnly"] is True and r["paidLaunchAllowed"] is False
            and r["experimentReady"] is False, "Unsupported producer or launch claim")
    require(r["preparation"] == preparation, "Preprocessing mismatch")
    require(r["caseIdentity"] == {"case_id": case["case_id"], "input_sha256": case["input_sha256"],
            "contextSha256": sha(case["context"].encode()), "questionSha256": sha(case["question"].encode())},
            "Case identity mismatch")
    placement, spawn = ARMS[trial["arm"]]
    require((r["placement"], r["spawnPolicy"]) == (placement, spawn), "Arm policy mismatch")
    require(r["limits"] == RUNTIME_LIMITS and r["scope"]["scope"]["limits"] == CAPS
            and r["toolExecution"] == {"version": 1, "maxToolRounds": 4}
            and r["inputBound"] == "request-bytes-audited", "Fake caps changed")
    ordered(r["started"], r["finished"])
    workers = index_unique(r["workers"], "commandId")
    roots = [w for w in workers.values() if w["identity"]["role"] == "root"]
    require(len(roots) == 1, "Missing or duplicate root Worker")
    root = roots[0]
    require(root["sessionId"] == r["sessionId"] == "pilot-" + trial["trial_id"], "Root session mismatch")
    sessions = index_unique([dict(s, sessionId=s["snapshot"]["sessionId"])
                             for s in r["runtime"]["sessions"]], "sessionId")
    require(set(sessions) == {w["sessionId"] for w in workers.values()}, "Orphan Runtime session")
    for worker in workers.values():
        identity = worker["identity"]
        require(all(identity[k] == trial[k] for k in ("trial_id", "case_id", "input_sha256", "arm"))
                and worker["model"] == MODEL, "Worker identity mismatch")
        require(worker["commandId"] == worker["sessionId"] + ":worker", "Worker command mismatch")
        if "result" in worker:
            require(worker["result"].get("stopReason") in ("completed", "aborted", "error", "max-tokens", "refusal"),
                    "Missing or unknown Worker stopReason")
        require(worker["prompt"][0]["text"].startswith("PILOT_META:")
                and json.loads(worker["prompt"][0]["text"].split("\n")[0][11:]) == identity,
                "Actual Worker prompt identity mismatch")
        ordered(r["started"], worker["started"])
        ordered(worker["started"], worker["finished"])
        ordered(worker["finished"], r["finished"])
        snapshot = sessions[worker["sessionId"]]["snapshot"]
        require(snapshot["limits"] == RUNTIME_LIMITS and snapshot["model"]["model"] == MODEL
                and snapshot["depth"] == identity["depth"], "Runtime policy mismatch")
    context = sessions[r["sessionId"]]["context"]
    require(context["corpus"]["sha256"] == sha(case["context"].encode())
            and context["corpus"]["bytes"] == len(case["context"].encode()), "Persistent corpus mismatch")
    require((context.get("rawCorpus") == case["context"]) == (placement == "full")
            and ("rawCorpus" in context) == (placement == "full"), "Persistent placement mismatch")
    require(sessions[r["sessionId"]]["snapshot"]["childSpawnPolicy"] == {
        "version": 1, "mode": spawn, "maxTotalChildren": 0 if spawn == "none" else 8}, "Host spawn mismatch")
    attempts = index_unique(r["ledger"]["state"]["attempts"], "id")
    entries = index_unique(r["entries"], "attemptId")
    physical = index_unique(r["physical"], "attemptId")
    sends = index_unique(r["sends"], "attemptId")
    require(set(attempts) == set(entries) == set(physical), "Attempt observation mismatch")
    require(set(sends) == {k for k, e in entries.items() if e["admitted"]}, "Send/admission mismatch")
    require({e["commandId"] for e in entries.values()} == set(workers), "Orphan Worker/request")
    for worker in workers.values():
        first = next(e for e in r["entries"] if e["commandId"] == worker["commandId"])
        require(first["request"]["messages"][0]["content"] == worker["prompt"], "Worker first request mismatch")
    for key, entry in entries.items():
        attempt, observed = attempts[key], physical[key]
        require(attempt["state"] in ("settled", "unknown", "refused"), "Unfinished or invalid attempt state")
        body = entry["body"].encode()
        require(json.loads(body) == entry["request"] and sha(body) == entry["bodySha256"]
                == attempt["bodySha256"] == observed["facts"]["bodySha256"], "Request body mismatch")
        require(len(body) == attempt["bodyBytes"] == observed["facts"]["bodyBytes"], "Request byte mismatch")
        require(observed["commandId"] == entry["commandId"] and attempt["label"] == entry["label"]
                == observed["label"], "Request owner mismatch")
        require(entry["request"]["model"] == attempt["model"] == observed["facts"]["model"] == MODEL
                and entry["request"]["maxTokens"] == observed["facts"]["maxOutputTokens"] == 4096
                and entry["request"]["reasoningEffort"] == "high", "Generation mismatch")
        owner = workers[entry["commandId"]]
        ordered(owner["started"], observed["observed"])
        ordered(observed["observed"], entry["admissionObserved"])
        for event in observed["events"]:
            ordered(observed["observed"], event)
            ordered(event, owner["finished"])
        kinds = [event["kind"] for event in observed["events"]]
        expected_events = {"settled": ["dispatching", "terminal"], "unknown": ["dispatching", "unknown"],
                           "refused": ["not-sent"]}
        require(kinds == expected_events[attempt["state"]], "Physical terminal event mismatch")
        for earlier, later in zip(observed["events"], observed["events"][1:]):
            ordered(earlier, later)
        if key in sends:
            require(sends[key]["request"] == entry["request"]
                    and sends[key]["bodySha256"] == sha(body), "Send body mismatch")
            require(any(e["kind"] == "dispatching" for e in observed["events"]), "Missing dispatch")
            require(attempt["reservedInput"] == len(body)
                    and attempt["reservedOutput"] == entry["request"]["maxTokens"], "Sent reservation mismatch")
        else:
            require(attempt["state"] == "refused" and any(e["kind"] == "not-sent" for e in observed["events"]),
                    "Unsent lifecycle mismatch")
            require(attempt["reservedInput"] == attempt["reservedOutput"] == 0
                    and "usage" not in attempt, "Refused reservation mismatch")
        if attempt["state"] == "settled":
            require(attempt["usage"] == {"input": 9, "output": 5}
                    and sends[key]["usage"] == {"inputTokens": 9, "outputTokens": 5, "reasoningTokens": 3},
                    "Scripted usage mismatch")
        elif attempt["state"] == "unknown":
            require("usage" not in attempt and "usage" not in sends[key]
                    and any(e["kind"] == "unknown" for e in observed["events"]), "Unknown usage fabricated")
    root_entries = [e for e in r["entries"] if e["commandId"] == root["commandId"]]
    require(root_entries[0]["request"]["messages"][0]["content"] == root["prompt"], "Initial prompt mismatch")
    require(any(b.get("text") == case["context"] for b in root["prompt"]) == (placement == "full"),
            "Actual initial context mismatch")
    require(r["rootResult"] == root.get("result")
            and bool(r["rootError"]) == ("error" in root), "Root result mismatch")
    raw = None if r["rootResult"] is None else text(r["rootResult"]["output"])
    require(r["rawOutput"] == raw and r["rawOutputSha256"] == (None if raw is None else sha(raw.encode())),
            "Raw final output mismatch")
    return verify_runtime(r, trial, case, preparation, workers, attempts, root_entries, raw)


def verify_runtime(r, trial, case, preparation, workers, attempts, root_entries, raw):
    """Check durable cell outcomes and actual child-result consumption."""
    receipts = index_unique(r["runtime"]["receipts"], "commandId")
    calls = {}
    for entry in r["entries"]:
        for message in entry["request"]["messages"]:
            for block in message["content"]:
                if block["type"] == "tool-call":
                    require(block["name"] == "typescript_repl", "Unexpected fake tool")
                    key = entry["commandId"] + ":deepseek-tool:" + block["id"]
                    args = json.loads(block["arguments"])
                    require(key not in calls or calls[key] == args, "Conflicting repeated tool history")
                    calls[key] = args
    cell_ids = set()
    for cell in r["cells"]:
        command = cell["params"]["command_id"]
        require(command not in cell_ids, "Duplicate cell command")
        cell_ids.add(command)
        require(calls.get(command) == cell["params"]["arguments"], "Cell/tool-call mismatch")
        require(cell["params"]["session_id"] in {w["sessionId"] for w in workers.values()}, "Orphan cell")
        receipt = receipts.get(command)
        require(cell["runtimeReceiptState"] == (None if receipt is None else receipt["state"]),
                "Cell durable lifecycle mismatch")
        ordered(r["started"], cell["forwardObserved"])
        if "settledObserved" in cell:
            ordered(cell["forwardObserved"], cell["settledObserved"])
        if receipt is not None and receipt["state"] == "settled":
            require(cell["result"] == receipt["result"], "Cell result mismatch")
    require(cell_ids == set(calls), "Missing or extra executed cell")
    children = index_unique(r["children"], "childSessionId")
    require(set(children) == {w["sessionId"] for w in workers.values() if w["identity"]["role"] != "root"},
            "Child/Worker mismatch")
    for child in children.values():
        require(child["parentSessionId"] in {w["sessionId"] for w in workers.values()}
                and child["depth"] <= 2, "Child parent mismatch")
    stored = index_unique(r["storedResults"], "resultRef")
    read_children = set()
    for read in r["resultReads"]:
        request = read["request"]
        result = stored[request["resultRef"]]
        require(result["childSessionId"] == request["childSessionId"]
                and result["parentSessionId"] == request["sessionId"]
                and result["childId"] == request["childId"], "Child read ownership mismatch")
        require(children[result["childSessionId"]]["parentSessionId"] == result["parentSessionId"],
                "Stored child parent mismatch")
        worker = workers[result["content"]["commandId"]]
        require(result["content"]["output"] == worker["result"]["output"]
                and result["content"]["stopReason"] == worker["result"]["stopReason"], "Child output mismatch")
        # JSON bytes are from JavaScript JSON.stringify, with insertion order retained.
        raw_content = json.dumps(result["content"], ensure_ascii=False, separators=(",", ":")).encode()
        require(read["contentSha256"] == sha(raw_content), "Child read bytes mismatch")
        ordered(worker["finished"], read["observed"])
        read_children.add(request["childSessionId"])
    tools = [b for e in r["entries"] for m in e["request"]["messages"]
             for b in m["content"] if b["type"] == "tool-result"]
    unresolved = any(c["runtimeReceiptState"] in (None, "accepted", "running", "indeterminate") for c in r["cells"])
    failed_cell = any(c["runtimeReceiptState"] == "failed" for c in r["cells"])
    unknown_count = sum(a["state"] == "unknown" for a in attempts.values())
    refused_count = sum(a["state"] == "refused" for a in attempts.values())
    require(unknown_count == r["ledger"]["totals"]["unknown"]
            and refused_count == r["ledger"]["totals"]["refused"], "Ledger lifecycle total mismatch")
    require(len(attempts) - refused_count == r["ledger"]["totals"]["attempts"] <= CAPS["httpAttempts"], "Attempt cap mismatch")
    require(r["ledger"]["totals"]["inFlight"] == 0
            and r["ledger"]["totals"]["outstanding"] == unknown_count, "Outstanding count mismatch")
    settled = [a for a in attempts.values() if a["state"] == "settled"]
    outstanding = [a for a in attempts.values() if a["state"] == "unknown"]
    require(sum(a["usage"]["input"] for a in settled) + sum(a["reservedInput"] for a in outstanding)
            == r["ledger"]["totals"]["input"]
            and sum(a["usage"]["output"] for a in settled) + sum(a["reservedOutput"] for a in outstanding)
            == r["ledger"]["totals"]["output"], "Usage/reservation total mismatch")
    require(r["usageComplete"] == (len(settled) == len(r["sends"])), "Usage completeness mismatch")
    expected = len(preparation["chunks"]) if trial["arm"] == "chunk_map_reduce" else 2 if trial["arm"] == "rlm_full" else 0
    missing = len(children) != expected or any("result" not in w and "error" not in w for w in workers.values())
    tool_errors = sum(bool(b.get("isError")) for b in tools)
    failed = bool(r["rootError"]) or failed_cell or tool_errors or refused_count or missing \
        or bool(r["ledger"]["state"].get("boundViolation")) \
        or any("error" in w or w.get("result", {}).get("stopReason") in ("error", "refusal") for w in workers.values())
    terminal = "unknown" if unknown_count or unresolved else "failed" if failed else \
        "truncated" if any(w.get("result", {}).get("stopReason") == "max-tokens" for w in workers.values()) else \
        "aborted" if any(w.get("result", {}).get("stopReason") == "aborted" for w in workers.values()) else "completed"
    require(r["terminal"] == terminal, "Claimed terminal differs from observations")
    require(r["reasons"] == {"unknownAttempts": unknown_count, "unresolvedCell": unresolved,
            "failedCell": failed_cell, "toolErrors": tool_errors, "missingWork": missing,
            "refused": refused_count, "boundViolation": r["ledger"]["state"].get("boundViolation")}, "Lifecycle reasons mismatch")
    if terminal == "completed":
        require(read_children == set(children) and len(stored) == len(children), "Missing complete child read")
        root_tools = [b for e in root_entries for m in e["request"]["messages"]
                      for b in m["content"] if b["type"] == "tool-result"]
        require(root_tools, "No actual root tool result")
        payload = json.loads(root_tools[-1]["content"][0]["text"])
        if trial["arm"] == "codeact_bm25":
            require(json.loads(payload["logs"][0]) == preparation["bm25"], "BM25 result not consumed")
        if trial["arm"] == "chunk_map_reduce":
            maps = [w for w in workers.values() if w["identity"]["role"] == "map"]
            require({w["identity"]["mapIndex"] for w in maps} == set(range(expected)), "Map coverage mismatch")
            for worker in maps:
                require(worker["prompt"][1]["text"] == preparation["chunks"][worker["identity"]["mapIndex"]]["text"],
                        "Map chunk bytes mismatch")
            reduced = json.loads(payload["logs"][0])
            require(len(reduced) == expected and {v["index"] for v in reduced} == set(range(expected)),
                    "Reduce input coverage mismatch")
            for item in reduced:
                worker = next(w for w in maps if w["identity"]["mapIndex"] == item["index"])
                result = item["result"]
                require(result["commandId"] == worker["commandId"] and result["complete"] is True
                        and result["truncated"] is False and result["stopReason"] == "completed"
                        and result["text"] == text(worker["result"]["output"]), "Reduce lost full map result")
    value = None if terminal == "unknown" or raw is None else {"trial_id": trial["trial_id"],
        "case_id": trial["case_id"], "input_sha256": trial["input_sha256"], "model": MODEL,
        "status": terminal, "output": raw}
    return {"trial_id": trial["trial_id"], "terminal": terminal, "derived": value,
            "exclusion": "unknown_lifecycle" if terminal == "unknown" else "no_final_worker_output" if raw is None else None,
            "attempts": len(attempts), "fake_sends": len(r["sends"]), "reasons": r["reasons"]}


def verify(bundle):
    """Validate a complete retained inventory without rerunning its Consumer."""
    bundle = Path(bundle)
    verify_dependencies()
    mf_raw, manifest = read_json(bundle / "manifest.json")
    cases_raw, cases = read_json(bundle / "cases.json")
    schedule_raw, schedule = read_json(bundle / "schedule.json")
    require(manifest["source"] == SOURCE and manifest["fakeOnly"] is True
            and manifest["casesSha256"] == schedule["cases_sha256"] == sha(cases_raw)
            and manifest["scheduleSha256"] == sha(schedule_raw), "Manifest input mismatch")
    cases = index_unique(cases, "case_id")
    for case in cases.values():
        require(case["input_sha256"] == sha((case["context"] + "\n" + case["question"]).encode()), "Input hash mismatch")
    preparations = {key: prepare(case) for key, case in cases.items()}
    trials = index_unique(schedule["trials"], "trial_id")
    executions = index_unique(manifest["executions"], "trial_id")
    diagnostics = index_unique(manifest["diagnostics"], "trial_id")
    require(set(executions) <= set(trials) and not set(diagnostics) & set(trials), "Unexpected trial identity")
    producers = index_unique(manifest["producerFiles"], "path")
    require(len(producers) == 5, "Producer file inventory changed")
    for path, pin in producers.items():
        require(sha(Path(path).read_bytes()) == pin["sha256"], "Producer source drift")
    inventory, diagnostic_inventory = [], []
    for key, pin in list(executions.items()) + list(diagnostics.items()):
        raw, report = read_json(within(bundle, pin["path"]))
        require(sha(raw) == pin["sha256"] and report["trial"]["trial_id"] == key
                and report["terminal"] == pin["terminal"], "Receipt reference mismatch")
        trial = trials[key] if key in executions else report["trial"]
        case = cases[trial["case_id"]]
        require(all(trial[k] == case[k] for k in ("input_sha256", "benchmark", "cluster_id", "partition")),
                "Scheduled case mismatch")
        home = within(bundle, pin["path"]).parent
        require(sha((home / "context.txt").read_bytes()) == sha(case["context"].encode())
                == report["originalContextSha256"], "Retained context bytes mismatch")
        item = verify_trial(report, trial, case, preparations[trial["case_id"]])
        (inventory if key in executions else diagnostic_inventory).append(item)
    return {"scope": "local_fake_receipts_only", "manifest_sha256": sha(mf_raw),
            "preprocessing_dependencies": PREPROCESS_DEPENDENCIES,
            "schedule_sha256": sha(schedule_raw), "inventory": inventory, "diagnostics": diagnostic_inventory,
            "missing": [{"trial_id": k, "reason": "no_execution_receipt"} for k in trials if k not in executions],
            "actual_http_model_requests": 0, "usage": "scripted_values_not_real_tokens_or_cost",
            "independently_signed": False, "experimentReady": False, "paidLaunchAllowed": False}


def main():
    """Publish a new report only after receipt and optional scorer validation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--freeze", type=Path)
    args = parser.parse_args()
    require(bool(args.source) == bool(args.freeze), "Source and freeze must be supplied together")
    report = verify(args.bundle)
    if args.source:
        values = [r["derived"] for r in report["inventory"] if r["derived"] is not None]
        with tempfile.TemporaryDirectory(prefix="dsh-receipt-controller-") as directory:
            results = Path(directory) / "derived.jsonl"
            results.write_text("".join(json.dumps(v, ensure_ascii=False) + "\n" for v in values))
            report["official_controller"] = score(args.source, args.freeze, args.bundle / "schedule.json", results)
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
