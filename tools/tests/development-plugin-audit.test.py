#!/usr/bin/env python3
"""Isolated tests for tools/audit-development-plugins.py."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "audit-development-plugins.py"


class AuditFixture:
    package_id = "fixture-plugin"
    package_name = "@fixture/example"
    package_version = "1.2.3"
    source_commit = "a" * 40

    def __init__(self, root: Path):
        self.root = root
        self.catalog_dir = root / "catalog"
        self.catalog_dir.mkdir()
        self.artifact_dir = self.catalog_dir / "artifacts"
        self.artifact_dir.mkdir()
        self.profile = root / "profile-one"
        self.profile.mkdir()
        self.archive_path = self.artifact_dir / "fixture.tgz"
        self.catalog_path = self.catalog_dir / "catalog.json"
        self._write_archive()
        self._write_catalog()
        self.install_profile()

    @property
    def package_dir(self) -> Path:
        return self.profile / "node_modules" / "@fixture" / "example"

    def manifest_bytes(self) -> bytes:
        return json.dumps(
            {"name": self.package_name, "version": self.package_version},
            separators=(",", ":"),
        ).encode("utf-8")

    def archive_files(self) -> dict[str, bytes]:
        return {
            "package.json": self.manifest_bytes(),
            "lib/index.js": b"export const fixture = true;\n",
            # These entries are present in a package but outside the own-file
            # scope used by the auditor.
            "node_modules/ignored/index.js": b"ignored nested dependency\n",
            ".git/config": b"ignored git metadata\n",
            ".DS_Store": b"ignored finder metadata\n",
        }

    def _write_archive(self, unsafe: str | None = None) -> None:
        with tarfile.open(self.archive_path, "w:gz") as archive:
            for relative, data in self.archive_files().items():
                member = tarfile.TarInfo(f"package/{relative}")
                member.size = len(data)
                member.mode = 0o644
                archive.addfile(member, io.BytesIO(data))
            if unsafe == "symlink":
                member = tarfile.TarInfo("package/link")
                member.type = tarfile.SYMTYPE
                member.linkname = "package.json"
                archive.addfile(member)
            elif unsafe == "traversal":
                member = tarfile.TarInfo("package/../outside")
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))

    def _write_catalog(self, artifact: dict | None = None) -> None:
        if artifact is None:
            data = self.archive_path.read_bytes()
            artifact = {
                "file": "artifacts/fixture.tgz",
                "sha256": hashlib.sha256(data).hexdigest(),
                "size": len(data),
            }
        catalog = {
            "formatVersion": 1,
            "snapshotCapturedAt": "2026-10-23T00:00:00Z",
            "packages": [
                {
                    "id": self.package_id,
                    "name": self.package_name,
                    "version": self.package_version,
                    "sourceRepo": "https://example.invalid/source",
                    "sourceCommit": self.source_commit,
                    "artifact": artifact,
                    "requiredPackageIds": [],
                    "validationScope": {
                        "source": {"status": "not-run"},
                        "scratch": {"status": "not-run"},
                        "ui": {"status": "not-run"},
                        "live": {"status": "not-run"},
                    },
                }
            ],
            "excludedPackages": [],
        }
        self.catalog_path.write_text(json.dumps(catalog), encoding="utf-8")

    def configure_split_artifact(self) -> None:
        payload = self.archive_path.read_bytes()
        midpoint = max(1, len(payload) // 2)
        parts = []
        for index, chunk in enumerate((payload[:midpoint], payload[midpoint:])):
            path = self.artifact_dir / f"fixture.tgz.part{index:02d}"
            path.write_bytes(chunk)
            parts.append(
                {
                    "file": f"artifacts/{path.name}",
                    "sha256": hashlib.sha256(chunk).hexdigest(),
                    "size": len(chunk),
                }
            )
        catalog = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        catalog["packages"][0]["artifact"] = {
            "parts": parts,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size": len(payload),
        }
        self.catalog_path.write_text(json.dumps(catalog), encoding="utf-8")

    def install_profile(self, profile: Path | None = None) -> Path:
        profile = profile or self.profile
        package_dir = profile / "node_modules" / "@fixture" / "example"
        package_dir.mkdir(parents=True, exist_ok=True)
        for relative, data in self.archive_files().items():
            if relative.startswith("node_modules/") or relative.startswith(".git/"):
                continue
            destination = package_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        nested = package_dir / "node_modules" / "runtime-only"
        nested.mkdir(parents=True)
        (nested / "extra.js").write_text("ignored nested runtime file", encoding="utf-8")
        (package_dir / ".git").mkdir()
        (package_dir / ".git" / "state").write_text("ignored git runtime file", encoding="utf-8")
        (package_dir / ".DS_Store").write_bytes(b"ignored")
        return package_dir


class DevelopmentPluginAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="development-plugin-audit-")
        self.fixture = AuditFixture(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def run_audit(self, profile: Path | None = None, *extra: str):
        command = [
            sys.executable,
            str(SCRIPT),
            "--catalog",
            str(self.fixture.catalog_path),
            "--profile",
            str(profile or self.fixture.profile),
            "--package-id",
            self.fixture.package_id,
            *extra,
        ]
        return subprocess.run(command, capture_output=True, text=True, check=False)

    def run_with_package_id(self, package_id: str):
        command = [
            sys.executable,
            str(SCRIPT),
            "--catalog",
            str(self.fixture.catalog_path),
            "--profile",
            str(self.fixture.profile),
            "--package-id",
            package_id,
        ]
        return subprocess.run(command, capture_output=True, text=True, check=False)

    @staticmethod
    def report(result: subprocess.CompletedProcess) -> dict:
        return json.loads(result.stdout)

    def test_identical_profile_passes(self):
        result = self.run_audit()
        report = self.report(result)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(report["ok"])
        audit = report["audits"][0]
        self.assertEqual(audit["sourceCommit"], self.fixture.source_commit)
        self.assertEqual(audit["installedVersion"], self.fixture.package_version)
        self.assertEqual(audit["mismatchPaths"], [])
        self.assertRegex(audit["artifactSHA"], r"^[0-9a-f]{64}$")
        self.assertIn("ok: audited 1 package", result.stderr)

    def test_same_version_runtime_bytes_are_checked(self):
        (self.fixture.package_dir / "lib" / "index.js").write_bytes(b"tampered\n")
        result = self.run_audit()
        report = self.report(result)
        self.assertNotEqual(result.returncode, 0)
        audit = report["audits"][0]
        self.assertEqual(audit["installedVersion"], self.fixture.package_version)
        self.assertEqual(audit["differentPaths"], ["lib/index.js"])
        self.assertIn("lib/index.js", audit["mismatchPaths"])

    def test_missing_and_extra_own_files_fail(self):
        (self.fixture.package_dir / "lib" / "index.js").unlink()
        (self.fixture.package_dir / "extra.js").write_bytes(b"extra\n")
        result = self.run_audit()
        audit = self.report(result)["audits"][0]
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(audit["missingPaths"], ["lib/index.js"])
        self.assertEqual(audit["extraPaths"], ["extra.js"])

    def test_missing_package_directory_reports_own_paths(self):
        shutil.rmtree(self.fixture.package_dir)
        result = self.run_audit()
        audit = self.report(result)["audits"][0]
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("package.json", audit["missingPaths"])
        self.assertIn("lib/index.js", audit["missingPaths"])

    def test_bad_checksum_fails_without_reading_profile_payload(self):
        catalog = json.loads(self.fixture.catalog_path.read_text(encoding="utf-8"))
        catalog["packages"][0]["artifact"]["sha256"] = "0" * 64
        self.fixture.catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        result = self.run_audit()
        report = self.report(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("artifact SHA-256 mismatch", report["audits"][0]["errors"])

    def test_unknown_catalog_id_is_nonzero(self):
        result = self.run_with_package_id("not-in-catalog")
        report = self.report(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown catalog package id 'not-in-catalog'", report["errors"])

    def test_source_commit_format_is_checked(self):
        catalog = json.loads(self.fixture.catalog_path.read_text(encoding="utf-8"))
        catalog["packages"][0]["sourceCommit"] = "not-a-commit"
        self.fixture.catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        result = self.run_audit()
        audit = self.report(result)["audits"][0]
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("package.sourceCommit has an invalid format", audit["errors"])

    def test_unsafe_tar_path_and_symlink_fail(self):
        for unsafe in ("traversal", "symlink"):
            with self.subTest(unsafe=unsafe):
                self.fixture._write_archive(unsafe=unsafe)
                data = self.fixture.archive_path.read_bytes()
                catalog = json.loads(self.fixture.catalog_path.read_text(encoding="utf-8"))
                catalog["packages"][0]["artifact"] = {
                    "file": "artifacts/fixture.tgz",
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "size": len(data),
                }
                self.fixture.catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
                result = self.run_audit()
                report = self.report(result)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(report["audits"][0]["errors"])

    def test_two_profile_directories_have_same_result(self):
        profile_two = Path(self.temporary.name) / "profile-two"
        shutil.copytree(self.fixture.profile, profile_two)
        first = self.run_audit(self.fixture.profile)
        second = self.run_audit(profile_two)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 0)
        first_audit = self.report(first)["audits"][0]
        second_audit = self.report(second)["audits"][0]
        self.assertEqual(first_audit["artifactSHA"], second_audit["artifactSHA"])
        self.assertEqual(first_audit["mismatchPaths"], second_audit["mismatchPaths"])

    def test_report_path_writes_machine_readable_json(self):
        report_path = Path(self.temporary.name) / "private-report.json"
        result = self.run_audit(None, "--report", str(report_path))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(result.stdout.startswith("ok: audited 1 package"))
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["exitCode"], 0)
        self.assertTrue(report["ok"])

    def test_split_artifact_is_streamed_without_reassembly(self):
        self.fixture.configure_split_artifact()
        result = self.run_audit()
        self.assertEqual(result.returncode, 0)
        self.assertTrue(self.report(result)["ok"])


if __name__ == "__main__":
    unittest.main()
