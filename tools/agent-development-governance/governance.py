#!/usr/bin/env python3
"""Discover, plan, and execute repository-native development governance gates."""

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import contextlib
import datetime as dt
import fnmatch
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable


PROFILE_VERSION = 1
STATUS_ORDER = {"ok": 0, "warn": 1, "error": 2, "pending": 1}


class GovernanceError(RuntimeError):
    """Raised for invalid configuration or an unusable project."""


def emit(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    title = payload.get("title")
    if title:
        print(f"\n{title}")
    for item in payload.get("items", []):
        status = item.get("status", "pending")
        label = item.get("label", item.get("id", "item"))
        detail = item.get("detail", "")
        print(f"[{status:7}] {label}: {detail}")
    summary = payload.get("summary")
    if summary:
        print(f"\nsummary: {summary}")


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise GovernanceError(f"profile not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"invalid profile JSON {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise GovernanceError(f"profile root must be an object: {path}")
    return data


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_profile(profile: dict[str, Any], source: Path) -> None:
    if profile.get("profile_version") != PROFILE_VERSION:
        raise GovernanceError(
            f"unsupported profile_version in {source}: "
            f"expected {PROFILE_VERSION}, got {profile.get('profile_version')}"
        )
    for key in ("name", "project_markers", "scope_rules", "gates"):
        if key not in profile:
            raise GovernanceError(f"profile missing required field '{key}': {source}")
    declared_scopes = {rule.get("scope") for rule in profile["scope_rules"]}
    if None in declared_scopes or "always" in declared_scopes:
        raise GovernanceError("scope rules require non-empty names and may not redefine 'always'")
    for rule in profile["scope_rules"]:
        unknown = set(rule.get("expands", [])) - declared_scopes
        if unknown:
            raise GovernanceError(f"scope '{rule['scope']}' expands unknown scopes: {sorted(unknown)}")
    bundle = profile.get("harness_bundle")
    if bundle is not None:
        if not isinstance(bundle, dict) or not bundle.get("manifest"):
            raise GovernanceError("harness_bundle must declare a manifest path")
        manifest = Path(bundle["manifest"])
        if manifest.is_absolute() or ".." in manifest.parts:
            raise GovernanceError("harness_bundle manifest must remain inside the project")
    max_concurrency = profile.get("max_concurrency", 1)
    if isinstance(max_concurrency, bool) or not isinstance(max_concurrency, int) or max_concurrency < 1:
        raise GovernanceError("max_concurrency must be a positive integer")
    seen: set[str] = set()
    for gate in profile["gates"]:
        gate_id = gate.get("id")
        if not gate_id or gate_id in seen:
            raise GovernanceError(f"gate id missing or duplicated: {gate_id!r}")
        seen.add(gate_id)
        command = gate.get("command")
        if not isinstance(command, list) or not command or not all(
            isinstance(arg, str) and arg for arg in command
        ):
            raise GovernanceError(f"gate '{gate_id}' command must be a non-empty string array")
        environment = gate.get("env", {})
        if not isinstance(environment, dict) or not all(
            isinstance(key, str)
            and key
            and isinstance(value, str)
            for key, value in environment.items()
        ):
            raise GovernanceError(f"gate '{gate_id}' env must be a string-to-string object")
        if not gate.get("scopes") or not gate.get("levels"):
            raise GovernanceError(f"gate '{gate_id}' must declare scopes and levels")
        unknown_scopes = set(gate["scopes"]) - declared_scopes - {"always"}
        if unknown_scopes:
            raise GovernanceError(f"gate '{gate_id}' uses unknown scopes: {sorted(unknown_scopes)}")
        unknown_levels = set(gate["levels"]) - {"quick", "full"}
        if unknown_levels:
            raise GovernanceError(f"gate '{gate_id}' uses unknown levels: {sorted(unknown_levels)}")
        cwd = Path(gate.get("cwd", "."))
        if cwd.is_absolute() or ".." in cwd.parts:
            raise GovernanceError(f"gate '{gate_id}' cwd must remain inside the project")
        timeout = gate.get("timeout_seconds", 1800)
        if not isinstance(timeout, int) or timeout < 1:
            raise GovernanceError(f"gate '{gate_id}' timeout_seconds must be a positive integer")
        exclusive = gate.get("exclusive", False)
        if not isinstance(exclusive, bool):
            raise GovernanceError(f"gate '{gate_id}' exclusive must be a boolean")
    gates_by_id = {gate["id"]: gate for gate in profile["gates"]}
    for gate_id, gate in gates_by_id.items():
        needs = gate.get("needs", [])
        if not isinstance(needs, list) or not all(isinstance(item, str) and item for item in needs):
            raise GovernanceError(f"gate '{gate_id}' needs must be a string array")
        if len(needs) != len(set(needs)):
            raise GovernanceError(f"gate '{gate_id}' needs contains duplicates")
        if gate_id in needs:
            raise GovernanceError(f"gate '{gate_id}' cannot depend on itself")
        unknown = set(needs) - gates_by_id.keys()
        if unknown:
            raise GovernanceError(f"gate '{gate_id}' needs unknown gate(s): {sorted(unknown)}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(gate_id: str) -> None:
        if gate_id in visiting:
            raise GovernanceError(f"gate dependency cycle includes '{gate_id}'")
        if gate_id in visited:
            return
        visiting.add(gate_id)
        for dependency in gates_by_id[gate_id].get("needs", []):
            visit(dependency)
        visiting.remove(gate_id)
        visited.add(gate_id)

    for gate_id in gates_by_id:
        visit(gate_id)


def resolve_profile(project: Path, requested: str | None) -> tuple[dict[str, Any], Path]:
    if requested:
        source = Path(requested).expanduser().resolve()
    else:
        local = project / ".agent-governance" / "profile.json"
        harness_root = Path(__file__).resolve().parent.parent
        bundled = (
            harness_root
            / "skill"
            / "agent-development-governance"
            / "references"
            / "genesispod-profile.json"
        )
        genesis_markers = [
            project / ".claude" / "CLAUDE.md",
            project / "backend" / "src" / "__tests__" / "architecture",
            project / "frontend" / "package.json",
        ]
        if local.is_file():
            source = local
        elif all(marker.exists() for marker in genesis_markers):
            source = bundled
        else:
            raise GovernanceError(
                "no governance profile recognized; add .agent-governance/profile.json "
                "or pass --profile"
            )
    profile = load_json(source)
    validate_profile(profile, source)
    return profile, source


def run_git(project: Path, args: list[str]) -> list[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=project,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise GovernanceError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return [line for line in result.stdout.splitlines() if line]


def changed_files(project: Path, changed_from: str | None) -> list[str]:
    files: set[str] = set()
    files.update(run_git(project, ["diff", "--name-only", "--diff-filter=ACMR"] ))
    files.update(run_git(project, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"] ))
    files.update(run_git(project, ["ls-files", "--others", "--exclude-standard"] ))
    if changed_from:
        files.update(
            run_git(
                project,
                ["diff", "--name-only", "--diff-filter=ACMR", f"{changed_from}...HEAD"],
            )
        )
    return sorted(path.replace(os.sep, "/") for path in files)


def inherited_changed_from(project: Path) -> str | None:
    """Return the parent gate's branch baseline only for the same project.

    Gates may create and inspect nested Git repositories.  A branch reference
    from the outer project is meaningless there, so scope the inherited value
    to the project root that originally supplied it.
    """
    changed_from = os.environ.get("GOVERNANCE_CHANGED_FROM")
    if not changed_from:
        return None
    context_root = os.environ.get("GOVERNANCE_PROJECT_ROOT")
    if not context_root:
        return changed_from
    try:
        same_project = Path(context_root).expanduser().resolve() == project.resolve()
        return changed_from if same_project else None
    except OSError:
        return None


def git_head(project: Path) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=project,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else "UNBORN"


def resolve_report_path(project: Path, requested: str) -> Path:
    """Resolve @git inside the active repository or linked worktree metadata."""
    if requested != "@git":
        return Path(requested).expanduser().resolve()
    result = subprocess.run(
        ["git", "rev-parse", "--git-path", "governance-attestation.json"],
        cwd=project,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise GovernanceError(
            f"cannot resolve worktree attestation path: {result.stderr.strip()}"
        )
    path = Path(result.stdout.strip())
    return path.resolve() if path.is_absolute() else (project / path).resolve()


@contextlib.contextmanager
def verify_lock(project: Path):
    """Reject concurrent verification in one checkout; the OS releases the lock on exit."""
    lock_path = resolve_report_path(project, "@git").with_name("governance-verify.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    locked = False
    try:
        if os.name == "nt":
            import msvcrt

            if lock_path.stat().st_size == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise GovernanceError(
                    f"another governance verify is already running for this worktree: {lock_path}"
                ) from exc
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise GovernanceError(
                    f"another governance verify is already running for this worktree: {lock_path}"
                ) from exc
        locked = True
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n".encode())
        handle.flush()
        yield
    finally:
        if locked:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def change_fingerprint(project: Path, files: list[str], profile_sha256: str) -> str:
    """Bind an attestation to HEAD, the selected paths, and their current bytes."""
    digest = hashlib.sha256()
    digest.update(f"head\0{git_head(project)}\0profile\0{profile_sha256}\0".encode())
    for relative in sorted(files):
        digest.update(relative.encode("utf-8", errors="surrogateescape"))
        digest.update(b"\0")
        path = project / relative
        if path.is_file():
            digest.update(path.read_bytes())
        else:
            digest.update(b"<missing-or-non-file>")
        digest.update(b"\0")
    return digest.hexdigest()


def matches(path: str, patterns: Iterable[str]) -> bool:
    for pattern in patterns:
        if "/" not in pattern and "/" in path:
            continue
        if fnmatch.fnmatchcase(path, pattern):
            return True
    return False


def infer_scopes(profile: dict[str, Any], files: list[str], requested: str) -> list[str]:
    all_scopes = [rule["scope"] for rule in profile["scope_rules"]]
    if requested == "full":
        return sorted(set(all_scopes))
    if requested != "auto":
        if requested not in all_scopes:
            raise GovernanceError(
                f"unknown scope '{requested}'; choose auto, full, or one of {', '.join(all_scopes)}"
            )
        scopes = {requested}
    else:
        scopes = {
            rule["scope"]
            for rule in profile["scope_rules"]
            if any(matches(path, rule.get("patterns", [])) for path in files)
        }
    changed = True
    while changed:
        changed = False
        for rule in profile["scope_rules"]:
            if rule["scope"] in scopes:
                for expanded in rule.get("expands", []):
                    if expanded not in scopes:
                        scopes.add(expanded)
                        changed = True
    return sorted(scopes)


def select_gates(
    profile: dict[str, Any], scopes: list[str], level: str
) -> list[dict[str, Any]]:
    active = set(scopes)
    active.add("always")
    selected_ids: set[str] = set()
    for gate in profile["gates"]:
        if level not in gate["levels"]:
            continue
        if active.intersection(gate["scopes"]):
            selected_ids.add(gate["id"])
    gates_by_id = {gate["id"]: gate for gate in profile["gates"]}
    pending = list(selected_ids)
    while pending:
        gate_id = pending.pop()
        for dependency in gates_by_id[gate_id].get("needs", []):
            if dependency in selected_ids:
                continue
            selected_ids.add(dependency)
            pending.append(dependency)
    return [gate for gate in profile["gates"] if gate["id"] in selected_ids]


def plan_payload(
    project: Path,
    profile: dict[str, Any],
    profile_path: Path,
    scope: str,
    level: str,
    changed_from: str | None,
) -> dict[str, Any]:
    files = changed_files(project, changed_from)
    scopes = infer_scopes(profile, files, scope)
    gates = select_gates(profile, scopes, level)
    items = []
    for gate in gates:
        environment = gate.get("env", {})
        env_note = f" env={sorted(environment)}" if environment else ""
        items.append({
            "id": gate["id"],
            "label": gate.get("label", gate["id"]),
            "status": "pending",
            "detail": f"(cd {gate.get('cwd', '.')}){env_note} {shlex.join(gate['command'])}",
        })
    return {
        "title": "Governance verification plan",
        "project": str(project),
        "profile": profile["name"],
        "profile_path": str(profile_path),
        "level": level,
        "changed_files": files,
        "scopes": scopes,
        "gates": [gate["id"] for gate in gates],
        "items": items,
        "summary": f"{len(files)} changed files; scopes={scopes or ['none']}; {len(gates)} gates",
    }


def npm_script_exists(cwd: Path, command: list[str]) -> bool | None:
    if len(command) < 3 or command[0] not in {"npm", "npm.cmd"} or command[1] != "run":
        return None
    package = cwd / "package.json"
    if not package.is_file():
        return False
    try:
        scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts", {})
    except (json.JSONDecodeError, OSError):
        return False
    return command[2] in scripts


def audit_project(
    project: Path, profile: dict[str, Any], profile_path: Path
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for marker in profile["project_markers"]:
        exists = (project / marker).exists()
        items.append(
            {
                "id": f"marker:{marker}",
                "label": "project marker",
                "status": "ok" if exists else "error",
                "detail": f"{marker} {'exists' if exists else 'is missing'}",
            }
        )

    for source in profile.get("instruction_sources", []):
        if "glob" in source:
            found = sorted(project.glob(source["glob"]))
            detail = f"{source['glob']} -> {len(found)} files"
            exists = bool(found)
        else:
            path = source["path"]
            exists = (project / path).exists()
            detail = f"{path} {'exists' if exists else 'is missing'}"
        required = source.get("required", False)
        status = "ok" if exists else ("error" if required else "warn")
        items.append(
            {
                "id": f"instruction:{source.get('path', source.get('glob'))}",
                "label": source.get("kind", "instruction"),
                "status": status,
                "detail": detail,
            }
        )

    for hook in profile.get("hooks", []):
        hook_path = project / hook["path"]
        if not hook_path.is_file():
            status = "error" if hook.get("required", False) else "warn"
            detail = f"{hook['path']} is missing"
        else:
            tracked_mode: str | None = None
            result = subprocess.run(
                ["git", "ls-files", "-s", "--", hook["path"]],
                cwd=project,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if result.returncode == 0 and result.stdout.strip():
                tracked_mode = result.stdout.split()[0]
            fs_executable = bool(hook_path.stat().st_mode & stat.S_IXUSR)
            tracked_executable = tracked_mode == "100755" if tracked_mode else fs_executable
            status = "ok" if fs_executable and tracked_executable else "warn"
            detail = (
                f"{hook['path']} filesystem_exec={fs_executable} "
                f"git_mode={tracked_mode or 'untracked'}"
            )
        items.append({"id": f"hook:{hook['path']}", "label": "git hook", "status": status, "detail": detail})

    for contract in profile.get("ci_contracts", []):
        ci_path = project / contract["path"]
        missing: list[str] = []
        if ci_path.is_file():
            text = ci_path.read_text(encoding="utf-8")
            missing = [needle for needle in contract.get("required_text", []) if needle not in text]
        else:
            missing = ["file"]
        items.append(
            {
                "id": f"ci:{contract['path']}",
                "label": "CI contract",
                "status": "ok" if not missing else "error",
                "detail": f"{contract['path']}" + (" wired" if not missing else f" missing {missing}"),
            }
        )

    bundle = profile.get("harness_bundle")
    if bundle:
        manifest_path = project / bundle["manifest"]
        bundle_errors: list[str] = []
        if not manifest_path.is_file():
            bundle_errors.append(f"missing manifest {bundle['manifest']}")
        else:
            try:
                manifest = load_json(manifest_path)
                files = manifest.get("files", {})
                if manifest.get("bundle_version") != 1 or not isinstance(files, dict):
                    bundle_errors.append("invalid bundle manifest schema")
                else:
                    for relative, expected in sorted(files.items()):
                        candidate = Path(relative)
                        if candidate.is_absolute() or ".." in candidate.parts:
                            bundle_errors.append(f"unsafe bundle path {relative}")
                            continue
                        actual_path = project / candidate
                        if not actual_path.is_file():
                            bundle_errors.append(f"missing {relative}")
                        elif sha256_file(actual_path) != expected:
                            bundle_errors.append(f"digest mismatch {relative}")
            except GovernanceError as exc:
                bundle_errors.append(str(exc))
        items.append(
            {
                "id": "harness-bundle",
                "label": "Harness bundle",
                "status": "ok" if not bundle_errors else "error",
                "detail": (
                    f"{bundle['manifest']} verified"
                    if not bundle_errors
                    else "; ".join(bundle_errors)
                ),
            }
        )

    checked_programs: set[str] = set()
    for gate in profile["gates"]:
        command = gate["command"]
        program = command[0]
        cwd = (project / gate.get("cwd", ".")).resolve()
        if program not in checked_programs:
            checked_programs.add(program)
            found = shutil.which(program) is not None
            items.append(
                {
                    "id": f"program:{program}",
                    "label": "gate runtime",
                    "status": "ok" if found else "error",
                    "detail": f"{program} {'available' if found else 'not found'}",
                }
            )
        npm_exists = npm_script_exists(cwd, command)
        if npm_exists is False:
            items.append(
                {
                    "id": f"gate:{gate['id']}",
                    "label": "gate entrypoint",
                    "status": "error",
                    "detail": f"npm script '{command[2]}' missing in {cwd / 'package.json'}",
                }
            )

    counts = {status: 0 for status in STATUS_ORDER}
    for item in items:
        counts[item["status"]] += 1
    return {
        "title": "Governance audit",
        "project": str(project),
        "profile": profile["name"],
        "profile_path": str(profile_path),
        "items": items,
        "counts": counts,
        "summary": ", ".join(f"{key}={value}" for key, value in counts.items()),
    }


def execute_gate(
    project: Path,
    gate: dict[str, Any],
    context_env: dict[str, str] | None,
) -> tuple[dict[str, Any], str]:
    command = gate["command"]
    cwd = (project / gate.get("cwd", ".")).resolve()
    environment = gate.get("env", {})
    env_note = f" env={sorted(environment)}" if environment else ""
    detail = f"(cd {cwd}){env_note} {shlex.join(command)}"
    started = time.monotonic()
    output_digest = hashlib.sha256()
    tail: collections.deque[str] = collections.deque(maxlen=40)
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            env={**os.environ, **(context_env or {}), **environment},
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=gate.get("timeout_seconds", 1800),
        )
        output = completed.stdout or ""
        output_digest.update(output.encode("utf-8", errors="replace"))
        tail.extend(output.splitlines())
        returncode = completed.returncode
        elapsed = round(time.monotonic() - started, 2)
        return ({
            "id": gate["id"],
            "label": gate.get("label", gate["id"]),
            "status": "ok" if returncode == 0 else "error",
            "returncode": returncode,
            "duration_seconds": elapsed,
            "output_sha256": output_digest.hexdigest(),
            "output_tail": list(tail),
            "detail": f"{detail}; exit={returncode}; duration={elapsed}s",
        }, output)
    except subprocess.TimeoutExpired as exc:
        elapsed = round(time.monotonic() - started, 2)
        partial = exc.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", errors="replace")
        output_digest.update(partial.encode("utf-8", errors="replace"))
        tail.extend(partial.splitlines())
        return ({
            "id": gate["id"],
            "label": gate.get("label", gate["id"]),
            "status": "error",
            "returncode": None,
            "duration_seconds": elapsed,
            "output_sha256": output_digest.hexdigest(),
            "output_tail": list(tail),
            "detail": f"{detail}; timed out after {elapsed}s",
        }, partial)


def execute_gates(
    project: Path,
    gates: list[dict[str, Any]],
    dry_run: bool,
    fail_fast: bool,
    context_env: dict[str, str] | None = None,
    max_concurrency: int = 1,
) -> list[dict[str, Any]]:
    if isinstance(max_concurrency, bool) or not isinstance(max_concurrency, int) or max_concurrency < 1:
        raise GovernanceError("max_concurrency must be a positive integer")
    selected_ids = {gate["id"] for gate in gates}
    for gate in gates:
        missing = set(gate.get("needs", [])) - selected_ids
        if missing:
            raise GovernanceError(f"selected gate '{gate['id']}' is missing dependencies: {sorted(missing)}")
    if dry_run:
        results: list[dict[str, Any]] = []
        for gate in gates:
            command = gate["command"]
            cwd = (project / gate.get("cwd", ".")).resolve()
            environment = gate.get("env", {})
            env_note = f" env={sorted(environment)}" if environment else ""
            detail = f"(cd {cwd}){env_note} {shlex.join(command)}"
            results.append({
                "id": gate["id"],
                "label": gate.get("label", gate["id"]),
                "status": "pending",
                "detail": detail,
            })
        return results

    gates_by_id = {gate["id"]: gate for gate in gates}
    pending = dict(gates_by_id)
    results_by_id: dict[str, dict[str, Any]] = {}
    running: dict[concurrent.futures.Future[tuple[dict[str, Any], str]], str] = {}
    failure_seen = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrency) as executor:
        while pending or running:
            made_progress = False
            if not (fail_fast and failure_seen):
                for gate in gates:
                    gate_id = gate["id"]
                    if gate_id not in pending or len(running) >= max_concurrency:
                        continue
                    dependencies = gate.get("needs", [])
                    failed = [dependency for dependency in dependencies if results_by_id.get(dependency, {}).get("status") == "error"]
                    if failed:
                        results_by_id[gate_id] = {
                            "id": gate_id,
                            "label": gate.get("label", gate_id),
                            "status": "error",
                            "returncode": None,
                            "duration_seconds": 0.0,
                            "output_sha256": hashlib.sha256(b"").hexdigest(),
                            "output_tail": [],
                            "detail": f"blocked by failed dependencies: {failed}",
                        }
                        del pending[gate_id]
                        failure_seen = True
                        made_progress = True
                        continue
                    if not all(dependency in results_by_id for dependency in dependencies):
                        continue
                    if gate.get("exclusive", False) and running:
                        # Preserve profile order and let active work drain. If
                        # later gates started here, a ready exclusive gate could
                        # be starved indefinitely by a stream of ordinary work.
                        break
                    if any(gates_by_id[running_id].get("exclusive", False) for running_id in running.values()):
                        break
                    command = gate["command"]
                    cwd = (project / gate.get("cwd", ".")).resolve()
                    environment = gate.get("env", {})
                    env_note = f" env={sorted(environment)}" if environment else ""
                    detail = f"(cd {cwd}){env_note} {shlex.join(command)}"
                    print(f"\n==> {gate_id}: {detail}", flush=True)
                    future = executor.submit(execute_gate, project, gate, context_env)
                    running[future] = gate_id
                    del pending[gate_id]
                    made_progress = True
                    if gate.get("exclusive", False):
                        break
            if not running:
                if fail_fast and failure_seen:
                    break
                if pending and not made_progress:
                    raise GovernanceError(f"selected gate dependency cycle: {sorted(pending)}")
                continue
            completed, _ = concurrent.futures.wait(
                running, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for future in completed:
                gate_id = running.pop(future)
                result, output = future.result()
                if output:
                    print(f"\n<== {gate_id}\n{output}", end="" if output.endswith("\n") else "\n", flush=True)
                results_by_id[gate_id] = result
                if result["status"] == "error":
                    failure_seen = True

    return [results_by_id[gate["id"]] for gate in gates if gate["id"] in results_by_id]


def write_attestation(
    destination: Path,
    project: Path,
    profile: dict[str, Any],
    profile_path: Path,
    payload: dict[str, Any],
    results: list[dict[str, Any]],
    changed_from: str | None,
) -> dict[str, Any]:
    profile_digest = sha256_file(profile_path)
    attestation = {
        "attestation_version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "project": str(project),
        "profile": profile["name"],
        "profile_path": str(profile_path),
        "profile_sha256": profile_digest,
        "git_head": git_head(project),
        "changed_from": changed_from,
        "changed_files": payload["changed_files"],
        "change_fingerprint": change_fingerprint(
            project, payload["changed_files"], profile_digest
        ),
        "level": payload["level"],
        "scopes": payload["scopes"],
        "required_gates": payload["gates"],
        "results": results,
        "overall": "ok"
        if len(results) == len(payload["gates"])
        and all(item["status"] == "ok" for item in results)
        else "error",
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(attestation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return attestation


def check_attestation(
    report_path: Path,
    project: Path,
    profile: dict[str, Any],
    profile_path: Path,
    require_level: str | None = None,
) -> dict[str, Any]:
    report = load_json(report_path)
    items: list[dict[str, Any]] = []
    current_files = changed_files(project, report.get("changed_from"))
    try:
        report_relative = report_path.relative_to(project).as_posix()
    except ValueError:
        report_relative = None
    if report_relative:
        current_files = [path for path in current_files if path != report_relative]
    current_profile_digest = sha256_file(profile_path)
    required_gates = report.get("required_gates", [])
    results = report.get("results", [])
    result_ids = [item.get("id") for item in results if isinstance(item, dict)]
    checks = [
        (
            "profile",
            report.get("profile") == profile["name"],
            f"report={report.get('profile')} current={profile['name']}",
        ),
        (
            "profile-digest",
            report.get("profile_sha256") == current_profile_digest,
            "profile bytes unchanged",
        ),
        (
            "git-head",
            report.get("git_head") == git_head(project),
            f"report={report.get('git_head')} current={git_head(project)}",
        ),
        (
            "changed-files",
            report.get("changed_files") == current_files,
            f"report={len(report.get('changed_files', []))} current={len(current_files)}",
        ),
        (
            "fingerprint",
            report.get("change_fingerprint")
            == change_fingerprint(project, current_files, current_profile_digest),
            "HEAD, profile, paths, and file bytes unchanged",
        ),
        (
            "overall",
            report.get("overall") == "ok",
            f"overall={report.get('overall')}",
        ),
        (
            "required-gates",
            required_gates == result_ids
            and all(item.get("status") == "ok" for item in results),
            f"required={required_gates} results={result_ids}",
        ),
    ]
    if require_level:
        checks.append(
            (
                "verification-level",
                report.get("level") == require_level,
                f"required={require_level} report={report.get('level')}",
            )
        )
    for check_id, passed, detail in checks:
        items.append(
            {
                "id": check_id,
                "label": "attestation check",
                "status": "ok" if passed else "error",
                "detail": detail,
            }
        )
    return {
        "title": "Governance attestation",
        "project": str(project),
        "report": str(report_path),
        "items": items,
        "summary": f"{sum(item['status'] == 'ok' for item in items)}/{len(items)} checks passed",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("audit", "plan", "verify", "attest"):
        command = subparsers.add_parser(name)
        command.add_argument("--project", required=True, help="Repository root")
        command.add_argument("--profile", help="Profile JSON path")
        command.add_argument("--json", action="store_true", help="Emit JSON")
        if name in {"plan", "verify"}:
            command.add_argument("--scope", default="auto", help="auto, full, or a profile scope")
            command.add_argument("--level", choices=("quick", "full"), default="quick")
            command.add_argument("--changed-from", help="Include committed changes since this ref")
        if name == "audit":
            command.add_argument("--strict-warnings", action="store_true")
        if name == "verify":
            command.add_argument("--dry-run", action="store_true")
            command.add_argument("--fail-fast", action="store_true")
            command.add_argument(
                "--report",
                help="Write a change-bound JSON attestation; use @git for worktree metadata",
            )
        if name == "attest":
            command.add_argument(
                "--report",
                required=True,
                help="Attestation JSON to verify; use @git for worktree metadata",
            )
            command.add_argument("--require-level", choices=("quick", "full"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project = Path(args.project).expanduser().resolve()
    if not project.is_dir():
        raise GovernanceError(f"project directory not found: {project}")
    profile, profile_path = resolve_profile(project, args.profile)

    if args.command == "attest":
        payload = check_attestation(
            resolve_report_path(project, args.report),
            project,
            profile,
            profile_path,
            args.require_level,
        )
        emit(payload, args.json)
        return 1 if any(item["status"] == "error" for item in payload["items"]) else 0

    if args.command == "audit":
        payload = audit_project(project, profile, profile_path)
        emit(payload, args.json)
        if payload["counts"]["error"]:
            return 1
        if args.strict_warnings and payload["counts"]["warn"]:
            return 1
        return 0

    payload = plan_payload(
        project,
        profile,
        profile_path,
        args.scope,
        args.level,
        args.changed_from,
    )
    if args.command == "plan":
        emit(payload, args.json)
        return 0

    gates_by_id = {gate["id"]: gate for gate in profile["gates"]}
    gates = [gates_by_id[gate_id] for gate_id in payload["gates"]]
    context_env = (
        {
            "GOVERNANCE_CHANGED_FROM": args.changed_from,
            "GOVERNANCE_PROJECT_ROOT": str(project),
        }
        if args.changed_from
        else None
    )
    lock = contextlib.nullcontext() if args.dry_run else verify_lock(project)
    with lock:
        results = execute_gates(
            project,
            gates,
            args.dry_run,
            args.fail_fast,
            context_env=context_env,
            max_concurrency=profile.get("max_concurrency", 1),
        )
        output = {
            "title": "Governance verification",
            "project": str(project),
            "profile": profile["name"],
            "level": args.level,
            "scopes": payload["scopes"],
            "changed_files": payload["changed_files"],
            "items": results,
            "summary": f"{sum(item['status'] == 'ok' for item in results)}/{len(results)} gates passed",
        }
        if args.report and not args.dry_run:
            report_path = resolve_report_path(project, args.report)
            attestation = write_attestation(
                report_path,
                project,
                profile,
                profile_path,
                payload,
                results,
                args.changed_from,
            )
            output["attestation"] = str(report_path)
            output["attestation_overall"] = attestation["overall"]
        emit(output, args.json)
    return 1 if any(item["status"] == "error" for item in results) else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GovernanceError as exc:
        print(f"governance error: {exc}", file=sys.stderr)
        raise SystemExit(2)
