#!/usr/bin/env python3
"""Local preprocessing for the keyless real-Worker pilot fixture; never calls a model."""
import argparse
import json
from pathlib import Path

from preprocessing import bm25, pack_records, sha


def prepare(case):
    """Retain the entire original context and compute the fixed baseline algorithms."""
    raw = case["context"].encode("utf-8", errors="strict")
    records = raw.splitlines(keepends=True)
    if not raw or b"".join(records) != raw:
        raise ValueError("Context record coverage differs")
    chunks = pack_records(records, lambda b: (len(b) + 3) // 4,
                          "fixture-utf8-bytes-div4-ceil-v1", 8192)
    if b"".join(c["text"].encode("utf-8") for c in chunks) != raw:
        raise ValueError("Packed context coverage differs")
    return {"fake_only": True, "context_sha256": sha(raw), "context_bytes": len(raw),
            "record_count": len(records), "record_sha256": [sha(r) for r in records],
            "token_counter": "fixture-utf8-bytes-div4-ceil-v1",
            "production_token_bound": False, "chunks": chunks,
            "bm25": bm25(records, case["question"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    result = prepare(json.loads(args.case.read_bytes()))
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
