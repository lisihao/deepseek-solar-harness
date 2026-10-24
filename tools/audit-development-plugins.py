#!/usr/bin/env python3
"""Audit selected development plugin archives against an installed profile.

This command is deliberately read-only.  It validates the selected catalog
artifacts and compares the package's own files with the corresponding
``profile/node_modules/<name>`` directory.  It never installs, extracts, or
copies an artifact and it never walks the rest of a profile.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
from typing import BinaryIO


FORMAT_VERSION = 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")


class AuditError(Exception):
    """A validation error that is safe to include in a report."""


def _is_safe_relative(raw: object) -> bool:
    if not isinstance(raw, str) or not raw or "\x00" in raw or "\\" in raw:
        return False
    path = PurePosixPath(raw)
    return not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts)


def _safe_catalog_file(base: Path, raw: object, label: str) -> Path:
    if not _is_safe_relative(raw):
        raise AuditError(f"{label} is not a safe relative path")
    relative = PurePosixPath(raw)
    candidate = base.joinpath(*relative.parts)
    try:
        resolved_base = base.resolve(strict=True)
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(resolved_base)
    except (OSError, ValueError):
        raise AuditError(f"{label} is outside the catalog directory or does not exist")
    if candidate.is_symlink() or not candidate.is_file():
        raise AuditError(f"{label} must name a regular, non-symlink file")
    return resolved


def _hash_stream(stream: BinaryIO) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(block)
        size += len(block)
    return digest.hexdigest(), size


def _hash_file(path: Path) -> tuple[str, int]:
    with path.open("rb") as stream:
        return _hash_stream(stream)


def _check_digest(value: object, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise AuditError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _check_size(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AuditError(f"{label} must be a non-negative integer")
    return value


def _check_name(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise AuditError(f"{label} must be a non-empty string")
    return value


def _check_package_name(name: str) -> tuple[str, ...]:
    # npm package names map directly below node_modules.  Refuse path-shaped
    # names before constructing a filesystem path.
    parts = tuple(name.split("/"))
    if name.startswith("@"):
        valid = len(parts) == 2 and all(parts)
    else:
        valid = len(parts) == 1 and bool(parts[0])
    if not valid or any(part in (".", "..") or "\\" in part or "\x00" in part for part in parts):
        raise AuditError(f"package name {name!r} cannot be mapped safely below node_modules")
    return parts


class ConcatenatedReader:
    """Read split artifact parts as one stream without creating a copy."""

    def __init__(self, paths: list[Path]):
        self._paths = paths
        self._index = 0
        self._stream: BinaryIO | None = None

    def readable(self) -> bool:
        return True

    def _next_stream(self) -> bool:
        while self._stream is None and self._index < len(self._paths):
            self._stream = self._paths[self._index].open("rb")
            self._index += 1
        return self._stream is not None

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            chunks: list[bytes] = []
            while self._next_stream():
                assert self._stream is not None
                data = self._stream.read()
                if data:
                    chunks.append(data)
                self._stream.close()
                self._stream = None
            return b"".join(chunks)

        chunks = []
        remaining = size
        while remaining > 0 and self._next_stream():
            assert self._stream is not None
            data = self._stream.read(remaining)
            if data:
                chunks.append(data)
                remaining -= len(data)
                continue
            self._stream.close()
            self._stream = None
        return b"".join(chunks)

    def close(self) -> None:
        if self._stream is not None:
            self._stream.close()
            self._stream = None


class Artifact:
    def __init__(self, paths: list[Path], expected_sha: str, expected_size: int):
        self.paths = paths
        self.expected_sha = expected_sha
        self.expected_size = expected_size

    def digest(self) -> tuple[str, int]:
        digest = hashlib.sha256()
        size = 0
        for path in self.paths:
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
                    size += len(block)
        return digest.hexdigest(), size

    def open_tar(self):
        if len(self.paths) == 1:
            return tarfile.open(self.paths[0], mode="r:gz")
        return tarfile.open(fileobj=ConcatenatedReader(self.paths), mode="r|gz")


def _load_json(path: Path, label: str):
    try:
        with path.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, json.JSONDecodeError) as error:
        raise AuditError(f"{label} is not valid JSON") from error


def _validate_artifact(package: dict, catalog_dir: Path) -> Artifact:
    artifact = package.get("artifact")
    if not isinstance(artifact, dict):
        raise AuditError("artifact must be an object")
    has_file = "file" in artifact
    has_parts = "parts" in artifact
    if has_file == has_parts:
        raise AuditError("artifact must contain exactly one of file or parts")
    expected_sha = _check_digest(artifact.get("sha256"), "artifact.sha256")
    expected_size = _check_size(artifact.get("size"), "artifact.size")
    paths: list[Path] = []
    if has_file:
        paths.append(_safe_catalog_file(catalog_dir, artifact.get("file"), "artifact.file"))
    else:
        parts = artifact.get("parts")
        if not isinstance(parts, list) or not parts:
            raise AuditError("artifact.parts must be a non-empty array")
        for index, raw_part in enumerate(parts):
            if not isinstance(raw_part, dict):
                raise AuditError(f"artifact.parts[{index}] must be an object")
            part_file = raw_part.get("file")
            if not isinstance(part_file, str) or not part_file.endswith(f".part{index:02d}"):
                raise AuditError(f"artifact.parts[{index}].file has an invalid part suffix")
            part_path = _safe_catalog_file(
                catalog_dir, part_file, f"artifact.parts[{index}].file"
            )
            part_sha = _check_digest(raw_part.get("sha256"), f"artifact.parts[{index}].sha256")
            part_size = _check_size(raw_part.get("size"), f"artifact.parts[{index}].size")
            actual_sha, actual_size = _hash_file(part_path)
            if actual_sha != part_sha or actual_size != part_size:
                raise AuditError(f"artifact part {index} checksum or size mismatch")
            paths.append(part_path)
    actual_sha, actual_size = Artifact(paths, expected_sha, expected_size).digest()
    if actual_sha != expected_sha:
        raise AuditError("artifact SHA-256 mismatch")
    if actual_size != expected_size:
        raise AuditError("artifact size mismatch")
    return Artifact(paths, expected_sha, expected_size)


def _member_relative_path(member: tarfile.TarInfo) -> PurePosixPath:
    name = member.name
    if not isinstance(name, str) or not _is_safe_relative(name):
        raise AuditError("archive contains an unsafe path")
    path = PurePosixPath(name)
    if not path.parts or path.parts[0] != "package":
        raise AuditError("archive contains an entry outside package/")
    if member.issym() or member.islnk() or member.isdev():
        raise AuditError("archive contains an unsupported link or device entry")
    if not member.isdir() and not member.isfile():
        raise AuditError("archive contains an unsupported entry type")
    return path


def _is_ignored_own_path(path: PurePosixPath) -> bool:
    return ".DS_Store".lower() == path.name.lower() or any(
        part in {"node_modules", ".git"} for part in path.parts
    )


def _hash_member(archive: tarfile.TarFile, member: tarfile.TarInfo) -> tuple[str, int]:
    stream = archive.extractfile(member)
    if stream is None:
        raise AuditError("archive regular file could not be read")
    with stream:
        digest, size = _hash_stream(stream)
    if size != member.size:
        raise AuditError("archive regular file size changed while reading")
    return digest, size


def _archive_files(artifact: Artifact, expected_name: str, expected_version: str):
    expected: dict[str, str] = {}
    package_manifest: bytes | None = None
    seen: set[str] = set()
    try:
        with artifact.open_tar() as archive:
            for member in archive:
                path = _member_relative_path(member)
                key = str(path)
                if key in seen:
                    raise AuditError("archive contains duplicate paths")
                seen.add(key)
                if not member.isfile():
                    continue
                if key == "package/package.json":
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise AuditError("archive package.json could not be read")
                    with stream:
                        package_manifest = stream.read()
                    if len(package_manifest) != member.size:
                        raise AuditError("archive package.json size changed while reading")
                    digest = hashlib.sha256(package_manifest).hexdigest()
                else:
                    digest, _ = _hash_member(archive, member)
                if _is_ignored_own_path(path):
                    continue
                relative = str(PurePosixPath(*path.parts[1:]))
                expected[relative] = digest
    except (OSError, EOFError, tarfile.TarError) as error:
        raise AuditError("archive is not a readable gzip tar archive") from error

    if package_manifest is None:
        raise AuditError("archive is missing package/package.json")
    try:
        manifest = json.loads(package_manifest)
    except json.JSONDecodeError as error:
        raise AuditError("archive package/package.json is not valid JSON") from error
    if not isinstance(manifest, dict):
        raise AuditError("archive package/package.json must be an object")
    if manifest.get("name") != expected_name:
        raise AuditError("archive package name does not match catalog")
    if manifest.get("version") != expected_version:
        raise AuditError("archive package version does not match catalog")
    return expected


def _profile_package_root(profile: Path, name: str) -> Path:
    parts = _check_package_name(name)
    root = profile / "node_modules" / Path(*parts)
    try:
        profile_resolved = profile.resolve(strict=True)
        root_resolved = root.resolve(strict=False)
        root_resolved.relative_to(profile_resolved)
    except (OSError, ValueError):
        # Keep the report generic and avoid echoing local profile paths.
        raise AuditError("installed package directory is outside the profile")
    if root.is_symlink():
        raise AuditError("installed package directory is not a regular directory")
    return root


def _runtime_files(root: Path) -> tuple[dict[str, str], list[str], str | None, list[str]]:
    actual: dict[str, str] = {}
    unsafe: list[str] = []
    installed_version: str | None = None
    read_errors: list[str] = []

    def onerror(error: OSError) -> None:
        read_errors.append("unreadable package directory")

    for current, directories, files in os.walk(root, topdown=True, followlinks=False, onerror=onerror):
        current_path = Path(current)
        kept_directories: list[str] = []
        for directory in directories:
            relative = PurePosixPath(*((current_path / directory).relative_to(root).parts))
            if directory in {"node_modules", ".git"}:
                continue
            candidate = current_path / directory
            if candidate.is_symlink():
                unsafe.append(str(relative))
                continue
            kept_directories.append(directory)
        directories[:] = kept_directories
        for filename in files:
            candidate = current_path / filename
            relative = PurePosixPath(*candidate.relative_to(root).parts)
            if filename.lower() == ".ds_store" or any(
                part in {"node_modules", ".git"} for part in relative.parts
            ):
                continue
            relative_name = str(relative)
            if candidate.is_symlink() or not candidate.is_file():
                unsafe.append(relative_name)
                continue
            try:
                digest, _ = _hash_file(candidate)
            except OSError:
                read_errors.append(relative_name)
                continue
            actual[relative_name] = digest
            if relative_name == "package.json":
                try:
                    manifest = json.loads(candidate.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    read_errors.append("package.json")
                else:
                    if isinstance(manifest, dict) and isinstance(manifest.get("version"), str):
                        installed_version = manifest["version"]
    return actual, sorted(set(unsafe)), installed_version, sorted(set(read_errors))


def _audit_package(package: dict, catalog_dir: Path, profile: Path) -> dict:
    package_id = package.get("id")
    result = {
        "id": package_id,
        "name": package.get("name"),
        "version": package.get("version"),
        "sourceCommit": package.get("sourceCommit"),
        "artifactSHA": None,
        "artifactSize": None,
        "installedVersion": None,
        "missingPaths": [],
        "extraPaths": [],
        "differentPaths": [],
        "mismatchPaths": [],
        "errors": [],
        "ok": False,
    }
    try:
        name = _check_name(package.get("name"), "package.name")
        version = _check_name(package.get("version"), "package.version")
        source_commit = _check_name(package.get("sourceCommit"), "package.sourceCommit")
        if not COMMIT_RE.fullmatch(source_commit):
            raise AuditError("package.sourceCommit has an invalid format")
        artifact = _validate_artifact(package, catalog_dir)
        result["artifactSHA"] = artifact.expected_sha
        result["artifactSize"] = artifact.expected_size
        expected = _archive_files(artifact, name, version)
        root = _profile_package_root(profile, name)
        if not root.exists():
            result["missingPaths"] = sorted(expected)
            result["mismatchPaths"] = sorted(expected)
            result["errors"].append("installed package directory is missing")
            return result
        if not root.is_dir():
            result["errors"].append("installed package directory is not a regular directory")
            return result
        actual, unsafe, installed_version, read_errors = _runtime_files(root)
        result["installedVersion"] = installed_version
        expected_paths = set(expected)
        actual_paths = set(actual)
        result["missingPaths"] = sorted(expected_paths - actual_paths)
        result["extraPaths"] = sorted(actual_paths - expected_paths)
        result["differentPaths"] = sorted(
            path for path in expected_paths & actual_paths if expected[path] != actual[path]
        )
        result["mismatchPaths"] = sorted(
            set(result["missingPaths"])
            | set(result["extraPaths"])
            | set(result["differentPaths"])
            | set(unsafe)
            | set(read_errors)
        )
        if unsafe:
            result["errors"].append("installed package contains an unsafe link or non-regular entry")
        if read_errors:
            result["errors"].append("installed package contains an unreadable file")
        result["ok"] = not result["errors"] and not result["mismatchPaths"]
    except AuditError as error:
        result["errors"].append(str(error))
    return result


def _read_catalog(path: Path) -> tuple[dict, dict[str, dict], list[str]]:
    errors: list[str] = []
    try:
        catalog = _load_json(path, "catalog")
    except AuditError as error:
        return {}, {}, [str(error)]
    if not isinstance(catalog, dict):
        return {}, {}, ["catalog must be an object"]
    if catalog.get("formatVersion") != FORMAT_VERSION:
        errors.append(f"catalog.formatVersion must be {FORMAT_VERSION}")
    packages = catalog.get("packages")
    if not isinstance(packages, list):
        return catalog, {}, errors + ["catalog.packages must be an array"]
    by_id: dict[str, dict] = {}
    for package in packages:
        if not isinstance(package, dict):
            errors.append("catalog package must be an object")
            continue
        package_id = package.get("id")
        if not isinstance(package_id, str) or not package_id:
            errors.append("catalog package id must be a non-empty string")
            continue
        if package_id in by_id:
            errors.append("catalog contains duplicate package id")
            continue
        by_id[package_id] = package
    return catalog, by_id, errors


def _report_summary(report: dict) -> str:
    audits = report.get("audits", [])
    mismatch_count = sum(len(item.get("mismatchPaths", [])) for item in audits)
    error_count = len(report.get("errors", [])) + sum(len(item.get("errors", [])) for item in audits)
    status = "ok" if report.get("exitCode") == 0 else "failed"
    return f"{status}: audited {len(audits)} package(s); mismatches={mismatch_count}; errors={error_count}"


def _write_report(path: Path, report: dict) -> None:
    try:
        with path.open("w", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    except OSError as error:
        raise AuditError("could not write report") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit selected development plugin archives against a profile without installing them.",
        allow_abbrev=False,
    )
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--package-id", action="append", required=True)
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args(argv)

    report: dict = {
        "formatVersion": FORMAT_VERSION,
        "packageIds": list(dict.fromkeys(arguments.package_id)),
        "audits": [],
        "errors": [],
        "mismatchPaths": [],
        "exitCode": 1,
        "ok": False,
    }
    try:
        catalog_path = arguments.catalog
        if catalog_path.is_symlink():
            raise AuditError("catalog must be a regular, non-symlink file")
        if arguments.profile.is_symlink():
            raise AuditError("profile must be a regular directory")
        profile = arguments.profile.resolve(strict=True)
        if not profile.is_dir():
            raise AuditError("profile must be a regular directory")
        catalog, by_id, catalog_errors = _read_catalog(catalog_path)
        report["errors"].extend(catalog_errors)
        catalog_dir = catalog_path.resolve(strict=True).parent
        selected_ids = report["packageIds"]
        for package_id in selected_ids:
            package = by_id.get(package_id)
            if package is None:
                report["errors"].append(f"unknown catalog package id {package_id!r}")
                continue
            report["audits"].append(_audit_package(package, catalog_dir, profile))
        all_mismatches: set[str] = set()
        for item in report["audits"]:
            all_mismatches.update(item.get("mismatchPaths", []))
        report["mismatchPaths"] = sorted(all_mismatches)
        if report["errors"] or any(not item.get("ok") for item in report["audits"]):
            report["exitCode"] = 1
        else:
            report["exitCode"] = 0
            report["ok"] = True
    except (AuditError, OSError) as error:
        report["errors"].append(str(error))
        report["exitCode"] = 1

    if arguments.report is not None:
        try:
            _write_report(arguments.report, report)
        except AuditError as error:
            report["errors"].append(str(error))
            report["exitCode"] = 1
        print(_report_summary(report))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        print(_report_summary(report), file=sys.stderr)
    return int(report["exitCode"])


if __name__ == "__main__":
    raise SystemExit(main())
