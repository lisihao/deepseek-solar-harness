#!/usr/bin/env python3
"""Run a formatter check against formattable changed files only."""

from __future__ import annotations

import argparse
import importlib.util
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SIBLING_GOVERNANCE = Path(__file__).resolve().parent / "governance.py"
GOVERNANCE = (
    SIBLING_GOVERNANCE
    if SIBLING_GOVERNANCE.is_file()
    else ROOT / "scripts" / "governance.py"
)


def load_governance():
    spec = importlib.util.spec_from_file_location("governance", GOVERNANCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load governance harness")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--changed-from", default=os.environ.get("GOVERNANCE_CHANGED_FROM"))
    parser.add_argument("--extensions", required=True)
    parser.add_argument("--exclude-prefix", action="append", default=[])
    parser.add_argument("formatter", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    formatter = list(args.formatter)
    if formatter and formatter[0] == "--":
        formatter.pop(0)
    if not formatter:
        parser.error("a formatter argv must follow --")

    project = Path(args.project).expanduser().resolve()
    if not project.is_dir():
        parser.error(f"project directory not found: {project}")
    suffixes = {
        f".{item.strip().lstrip('.').lower()}"
        for item in args.extensions.split(",")
        if item.strip()
    }
    if not suffixes:
        parser.error("--extensions must contain at least one suffix")

    governance = load_governance()
    selected: list[str] = []
    for relative in governance.changed_files(project, args.changed_from):
        if any(relative.startswith(prefix) for prefix in args.exclude_prefix):
            continue
        path = project / relative
        if not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        try:
            path.resolve().relative_to(project)
        except ValueError:
            print(f"unsafe changed path escapes project: {relative}", file=sys.stderr)
            return 2
        selected.append(relative)

    if not selected:
        print("No formattable changed files.")
        return 0

    print(f"Checking formatting for {len(selected)} changed files...")
    result = subprocess.run([*formatter, *selected], cwd=project, check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
