"""The copied collector files match the source manifest, so a local edit cannot pass as the Workbench code."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import unittest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PACKAGE_ROOT.parents[1]
MANIFEST = REPOSITORY_ROOT / "distribution" / "workbench-scheduling-sources.json"
DESTINATION_PREFIX = "python/scheduling-evidence/"


def _copied_entries() -> list[dict]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return [
        entry
        for entry in manifest["files"]
        if entry["action"] == "copy" and str(entry["destination"]).startswith(DESTINATION_PREFIX)
    ]


class SourceManifestTests(unittest.TestCase):
    def test_manifest_names_the_mac_mini_main_as_the_copy_baseline(self) -> None:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["sources"]["B"]["commit"], "b358d53978ebc90c53e842c1626011cf40e73b6a")
        self.assertEqual({entry["baseline"] for entry in _copied_entries()}, {"B"})

    def test_every_copied_file_matches_its_recorded_hash(self) -> None:
        entries = _copied_entries()
        self.assertGreaterEqual(len(entries), 9)
        for entry in entries:
            path = REPOSITORY_ROOT / entry["destination"]
            with self.subTest(path=entry["destination"]):
                self.assertTrue(path.is_file())
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"]["B"])

    def test_every_copied_file_is_listed_in_the_manifest(self) -> None:
        listed = {entry["destination"] for entry in _copied_entries()}
        on_disk = {
            path.relative_to(REPOSITORY_ROOT).as_posix()
            for path in PACKAGE_ROOT.rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and path.name not in {"pyproject.toml", "README.md", "README.zh.md", "README.i18n.yaml", "test_source_manifest.py"}
        }
        self.assertEqual(on_disk, listed)


if __name__ == "__main__":
    unittest.main()
