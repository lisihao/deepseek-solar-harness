#!/usr/bin/env python3
"""Export a versioned, digest-checked governance bundle into a project."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BUNDLE_FILES = ("governance.py", "check_changed_text.py")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"cannot resolve source commit: {result.stderr.strip()}")
    return result.stdout.strip()


def export_bundle(
    project: Path,
    profile: Path,
    source_commit: str | None = None,
) -> dict:
    project = project.expanduser().resolve()
    profile = profile.expanduser().resolve()
    if not project.is_dir():
        raise ValueError(f"project directory not found: {project}")
    if not profile.is_file():
        raise ValueError(f"profile not found: {profile}")

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    target_dir = project / "tools" / "agent-development-governance"
    profile_target = project / ".agent-governance" / "profile.json"
    target_dir.mkdir(parents=True, exist_ok=True)
    profile_target.parent.mkdir(parents=True, exist_ok=True)

    installed: list[Path] = []
    for name in BUNDLE_FILES:
        source = ROOT / "scripts" / name
        target = target_dir / name
        shutil.copy2(source, target)
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        installed.append(target)
    shutil.copy2(profile, profile_target)
    installed.append(profile_target)

    manifest = {
        "bundle_version": 1,
        "governance_version": version,
        "source_repository": "agent-development-governance",
        "source_commit": source_commit or git_head(),
        "files": {
            path.relative_to(project).as_posix(): sha256_file(path)
            for path in sorted(installed)
        },
    }
    manifest_path = target_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--source-commit")
    args = parser.parse_args()
    manifest = export_bundle(
        Path(args.project), Path(args.profile), args.source_commit
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
