#!/usr/bin/env python3
"""Validate the immutable curated-plugin artifact catalog.

The catalog records exact archive bytes.  This checker intentionally does not
fetch, install, or execute a plugin; it validates only the checked-in artifact
directory and the metadata that an installer consumes.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile


FORMAT_VERSION = 1
MAX_PART_SIZE = 40 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
RASTER_OR_WALLPAPER_RE = re.compile(
    r"(?:wallpaper|\.jpe?g$|\.png$|\.webp$|\.gif$|\.heic$|\.tiff?$|\.bmp$)",
    re.IGNORECASE,
)
FORBIDDEN_PATH_PARTS = {".git", ".hg", ".svn", "__macosx", "node_modules", ".ssh", ".aws"}
FORBIDDEN_FILE_NAMES = {
    ".ds_store",
    ".env",
    ".npmrc",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "credentials.json",
}
SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----"),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"\bgh[pousr]_[A-Za-z0-9_]{30,}\b"),
    re.compile(rb"\bsk-[A-Za-z0-9]{32,}\b"),
)
TEXT_SCAN_LIMIT = 1024 * 1024


class Reporter:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.nested_payloads = []

    def error(self, message):
        self.errors.append(message)

    def warning(self, message):
        self.warnings.append(message)


def hash_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def hash_stream(stream, destination=None):
    digest = hashlib.sha256()
    total = 0
    while True:
        block = stream.read(1024 * 1024)
        if not block:
            break
        digest.update(block)
        total += len(block)
        if destination is not None:
            destination.write(block)
    return digest.hexdigest(), total


def read_json(path, reporter, label):
    try:
        with path.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, json.JSONDecodeError) as error:
        reporter.error(f"{label} is not valid JSON: {error}")
        return None


def require_mapping(value, reporter, label):
    if not isinstance(value, dict):
        reporter.error(f"{label} must be an object")
        return {}
    return value


def require_list(value, reporter, label):
    if not isinstance(value, list):
        reporter.error(f"{label} must be an array")
        return []
    return value


def expect_keys(mapping, allowed, reporter, label):
    unexpected = sorted(set(mapping) - set(allowed))
    if unexpected:
        reporter.error(f"{label} has unsupported field(s): {', '.join(unexpected)}")


def require_string(mapping, key, reporter, label, pattern=None):
    value = mapping.get(key)
    if not isinstance(value, str) or not value:
        reporter.error(f"{label}.{key} must be a non-empty string")
        return ""
    if pattern is not None and not pattern.fullmatch(value):
        reporter.error(f"{label}.{key} has an invalid value")
    return value


def require_integer(mapping, key, reporter, label):
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        reporter.error(f"{label}.{key} must be a non-negative integer")
        return 0
    return value


def safe_relative_path(raw, base, reporter, label):
    if not isinstance(raw, str) or not raw:
        reporter.error(f"{label} must be a non-empty relative path")
        return None
    candidate = PurePosixPath(raw)
    if candidate.is_absolute() or any(part in ("", ".", "..") for part in candidate.parts):
        reporter.error(f"{label} is not a safe relative path")
        return None
    path = base.joinpath(*candidate.parts)
    try:
        resolved_base = base.resolve(strict=True)
        resolved_path = path.resolve(strict=True)
        resolved_path.relative_to(resolved_base)
    except (OSError, ValueError):
        reporter.error(f"{label} escapes the curated artifact directory or does not exist")
        return None
    if not resolved_path.is_file() or resolved_path.is_symlink():
        reporter.error(f"{label} must name a regular, non-symlink file")
        return None
    return resolved_path


def check_digest_and_size(path, expected_sha, expected_size, reporter, label):
    if not SHA256_RE.fullmatch(expected_sha):
        reporter.error(f"{label}.sha256 must be a lowercase SHA-256 digest")
        return
    actual_size = path.stat().st_size
    if actual_size != expected_size:
        reporter.error(f"{label} has size {actual_size}, expected {expected_size}")
    actual_sha = hash_file(path)
    if actual_sha != expected_sha:
        reporter.error(f"{label} has SHA-256 {actual_sha}, expected {expected_sha}")


def safe_link_target(member, reporter, label):
    target = PurePosixPath(member.linkname)
    if target.is_absolute():
        reporter.error(f"{label} has an absolute link target in {member.name!r}")
        return False
    destination_parts = []
    for part in list(PurePosixPath(member.name).parent.parts) + list(target.parts):
        if part in ("", "."):
            continue
        if part == "..":
            if not destination_parts:
                reporter.error(f"{label} has a link target escaping the archive in {member.name!r}")
                return False
            destination_parts.pop()
        else:
            destination_parts.append(part)
    return bool(destination_parts)


def tar_member_is_safe(member, reporter, label, require_package_root, allow_links=False):
    name = member.name
    path = PurePosixPath(name)
    if name.startswith("/") or any(part in ("", ".", "..") for part in path.parts):
        reporter.error(f"{label} has unsafe archive path {name!r}")
        return False
    lowered = [part.lower() for part in path.parts]
    if any(part in FORBIDDEN_PATH_PARTS for part in lowered):
        reporter.error(f"{label} has unexpected archive path {name!r}")
        return False
    if path.name.lower() in FORBIDDEN_FILE_NAMES:
        reporter.error(f"{label} has a possible credential file {name!r}")
        return False
    if require_package_root and (not path.parts or path.parts[0] != "package"):
        reporter.error(f"{label} has entry outside npm package root: {name!r}")
        return False
    if (member.issym() or member.islnk()) and not allow_links:
        reporter.error(f"{label} has unsupported link entry {name!r}")
        return False
    if (member.issym() or member.islnk()) and not safe_link_target(member, reporter, label):
        return False
    if member.isdev():
        reporter.error(f"{label} has unsupported device entry {name!r}")
        return False
    return True


def scan_member_for_secrets(archive, member, reporter, label):
    if not member.isfile() or member.size > TEXT_SCAN_LIMIT:
        return
    source_suffixes = {
        ".c",
        ".cc",
        ".cpp",
        ".cs",
        ".go",
        ".h",
        ".hpp",
        ".java",
        ".js",
        ".jsx",
        ".m",
        ".md",
        ".py",
        ".rb",
        ".rs",
        ".sh",
        ".swift",
        ".ts",
        ".tsx",
    }
    if PurePosixPath(member.name).suffix.lower() in source_suffixes:
        return
    try:
        stream = archive.extractfile(member)
        if stream is None:
            reporter.error(f"{label} could not read {member.name!r}")
            return
        data = stream.read(TEXT_SCAN_LIMIT + 1)
    except (OSError, tarfile.TarError) as error:
        reporter.error(f"{label} could not inspect {member.name!r}: {error}")
        return
    if b"\x00" in data:
        return
    for pattern in SECRET_PATTERNS:
        if pattern.search(data):
            reporter.error(f"{label} has a high-confidence credential pattern in {member.name!r}")
            return


def check_license_contents(data, expected_spdx, reporter, label):
    if expected_spdx == "MIT" and b"MIT License" not in data:
        reporter.error(f"{label} does not contain the expected MIT license text")


def read_member_bytes(archive, path, reporter, label):
    try:
        member = archive.getmember(path)
    except KeyError:
        reporter.error(f"{label} is missing archive entry {path!r}")
        return None
    if not member.isfile():
        reporter.error(f"{label} archive entry {path!r} is not a regular file")
        return None
    try:
        stream = archive.extractfile(member)
        if stream is None:
            raise tarfile.ExtractError("no stream")
        return stream.read()
    except (OSError, tarfile.TarError) as error:
        reporter.error(f"{label} could not read archive entry {path!r}: {error}")
        return None


def check_sidecar_license(
    base,
    raw_path,
    expected_spdx,
    expected_sha,
    expected_size,
    reporter,
    label,
    referenced_files,
):
    path = safe_relative_path(raw_path, base, reporter, label)
    if path is None:
        return
    referenced_files.add(path)
    try:
        data = path.read_bytes()
    except OSError as error:
        reporter.error(f"{label} could not be read: {error}")
        return
    if not data:
        reporter.error(f"{label} is empty")
        return
    check_digest_and_size(path, expected_sha, expected_size, reporter, label)
    check_license_contents(data, expected_spdx, reporter, label)


def check_nested_payload(outer, provenance, reporter, package_label):
    nested = provenance.get("nestedPayload")
    if nested is None:
        return
    nested = require_mapping(nested, reporter, f"{package_label}.provenance.nestedPayload")
    expect_keys(
        nested,
        {"archive", "sha256", "sourceCommit", "licenseEntries", "licenseManifest"},
        reporter,
        f"{package_label}.provenance.nestedPayload",
    )
    archive_name = require_string(nested, "archive", reporter, f"{package_label}.provenance.nestedPayload")
    expected_sha = require_string(
        nested, "sha256", reporter, f"{package_label}.provenance.nestedPayload", SHA256_RE
    )
    source_commit = require_string(
        nested, "sourceCommit", reporter, f"{package_label}.provenance.nestedPayload", COMMIT_RE
    )
    license_entries = require_list(
        nested.get("licenseEntries"), reporter, f"{package_label}.provenance.nestedPayload.licenseEntries"
    )
    license_manifest = require_string(
        nested, "licenseManifest", reporter, f"{package_label}.provenance.nestedPayload"
    )
    nested_bytes = read_member_bytes(outer, archive_name, reporter, package_label)
    if nested_bytes is None:
        return
    actual_sha = hashlib.sha256(nested_bytes).hexdigest()
    if actual_sha != expected_sha:
        reporter.error(
            f"{package_label} nested payload has SHA-256 {actual_sha}, expected {expected_sha}"
        )
        return
    manifest_bytes = read_member_bytes(outer, license_manifest, reporter, package_label)
    if manifest_bytes is not None:
        try:
            manifest = json.loads(manifest_bytes)
        except json.JSONDecodeError as error:
            reporter.error(f"{package_label} nested license manifest is invalid JSON: {error}")
        else:
            if not isinstance(manifest, dict) or manifest.get("source_commit") != source_commit:
                reporter.error(
                    f"{package_label} nested license manifest does not record source commit {source_commit}"
                )
            if not isinstance(manifest, dict) or not isinstance(manifest.get("packages"), list):
                reporter.error(f"{package_label} nested license manifest has no packages list")
    with tempfile.NamedTemporaryFile(prefix="curated-nested-", suffix=".tar.gz") as stream:
        stream.write(nested_bytes)
        stream.flush()
        try:
            with tarfile.open(stream.name, mode="r:gz") as archive:
                safe_names = set()
                for member in archive.getmembers():
                    if tar_member_is_safe(
                        member, reporter, f"{package_label} nested payload", False, allow_links=True
                    ):
                        safe_names.add(member.name)
                        scan_member_for_secrets(
                            archive, member, reporter, f"{package_label} nested payload"
                        )
                for entry in license_entries:
                    if not isinstance(entry, str) or not entry:
                        reporter.error(
                            f"{package_label}.provenance.nestedPayload.licenseEntries must contain paths"
                        )
                    elif entry not in safe_names:
                        reporter.error(
                            f"{package_label} nested payload is missing license entry {entry!r}"
                        )
        except (OSError, tarfile.TarError) as error:
            reporter.error(f"{package_label} nested payload is not a readable gzip tar archive: {error}")
            return
    reporter.nested_payloads.append(f"{package_label}: {archive_name} ({source_commit})")


def check_archive(path, package, base, reporter, package_label, referenced_files):
    license_data = package["license"]
    expected_name = package["name"]
    expected_version = package["version"]
    expected_spdx = license_data["spdx"]
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            members = archive.getmembers()
            safe_names = set()
            for member in members:
                if tar_member_is_safe(member, reporter, package_label, True):
                    safe_names.add(member.name)
                    scan_member_for_secrets(archive, member, reporter, package_label)
            package_json = read_member_bytes(archive, "package/package.json", reporter, package_label)
            if package_json is not None:
                try:
                    manifest = json.loads(package_json)
                except json.JSONDecodeError as error:
                    reporter.error(f"{package_label} package/package.json is invalid JSON: {error}")
                else:
                    if manifest.get("name") != expected_name:
                        reporter.error(
                            f"{package_label} package name {manifest.get('name')!r}, expected {expected_name!r}"
                        )
                    if manifest.get("version") != expected_version:
                        reporter.error(
                            f"{package_label} package version {manifest.get('version')!r}, expected {expected_version!r}"
                        )
                    if manifest.get("license") != expected_spdx:
                        reporter.error(
                            f"{package_label} package license {manifest.get('license')!r}, expected {expected_spdx!r}"
                        )
            license_file = license_data["licenseFile"]
            if license_file.startswith("package/"):
                data = read_member_bytes(archive, license_file, reporter, package_label)
                if data is not None:
                    check_license_contents(data, expected_spdx, reporter, f"{package_label} {license_file}")
            else:
                check_sidecar_license(
                    base,
                    license_file,
                    expected_spdx,
                    license_data["sha256"],
                    license_data["size"],
                    reporter,
                    f"{package_label}.license.licenseFile",
                    referenced_files,
                )
            provenance = package.get("provenance")
            if provenance is not None:
                provenance = require_mapping(provenance, reporter, f"{package_label}.provenance")
                nested = provenance.get("nestedPayload")
                if nested is not None:
                    check_nested_payload(archive, provenance, reporter, package_label)
                findings = provenance.get("archiveFindings")
                if isinstance(findings, dict) and findings.get("personalWallpaperAssets") == "not-found-by-name-or-raster-extension":
                    matches = sorted(name for name in safe_names if RASTER_OR_WALLPAPER_RE.search(name))
                    if matches:
                        reporter.error(
                            f"{package_label} catalog says no personal wallpaper assets, but archive has: "
                            + ", ".join(matches)
                        )
    except (OSError, tarfile.TarError) as error:
        reporter.error(f"{package_label} is not a readable gzip tar archive: {error}")


def check_historical_artifacts(package, base, reporter, package_label, referenced_files):
    history = package.get("historicalArtifacts")
    if history is None:
        return
    history = require_list(history, reporter, f"{package_label}.historicalArtifacts")
    for index, entry in enumerate(history):
        label = f"{package_label}.historicalArtifacts[{index}]"
        entry = require_mapping(entry, reporter, label)
        expect_keys(
            entry,
            {"sourceCommit", "file", "sha256", "size", "origin", "installableCandidate"},
            reporter,
            label,
        )
        require_string(entry, "sourceCommit", reporter, label, COMMIT_RE)
        path = safe_relative_path(entry.get("file"), base, reporter, f"{label}.file")
        expected_sha = require_string(entry, "sha256", reporter, label, SHA256_RE)
        expected_size = require_integer(entry, "size", reporter, label)
        require_string(entry, "origin", reporter, label)
        if entry.get("installableCandidate") is not False:
            reporter.error(f"{label}.installableCandidate must be false")
        if path is None:
            continue
        referenced_files.add(path)
        check_digest_and_size(path, expected_sha, expected_size, reporter, label)
        check_archive(path, package, base, reporter, f"{label}", referenced_files)


def validate_validation_scope(value, reporter, label):
    scope = require_mapping(value, reporter, label)
    expected = {"source", "scratch", "ui", "live"}
    if set(scope) != expected:
        reporter.error(f"{label} must contain exactly source, scratch, ui, and live")
        return
    for name in sorted(expected):
        entry = require_mapping(scope.get(name), reporter, f"{label}.{name}")
        status = entry.get("status")
        if not isinstance(status, str) or not status:
            reporter.error(f"{label}.{name}.status must be a non-empty string")


def validate_package(package, base, reporter, ids, referenced_files):
    package = require_mapping(package, reporter, "catalog package")
    expected_fields = {
        "id",
        "name",
        "version",
        "sourceRepo",
        "sourceCommit",
        "artifact",
        "historicalArtifacts",
        "license",
        "provenance",
        "requiredPackageIds",
        "validationScope",
    }
    expect_keys(package, expected_fields, reporter, "catalog package")
    package_id = require_string(package, "id", reporter, "catalog package", ID_RE)
    if package_id:
        if package_id in ids:
            reporter.error(f"catalog has duplicate package id {package_id!r}")
        ids.add(package_id)
    name = require_string(package, "name", reporter, f"package {package_id}")
    version = require_string(package, "version", reporter, f"package {package_id}")
    source_repo = require_string(package, "sourceRepo", reporter, f"package {package_id}")
    if source_repo and not source_repo.startswith("https://"):
        reporter.error(f"package {package_id}.sourceRepo must be an HTTPS URL")
    require_string(package, "sourceCommit", reporter, f"package {package_id}", COMMIT_RE)
    if not name or not version:
        return package
    license_data = require_mapping(package.get("license"), reporter, f"package {package_id}.license")
    expect_keys(
        license_data,
        {"spdx", "licenseFile", "sha256", "size"},
        reporter,
        f"package {package_id}.license",
    )
    spdx = require_string(license_data, "spdx", reporter, f"package {package_id}.license")
    license_file = require_string(license_data, "licenseFile", reporter, f"package {package_id}.license")
    if license_file.startswith("package/"):
        if "sha256" in license_data or "size" in license_data:
            reporter.error(
                f"package {package_id}.license embeds its license and must not declare sidecar sha256 or size"
            )
        package["license"] = {"spdx": spdx, "licenseFile": license_file}
    else:
        license_sha = require_string(
            license_data, "sha256", reporter, f"package {package_id}.license", SHA256_RE
        )
        license_size = require_integer(
            license_data, "size", reporter, f"package {package_id}.license"
        )
        package["license"] = {
            "spdx": spdx,
            "licenseFile": license_file,
            "sha256": license_sha,
            "size": license_size,
        }
    required = require_list(
        package.get("requiredPackageIds"), reporter, f"package {package_id}.requiredPackageIds"
    )
    if len(required) != len(set(required)):
        reporter.error(f"package {package_id}.requiredPackageIds has duplicates")
    for dependency in required:
        if not isinstance(dependency, str) or not ID_RE.fullmatch(dependency):
            reporter.error(f"package {package_id}.requiredPackageIds contains an invalid id")
    validate_validation_scope(
        package.get("validationScope"), reporter, f"package {package_id}.validationScope"
    )
    artifact = require_mapping(package.get("artifact"), reporter, f"package {package_id}.artifact")
    if "file" in artifact and "parts" in artifact:
        reporter.error(f"package {package_id}.artifact cannot contain both file and parts")
        return package
    if "file" not in artifact and "parts" not in artifact:
        reporter.error(f"package {package_id}.artifact must contain file or parts")
        return package
    expected_sha = require_string(artifact, "sha256", reporter, f"package {package_id}.artifact", SHA256_RE)
    expected_size = require_integer(artifact, "size", reporter, f"package {package_id}.artifact")
    if "file" in artifact:
        expect_keys(artifact, {"file", "sha256", "size"}, reporter, f"package {package_id}.artifact")
        path = safe_relative_path(
            artifact.get("file"), base, reporter, f"package {package_id}.artifact.file"
        )
        if path is not None:
            referenced_files.add(path)
            check_digest_and_size(path, expected_sha, expected_size, reporter, f"package {package_id}.artifact")
            check_archive(path, package, base, reporter, f"package {package_id}", referenced_files)
        check_historical_artifacts(package, base, reporter, f"package {package_id}", referenced_files)
        return package
    expect_keys(artifact, {"parts", "sha256", "size"}, reporter, f"package {package_id}.artifact")
    parts = require_list(artifact.get("parts"), reporter, f"package {package_id}.artifact.parts")
    if not parts:
        reporter.error(f"package {package_id}.artifact.parts must not be empty")
        return package
    digest = hashlib.sha256()
    total_size = 0
    paths = []
    for index, part in enumerate(parts):
        part = require_mapping(part, reporter, f"package {package_id}.artifact.parts[{index}]")
        expect_keys(
            part,
            {"file", "sha256", "size"},
            reporter,
            f"package {package_id}.artifact.parts[{index}]",
        )
        file_name = require_string(
            part, "file", reporter, f"package {package_id}.artifact.parts[{index}]"
        )
        if not file_name.endswith(f".part{index:02d}"):
            reporter.error(
                f"package {package_id}.artifact.parts[{index}].file must end in .part{index:02d}"
            )
        part_sha = require_string(
            part,
            "sha256",
            reporter,
            f"package {package_id}.artifact.parts[{index}]",
            SHA256_RE,
        )
        part_size = require_integer(
            part, "size", reporter, f"package {package_id}.artifact.parts[{index}]"
        )
        if part_size > MAX_PART_SIZE:
            reporter.error(
                f"package {package_id}.artifact.parts[{index}] exceeds {MAX_PART_SIZE} bytes"
            )
        path = safe_relative_path(
            file_name, base, reporter, f"package {package_id}.artifact.parts[{index}].file"
        )
        if path is None:
            continue
        referenced_files.add(path)
        check_digest_and_size(
            path, part_sha, part_size, reporter, f"package {package_id}.artifact.parts[{index}]"
        )
        paths.append(path)
        total_size += path.stat().st_size
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    if total_size != expected_size:
        reporter.error(
            f"package {package_id} reassembled size {total_size}, expected {expected_size}"
        )
    if digest.hexdigest() != expected_sha:
        reporter.error(
            f"package {package_id} reassembled SHA-256 {digest.hexdigest()}, expected {expected_sha}"
        )
    if len(paths) == len(parts):
        with tempfile.TemporaryDirectory(prefix="curated-reassembly-") as temporary:
            assembled = Path(temporary) / "package.tgz"
            with assembled.open("wb") as output:
                for path in paths:
                    with path.open("rb") as input_stream:
                        shutil.copyfileobj(input_stream, output, 1024 * 1024)
            check_archive(assembled, package, base, reporter, f"package {package_id}", referenced_files)
    check_historical_artifacts(package, base, reporter, f"package {package_id}", referenced_files)
    return package


def validate_dependency_graph(packages, ids, reporter):
    packages_by_id = {package.get("id"): package for package in packages if isinstance(package, dict)}
    for package_id, package in packages_by_id.items():
        for dependency in package.get("requiredPackageIds", []):
            if dependency not in ids:
                reporter.error(f"package {package_id} requires unknown package id {dependency!r}")
    visiting = set()
    visited = set()

    def visit(package_id):
        if package_id in visited:
            return
        if package_id in visiting:
            reporter.error(f"catalog has a requiredPackageIds cycle at {package_id!r}")
            return
        visiting.add(package_id)
        package = packages_by_id.get(package_id, {})
        for dependency in package.get("requiredPackageIds", []):
            if dependency in packages_by_id:
                visit(dependency)
        visiting.remove(package_id)
        visited.add(package_id)

    for package_id in sorted(packages_by_id):
        visit(package_id)


def validate_excluded(excluded, package_ids, reporter):
    seen = set()
    for index, item in enumerate(excluded):
        item = require_mapping(item, reporter, f"excludedPackages[{index}]")
        expect_keys(
            item,
            {"id", "name", "sourceCommit", "status", "reason"},
            reporter,
            f"excludedPackages[{index}]",
        )
        package_id = require_string(item, "id", reporter, f"excludedPackages[{index}]", ID_RE)
        if package_id in seen:
            reporter.error(f"excludedPackages has duplicate id {package_id!r}")
        seen.add(package_id)
        if package_id in package_ids:
            reporter.error(f"package id {package_id!r} is both included and excluded")
        require_string(item, "name", reporter, f"excludedPackages[{index}]")
        require_string(
            item, "sourceCommit", reporter, f"excludedPackages[{index}]", COMMIT_RE
        )
        require_string(item, "status", reporter, f"excludedPackages[{index}]")
        require_string(item, "reason", reporter, f"excludedPackages[{index}]")


def validate_unexpected_files(base, referenced_files, reporter):
    allowed = {base / "catalog.json"}
    allowed.update(referenced_files)
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        resolved = path.resolve()
        if resolved not in allowed:
            try:
                relative = path.relative_to(base)
            except ValueError:
                relative = path
            reporter.error(f"unexpected checked-in curated artifact file {relative}")


def main():
    parser = argparse.ArgumentParser(
        description="Validate distribution/plugins/catalog.json and its exact archived bytes."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (used by fixture tests)",
    )
    parser.add_argument("--json", action="store_true", help="emit a machine-readable result")
    arguments = parser.parse_args()
    base = arguments.root.resolve() / "distribution" / "plugins"
    reporter = Reporter()
    catalog_path = base / "catalog.json"
    catalog = read_json(catalog_path, reporter, "catalog")
    package_count = 0
    if isinstance(catalog, dict):
        expect_keys(
            catalog,
            {"formatVersion", "snapshotCapturedAt", "packages", "excludedPackages"},
            reporter,
            "catalog",
        )
        if catalog.get("formatVersion") != FORMAT_VERSION:
            reporter.error(f"catalog.formatVersion must be {FORMAT_VERSION}")
        snapshot = catalog.get("snapshotCapturedAt")
        if not isinstance(snapshot, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", snapshot
        ):
            reporter.error("catalog.snapshotCapturedAt must be a UTC timestamp")
        packages = require_list(catalog.get("packages"), reporter, "catalog.packages")
        ids = set()
        referenced_files = set()
        normalized_packages = []
        for package in packages:
            normalized_packages.append(
                validate_package(package, base, reporter, ids, referenced_files)
            )
        package_count = len(normalized_packages)
        validate_dependency_graph(normalized_packages, ids, reporter)
        excluded = require_list(catalog.get("excludedPackages"), reporter, "catalog.excludedPackages")
        validate_excluded(excluded, ids, reporter)
        validate_unexpected_files(base, referenced_files, reporter)
    if arguments.json:
        print(
            json.dumps(
                {
                    "ok": not reporter.errors,
                    "packages": package_count,
                    "errors": reporter.errors,
                    "warnings": reporter.warnings,
                    "nestedPayloads": reporter.nested_payloads,
                },
                indent=2,
            )
        )
    else:
        for warning in reporter.warnings:
            print(f"warning: {warning}", file=sys.stderr)
        for error in reporter.errors:
            print(f"error: {error}", file=sys.stderr)
        if not reporter.errors:
            print(
                f"ok: {package_count} curated package(s) validated; "
                f"{len(reporter.nested_payloads)} nested payload provenance record(s) verified."
            )
    return 1 if reporter.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
