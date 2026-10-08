"""Generate expected.json: the Python reference output for the public-evidence ranking port.

Usage (needs Python 3.11+ and the Codex Workbench a3 source tree):

    WORKBENCH_SRC=/path/to/implement-unified-scheduling-a3/src \
        python3.12 generate_expected.py > expected.json

The module under test is `codex_workbench/public_evidence_ranking.py`. Its sha256 is recorded in
`distribution/workbench-scheduling-sources.json` (source C) and echoed into expected.json, so a
changed reference is visible in review. Inputs are authored in the TypeScript shape; this script
converts them to the Python shape, runs the reference, and converts the result back.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys

source_root = Path(os.environ["WORKBENCH_SRC"])
sys.path.insert(0, str(source_root))
from codex_workbench.public_evidence_ranking import canonical_cohort_key, rank_comparable_public_evidence  # noqa: E402

MODULE = source_root / "codex_workbench" / "public_evidence_ranking.py"


def snake(name: str) -> str:
    return re.sub(r"([A-Z])", lambda match: "_" + match.group(1).lower(), name)


def camel(name: str) -> str:
    return re.sub(r"_([a-z])", lambda match: match.group(1).upper(), name)


def to_python(candidate: dict) -> dict:
    return {snake(key): value for key, value in candidate.items()}


def to_typescript(value, *, keep_keys: bool = False):
    if isinstance(value, dict):
        return {(key if keep_keys else camel(key)): to_typescript(item) for key, item in value.items()}
    if isinstance(value, list):
        return [to_typescript(item) for item in value]
    return value


def convert(result: dict) -> dict:
    converted = {camel(key): to_typescript(value) for key, value in result.items() if key not in {"preference_ranks", "candidate_summaries"}}
    converted["preferenceRanks"] = dict(result["preference_ranks"])
    converted["candidateSummaries"] = [to_typescript(summary) for summary in result["candidate_summaries"].values()]
    return converted


def candidate(candidate_id: str, model: str, *, effort: str | None = "high", records=None, surface="codex-cli", billing="subscription", provider="codex") -> dict:
    value = {"candidateId": candidate_id, "provider": provider, "model": model, "executionSurface": surface, "billingIdentity": billing}
    if effort is not None:
        value["reasoningEffort"] = effort
    if records is not None:
        value["publicEvidence"] = records
    return value


def record(owner: dict, *, source="dradar-codex", value=0.8, count=1000, metric="pass_rate", unit="ratio", benchmark="swe-bench", version="v1",
           harness="harness-a", task="coding", score_kind="resolved", lineage=None, group="grp-a", status="comparable", **overrides) -> dict:
    row = {
        "source": source, "benchmark": benchmark, "benchmark_version": version, "metric_kind": metric, "score_kind": score_kind,
        "unit": unit, "harness": harness, "reasoning_effort": owner.get("reasoningEffort"), "task_type": task,
        "execution_surface": owner["executionSurface"], "billing_identity": owner["billingIdentity"],
        "provider": owner["provider"], "canonical_model_id": owner["model"], "value": value, "sample_count": count,
        "lineage_id": lineage if lineage is not None else f"{source}:{benchmark}:{owner['model']}", "correlation_group": group,
        "comparability": {"status": status}, "observed_at": "2026-09-20T00:00:00Z", "freshness_state": "fresh", "provenance": "collector",
    }
    row.update(overrides)
    if "cohort_key" not in overrides:
        key = canonical_cohort_key(row)
        if key is not None:
            row["cohort_key"] = key
    return row


def with_evidence(owner: dict, *rows: dict) -> dict:
    return {**owner, "publicEvidence": list(rows)}


def pair(left_value, right_value, *, count=1000, metric="pass_rate", unit="ratio", **extra):
    a, b = candidate("a", "astra"), candidate("b", "sol")
    return [with_evidence(a, record(a, value=left_value, count=count, metric=metric, unit=unit, **extra)),
            with_evidence(b, record(b, value=right_value, count=count, metric=metric, unit=unit, **extra))]


def trio(values, **extra):
    owners = [candidate(name, model) for name, model in (("a", "astra"), ("b", "sol"), ("c", "luna"))]
    return [with_evidence(owner, record(owner, value=value, **extra)) for owner, value in zip(owners, values)]


scenarios: list[dict] = []


def add(name: str, candidates: list[dict], *, task: str = "coding") -> None:
    scenarios.append({"name": name, "taskType": task, "candidates": candidates})


add("clear rate winner", pair(0.9, 0.5))
add("clear rate winner, percent unit", pair(90, 50, unit="percent"))
add("overlapping uncertainty abstains", pair(0.81, 0.79, count=50))
add("equal rates abstain", pair(0.8, 0.8))
add("rates just separated at the 95% interval", pair(0.92, 0.78, count=100))
add("rates just overlapping at the 95% interval", pair(0.60, 0.50, count=100))
add("rates barely overlapping at the 95% interval", pair(0.98, 0.88, count=100))
add("rates with unequal sample sizes",
    [with_evidence(candidate("a", "astra"), record(candidate("a", "astra"), value=0.9, count=2000)),
     with_evidence(candidate("b", "sol"), record(candidate("b", "sol"), value=0.7, count=30))])
add("a single sample is never enough",
    [with_evidence(candidate("a", "astra"), record(candidate("a", "astra"), value=1.0, count=1)),
     with_evidence(candidate("b", "sol"), record(candidate("b", "sol"), value=0.0, count=1))])
add("latency difference within tolerance", pair(1000.0, 1000.0 + 5e-13, metric="latency_ms", unit="ms", score_kind="wall"))
add("lower latency wins", pair(1200, 800, metric="latency_ms", unit="ms", score_kind="wall"))
add("cost lower is better", pair(0.5, 2.0, metric="cost_usd", unit="usd", score_kind="priced"))
add("latency missing sample count", [with_evidence(candidate("a", "astra"), record(candidate("a", "astra"), metric="latency_ms", unit="ms", score_kind="wall", count=None)),
                                     with_evidence(candidate("b", "sol"), record(candidate("b", "sol"), metric="latency_ms", unit="ms", score_kind="wall", count=None))])
add("pass rate missing sample count", [with_evidence(candidate("a", "astra"), record(candidate("a", "astra"), count=None)),
                                       with_evidence(candidate("b", "sol"), record(candidate("b", "sol"), count=1000))])
add("three-candidate chain", trio([0.9, 0.7, 0.4]))
add("three-candidate tie among the top two", trio([0.9, 0.9, 0.3]))
add("single candidate", [with_evidence(candidate("a", "astra"), record(candidate("a", "astra")))])
add("no candidates", [])
add("no evidence at all", [candidate("a", "astra"), candidate("b", "sol")])
add("only one candidate has evidence", [with_evidence(candidate("a", "astra"), record(candidate("a", "astra"))), candidate("b", "sol")])

a, b = candidate("a", "astra"), candidate("b", "sol")
add("two sources disagree",
    [with_evidence(a, record(a, source="bench-one", value=0.9), record(a, source="bench-two", value=0.4, benchmark="other")),
     with_evidence(b, record(b, source="bench-one", value=0.5), record(b, source="bench-two", value=0.8, benchmark="other"))])
add("two sources agree",
    [with_evidence(a, record(a, source="bench-one", value=0.9), record(a, source="bench-two", value=0.9, benchmark="other")),
     with_evidence(b, record(b, source="bench-one", value=0.5), record(b, source="bench-two", value=0.5, benchmark="other"))])

owners = [candidate(name, model) for name, model in (("a", "astra"), ("b", "sol"), ("c", "luna"))]
add("preference cycle",
    [with_evidence(owners[0], record(owners[0], source="s1", value=0.9, benchmark="b1"), record(owners[0], source="s3", value=0.3, benchmark="b3")),
     with_evidence(owners[1], record(owners[1], source="s1", value=0.3, benchmark="b1"), record(owners[1], source="s2", value=0.9, benchmark="b2")),
     with_evidence(owners[2], record(owners[2], source="s2", value=0.3, benchmark="b2"), record(owners[2], source="s3", value=0.9, benchmark="b3"))])

add("reference-only evidence", pair(0.9, 0.5, status="reference_only"))
add("iq score kind is reference only", pair(140, 120, score_kind="iq-score", metric="accuracy", unit="ratio"))
add("community rating is reference only", pair(0.9, 0.5, score_kind="community_rating"))
add("unknown metric", pair(0.9, 0.5, metric="vibes"))
add("rate value outside its unit", pair(1.5, 0.5))
add("percent value outside its unit", pair(150, 50, unit="percent"))
add("task type mismatch", pair(0.9, 0.5, task="research"))
add("missing lineage", pair(0.9, 0.5, lineage="  "))
add("cohort key mismatch", pair(0.9, 0.5, cohort_key="not-the-key"))
add("different harness is a different cohort",
    [with_evidence(a, record(a, harness="harness-a", value=0.9)), with_evidence(b, record(b, harness="harness-b", value=0.5))])
add("candidate without reasoning effort", [with_evidence(candidate("a", "astra", effort=None), record(candidate("a", "astra", effort="high"))),
                                           with_evidence(b, record(b))])

ar = candidate("a", "astra")
add("dradar family duplicates collapse (same lineage and value)",
    [with_evidence(ar, record(ar, source="dradar-main", lineage="L1", value=0.9), record(ar, source="codex-radar-mirror", lineage="L1", value=0.9, upstream_dataset="dradar")),
     with_evidence(b, record(b, source="dradar-main", lineage="L2", value=0.5), record(b, source="codex-radar-mirror", lineage="L2", value=0.5, upstream_dataset="dradar"))])
add("dradar family with differing lineage is ambiguous",
    [with_evidence(ar, record(ar, source="dradar-main", lineage="L1", value=0.9), record(ar, source="codex-radar-mirror", lineage="L9", value=0.9, upstream_dataset="dradar")),
     with_evidence(b, record(b, source="dradar-main", lineage="L2", value=0.5))])
add("duplicate record, same lineage, different value",
    [with_evidence(ar, record(ar, lineage="L1", value=0.9), record(ar, lineage="L1", value=0.8)), with_evidence(b, record(b, value=0.5))])
add("public evidence is not a list", [{**candidate("a", "astra"), "publicEvidence": {"oops": True}}, with_evidence(b, record(b))])
add("public evidence entry is not an object", [with_evidence(a, "text", 7, None, record(a)), with_evidence(b, record(b))])
add("missing comparability", [with_evidence(a, {**record(a), "comparability": None}), with_evidence(b, record(b))])
add("missing source", [with_evidence(a, {**record(a), "source": None}), with_evidence(b, record(b))])
add("provider mismatch", [with_evidence(a, record(a, provider="other-provider")), with_evidence(b, record(b))])
add("model mismatch", [with_evidence(a, record(a, canonical_model_id="not-astra")), with_evidence(b, record(b))])
add("execution surface mismatch", [with_evidence(a, record(a, execution_surface="other-surface")), with_evidence(b, record(b))])
add("billing identity mismatch", [with_evidence(a, record(a, billing_identity="metered")), with_evidence(b, record(b))])
add("reasoning effort mismatch", [with_evidence(a, record(a, reasoning_effort="low")), with_evidence(b, record(b))])
add("missing metric kind makes the cohort key incomplete", [with_evidence(a, record(a, metric_kind=None)), with_evidence(b, record(b))])
add("an explicit non-dradar dataset is its own family",
    [with_evidence(a, record(a, source="s1", upstream_dataset="livebench", value=0.9)), with_evidence(b, record(b, source="s2", upstream_dataset="livebench", value=0.4))])
add("source name carries the dradar alias",
    [with_evidence(a, record(a, source="CodexRadar_main", value=0.9)), with_evidence(b, record(b, source="codex_radar-main", value=0.4))])
add("missing source and no dataset name", [with_evidence(a, {**record(a, lineage="L-x"), "source": None, "upstream_dataset": None}), with_evidence(b, record(b))])
add("one source with two cohorts",
    [with_evidence(a, record(a, source="s1", benchmark="b2", value=0.9), record(a, source="s1", benchmark="b1", value=0.9)),
     with_evidence(b, record(b, source="s1", benchmark="b2", value=0.4), record(b, source="s1", benchmark="b1", value=0.4))])
add("candidate ids sort as strings", [with_evidence(candidate("10", "astra"), record(candidate("10", "astra"), value=0.9)),
                                       with_evidence(candidate("9", "sol"), record(candidate("9", "sol"), value=0.4)),
                                       with_evidence(candidate("2", "luna"), record(candidate("2", "luna"), value=0.9))])
add("non-ascii identifiers", [with_evidence(candidate("a", "astra"), record(candidate("a", "astra"), benchmark="基准-测试", harness="é-harness", value=0.9)),
                              with_evidence(candidate("b", "sol"), record(candidate("b", "sol"), benchmark="基准-测试", harness="é-harness", value=0.5))])
add("whitespace around identifiers is trimmed",
    [{**with_evidence(a, record(a, value=0.9)), "provider": "  codex  ", "candidateId": " a "}, with_evidence(b, record(b, value=0.5))])
add("candidate missing an identity field", [{"candidateId": "a", "provider": "codex", "model": "astra"}, with_evidence(b, record(b))])
add("blank candidate id", [{**candidate("a", "astra"), "candidateId": "   "}])

output = []
for scenario in scenarios:
    entry = dict(scenario)
    try:
        python_result = rank_comparable_public_evidence([to_python(c) for c in scenario["candidates"]], task_type=scenario["taskType"])
        entry["expected"] = convert(python_result)
    except ValueError as error:
        entry["throws"] = str(error)
    output.append(entry)

json.dump({
    "reference": {"module": "codex_workbench/public_evidence_ranking.py", "sha256": hashlib.sha256(MODULE.read_bytes()).hexdigest()},
    "scenarios": output,
}, sys.stdout, ensure_ascii=False, indent=1, sort_keys=False, allow_nan=False)
sys.stdout.write("\n")
