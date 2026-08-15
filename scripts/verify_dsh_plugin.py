#!/usr/bin/env python3
"""Validate the DSH bundle contract without starting a Harness process."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugins" / "deepseek-solar-harness-governance"


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    package = json.loads((PLUGIN / "package.json").read_text(encoding="utf-8"))
    if package.get("dsh", {}).get("bundle", {}).get("patch") != "./cordis.patch.yml":
        fail("package.json does not declare the Cordis bundle patch")
    patch = (PLUGIN / "cordis.patch.yml").read_text(encoding="utf-8")
    for marker in (
        "@deepseek-ai/dsh-invariants'",
        "@lisihao/dsh-code-harness-governance'",
        "@lisihao/dsh-code-harness-governance/invariant'",
        "strict: true",
    ):
        if marker not in patch:
            fail(f"cordis.patch.yml missing {marker}")
    build_check = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_dsh_plugin.py"), "--check"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if build_check.returncode != 0:
        fail(build_check.stdout.strip())
    print("DeepSeek-Solar-Harness governance plugin contract is valid.")


if __name__ == "__main__":
    main()
