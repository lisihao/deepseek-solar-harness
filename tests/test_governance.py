import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skill"
    / "agent-development-governance"
    / "scripts"
    / "governance.py"
)
TEXT_CHECK = Path(__file__).resolve().parents[1] / "scripts" / "check_changed_text.py"
FORMAT_CHECK = Path(__file__).resolve().parents[1] / "scripts" / "check_changed_format.py"
EXPORT_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_bundle.py"
SPEC = importlib.util.spec_from_file_location("governance", SCRIPT)
assert SPEC and SPEC.loader
governance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(governance)
EXPORT_SPEC = importlib.util.spec_from_file_location("export_bundle", EXPORT_SCRIPT)
assert EXPORT_SPEC and EXPORT_SPEC.loader
exporter = importlib.util.module_from_spec(EXPORT_SPEC)
EXPORT_SPEC.loader.exec_module(exporter)


class GovernanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.root, check=True)
        (self.root / "src").mkdir()
        (self.root / "tests").mkdir()
        (self.root / ".github").mkdir()
        (self.root / "package.json").write_text('{"scripts": {}}\n', encoding="utf-8")
        (self.root / "src" / "tracked.py").write_text("VALUE = 1\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-qm", "initial"], cwd=self.root, check=True)
        self.profile_path = self.root / "profile.json"
        self.profile = {
            "profile_version": 1,
            "name": "fixture",
            "project_markers": ["package.json"],
            "instruction_sources": [],
            "scope_rules": [
                {"scope": "source", "patterns": ["src/**", "tests/**"]},
                {
                    "scope": "governance",
                    "patterns": [".github/**"],
                    "expands": ["source"],
                },
            ],
            "gates": [
                {
                    "id": "always",
                    "label": "always",
                    "command": [sys.executable, "-c", "raise SystemExit(0)"],
                    "cwd": ".",
                    "scopes": ["always"],
                    "levels": ["quick", "full"],
                },
                {
                    "id": "source",
                    "label": "source",
                    "command": [sys.executable, "-c", "raise SystemExit(0)"],
                    "cwd": ".",
                    "scopes": ["source"],
                    "levels": ["full"],
                },
            ],
        }
        self.profile_path.write_text(json.dumps(self.profile), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_changed_files_include_untracked(self):
        (self.root / "src" / "new.py").write_text("VALUE = 2\n", encoding="utf-8")
        files = governance.changed_files(self.root, None)
        self.assertIn("src/new.py", files)

    def test_governance_scope_expands_to_source(self):
        scopes = governance.infer_scopes(
            self.profile, [".github/workflows.yml"], "auto"
        )
        self.assertEqual(scopes, ["governance", "source"])

    def test_root_only_pattern_does_not_match_nested_file(self):
        self.assertTrue(governance.matches("README.md", ["*.md"]))
        self.assertFalse(governance.matches("docs/README.md", ["*.md"]))

    def test_full_plan_selects_always_and_source(self):
        (self.root / "src" / "new.py").write_text("VALUE = 2\n", encoding="utf-8")
        payload = governance.plan_payload(
            self.root, self.profile, self.profile_path, "auto", "full", None
        )
        self.assertEqual(payload["gates"], ["always", "source"])

    def test_plan_includes_gate_dependencies(self):
        prerequisite = dict(self.profile["gates"][0])
        prerequisite["id"] = "prerequisite"
        prerequisite["scopes"] = ["governance"]
        self.profile["gates"].insert(1, prerequisite)
        self.profile["gates"][2]["needs"] = ["prerequisite"]
        payload = governance.plan_payload(
            self.root, self.profile, self.profile_path, "source", "full", None
        )
        self.assertEqual(payload["gates"], ["always", "prerequisite", "source"])

    def test_profile_rejects_unknown_or_cyclic_gate_dependencies(self):
        unknown = dict(self.profile)
        unknown["gates"] = [dict(gate) for gate in self.profile["gates"]]
        unknown["gates"][1]["needs"] = ["missing"]
        with self.assertRaisesRegex(governance.GovernanceError, "unknown gate"):
            governance.validate_profile(unknown, self.profile_path)

        cyclic = dict(self.profile)
        cyclic["gates"] = [dict(gate) for gate in self.profile["gates"]]
        cyclic["gates"][0]["needs"] = ["source"]
        cyclic["gates"][1]["needs"] = ["always"]
        with self.assertRaisesRegex(governance.GovernanceError, "dependency cycle"):
            governance.validate_profile(cyclic, self.profile_path)

    def test_profile_rejects_invalid_max_concurrency(self):
        invalid = dict(self.profile)
        invalid["max_concurrency"] = 0
        with self.assertRaisesRegex(governance.GovernanceError, "max_concurrency"):
            governance.validate_profile(invalid, self.profile_path)

    def test_verify_propagates_failure(self):
        gate = dict(self.profile["gates"][0])
        gate["command"] = [sys.executable, "-c", "raise SystemExit(7)"]
        result = governance.execute_gates(self.root, [gate], False, False)
        self.assertEqual(result[0]["status"], "error")
        self.assertEqual(result[0]["returncode"], 7)

    def test_independent_gates_execute_concurrently(self):
        first = self.root / "first.ready"
        second = self.root / "second.ready"
        script = (
            "import pathlib, sys, time; "
            "own, peer = map(pathlib.Path, sys.argv[1:]); "
            "own.write_text('ready'); "
            "deadline = time.monotonic() + 2; "
            "exec(\"while not peer.exists() and time.monotonic() < deadline:\\n time.sleep(0.01)\"); "
            "raise SystemExit(0 if peer.exists() else 9)"
        )
        gates = []
        for gate_id, own, peer in (("first", first, second), ("second", second, first)):
            gates.append({
                "id": gate_id,
                "label": gate_id,
                "command": [sys.executable, "-c", script, str(own), str(peer)],
                "cwd": ".",
                "scopes": ["always"],
                "levels": ["full"],
            })

        results = governance.execute_gates(
            self.root, gates, False, False, max_concurrency=2
        )
        self.assertEqual([result["status"] for result in results], ["ok", "ok"])

    def test_failed_dependency_blocks_its_consumer(self):
        marker = self.root / "consumer-ran"
        producer = dict(self.profile["gates"][0])
        producer["id"] = "producer"
        producer["command"] = [sys.executable, "-c", "raise SystemExit(7)"]
        consumer = dict(self.profile["gates"][1])
        consumer["id"] = "consumer"
        consumer["needs"] = ["producer"]
        consumer["command"] = [
            sys.executable,
            "-c",
            "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('ran')",
            str(marker),
        ]

        results = governance.execute_gates(
            self.root, [producer, consumer], False, False, max_concurrency=2
        )
        self.assertEqual([result["status"] for result in results], ["error", "error"])
        self.assertIn("blocked by failed dependencies", results[1]["detail"])
        self.assertFalse(marker.exists())

    def test_gate_environment_is_injected_without_shell(self):
        gate = dict(self.profile["gates"][0])
        gate["env"] = {"HARNESS_TEST_VALUE": "expected"}
        gate["command"] = [
            sys.executable,
            "-c",
            "import os; raise SystemExit(0 if os.environ.get('HARNESS_TEST_VALUE') == 'expected' else 8)",
        ]
        result = governance.execute_gates(self.root, [gate], False, False)
        self.assertEqual(result[0]["status"], "ok")

    def test_gate_context_environment_is_injected(self):
        gate = dict(self.profile["gates"][0])
        gate["command"] = [
            sys.executable,
            "-c",
            "import os; raise SystemExit(0 if os.environ.get('GOVERNANCE_CHANGED_FROM') == 'base-ref' else 8)",
        ]
        result = governance.execute_gates(
            self.root,
            [gate],
            False,
            False,
            context_env={"GOVERNANCE_CHANGED_FROM": "base-ref"},
        )
        self.assertEqual(result[0]["status"], "ok")

    def test_inherited_changed_from_is_scoped_to_project_root(self):
        nested = self.root / "nested"
        nested.mkdir()
        with mock.patch.dict(
            "os.environ",
            {
                "GOVERNANCE_CHANGED_FROM": "base-ref",
                "GOVERNANCE_PROJECT_ROOT": str(self.root),
            },
        ):
            self.assertEqual(
                governance.inherited_changed_from(self.root), "base-ref"
            )
            self.assertIsNone(governance.inherited_changed_from(nested))

    def test_invalid_shell_string_is_rejected(self):
        invalid = dict(self.profile)
        invalid["gates"] = [dict(self.profile["gates"][0])]
        invalid["gates"][0]["command"] = "echo unsafe"
        with self.assertRaises(governance.GovernanceError):
            governance.validate_profile(invalid, self.profile_path)

    def test_gate_cannot_escape_project(self):
        invalid = dict(self.profile)
        invalid["gates"] = [dict(self.profile["gates"][0])]
        invalid["gates"][0]["cwd"] = "../outside"
        with self.assertRaises(governance.GovernanceError):
            governance.validate_profile(invalid, self.profile_path)

    def test_untracked_trailing_whitespace_fails_changed_text_check(self):
        (self.root / "src" / "bad.py").write_text("VALUE = 1  \n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(TEXT_CHECK), "--project", str(self.root)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("trailing whitespace", result.stdout)

    def test_changed_format_check_only_passes_matching_changed_files(self):
        (self.root / "src" / "format-me.ts").write_text("const value=1\n", encoding="utf-8")
        (self.root / "src" / "ignore.py").write_text("VALUE = 2\n", encoding="utf-8")
        assertion = (
            "import sys; "
            "raise SystemExit(0 if sys.argv[1:] == ['src/format-me.ts'] else 9)"
        )
        result = subprocess.run(
            [
                sys.executable,
                str(FORMAT_CHECK),
                "--project",
                str(self.root),
                "--extensions",
                "ts,tsx",
                "--",
                sys.executable,
                "-c",
                assertion,
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("1 changed files", result.stdout)

    def test_attestation_becomes_stale_after_file_change(self):
        (self.root / "src" / "new.py").write_text("VALUE = 2\n", encoding="utf-8")
        payload = governance.plan_payload(
            self.root, self.profile, self.profile_path, "auto", "full", None
        )
        gates = governance.select_gates(self.profile, payload["scopes"], "full")
        results = governance.execute_gates(self.root, gates, False, False)
        report = self.root / "attestation.json"
        governance.write_attestation(
            report,
            self.root,
            self.profile,
            self.profile_path,
            payload,
            results,
            None,
        )
        fresh = governance.check_attestation(
            report, self.root, self.profile, self.profile_path, "full"
        )
        self.assertTrue(all(item["status"] == "ok" for item in fresh["items"]))

        (self.root / "src" / "new.py").write_text("VALUE = 3\n", encoding="utf-8")
        stale = governance.check_attestation(
            report, self.root, self.profile, self.profile_path
        )
        failed = {item["id"] for item in stale["items"] if item["status"] == "error"}
        self.assertIn("fingerprint", failed)

    def test_git_report_alias_resolves_inside_repository_metadata(self):
        report = governance.resolve_report_path(self.root, "@git")
        expected = (self.root / ".git" / "governance-attestation.json").resolve()
        self.assertEqual(report, expected)

    def test_exported_bundle_is_verified_and_tampering_fails(self):
        project_profile = dict(self.profile)
        project_profile["harness_bundle"] = {
            "manifest": "tools/agent-development-governance/manifest.json"
        }
        source_profile = self.root / "source-profile.json"
        source_profile.write_text(json.dumps(project_profile), encoding="utf-8")
        exporter.export_bundle(self.root, source_profile, "test-commit")
        installed_profile = self.root / ".agent-governance" / "profile.json"
        audit = governance.audit_project(
            self.root, project_profile, installed_profile
        )
        bundle_item = next(item for item in audit["items"] if item["id"] == "harness-bundle")
        self.assertEqual(bundle_item["status"], "ok")

        installed_harness = (
            self.root / "tools" / "agent-development-governance" / "governance.py"
        )
        installed_harness.write_text("tampered\n", encoding="utf-8")
        tampered = governance.audit_project(
            self.root, project_profile, installed_profile
        )
        bundle_item = next(item for item in tampered["items"] if item["id"] == "harness-bundle")
        self.assertEqual(bundle_item["status"], "error")
        self.assertIn("digest mismatch", bundle_item["detail"])


if __name__ == "__main__":
    unittest.main()
