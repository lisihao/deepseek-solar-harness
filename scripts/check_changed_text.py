#!/usr/bin/env python3
"""Fail on whitespace errors or unresolved conflict markers in all change states."""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
GOVERNANCE = ROOT / "scripts" / "governance.py"
TEXT_SUFFIXES = {
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".py",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
CONFLICT_PREFIXES = ("<<<<<<< ", "||||||| ", ">>>>>>> ")


def load_governance():
    spec = importlib.util.spec_from_file_location("governance", GOVERNANCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load governance harness")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git_check(project: Path, args: list[str]) -> list[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=project,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return [] if result.returncode == 0 else result.stdout.splitlines()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--changed-from")
    args = parser.parse_args()
    project = Path(args.project).expanduser().resolve()
    governance = load_governance()
    errors = git_check(project, ["diff", "--check"])
    errors += git_check(project, ["diff", "--cached", "--check"])
    if args.changed_from:
        errors += git_check(project, ["diff", "--check", f"{args.changed_from}...HEAD"])

    for relative in governance.changed_files(project, args.changed_from):
        path = project / relative
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            errors.append(f"{relative}: text-like file is not UTF-8")
            continue
        for line_number, line in enumerate(text.splitlines(), 1):
            if line.endswith((" ", "\t")):
                errors.append(f"{relative}:{line_number}: trailing whitespace")
            if line == "=======" or line.startswith(CONFLICT_PREFIXES):
                errors.append(f"{relative}:{line_number}: unresolved conflict marker")

    if errors:
        print("Changed-text checks failed:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print("Changed-text checks passed for staged, unstaged, untracked, and branch changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
