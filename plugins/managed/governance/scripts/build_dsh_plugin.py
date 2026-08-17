#!/usr/bin/env python3
"""Build or verify the packaged DSH governance runtime from the canonical core."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "scripts" / "governance.py"
RUNTIME = ROOT / "plugins" / "deepseek-solar-harness-governance" / "runtime"
TARGET = RUNTIME / "governance.py"
MANIFEST = RUNTIME / "source-manifest.json"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expected_manifest() -> dict[str, object]:
    return {
        "manifest_version": 1,
        "source_path": "scripts/governance.py",
        "source_sha256": digest(SOURCE),
    }


def check() -> list[str]:
    errors: list[str] = []
    if not TARGET.is_file():
        errors.append(f"missing packaged runtime: {TARGET.relative_to(ROOT)}")
    elif digest(TARGET) != digest(SOURCE):
        errors.append("packaged governance.py differs from canonical scripts/governance.py")
    if not MANIFEST.is_file():
        errors.append(f"missing source manifest: {MANIFEST.relative_to(ROOT)}")
    else:
        try:
            actual = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"invalid source manifest: {exc}")
        else:
            if actual != expected_manifest():
                errors.append("source manifest is stale or malformed")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail instead of regenerating stale output")
    args = parser.parse_args()
    if not args.check:
        RUNTIME.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE, TARGET)
        MANIFEST.write_text(
            json.dumps(expected_manifest(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    errors = check()
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"Packaged DSH governance runtime is current: {digest(TARGET)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
