import importlib.util
import io
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
PROJECT_PROFILE = Path(__file__).resolve().parents[4] / ".agent-governance" / "profile.json"
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

    def test_profile_rejects_non_boolean_exclusive_gate(self):
        invalid = dict(self.profile)
        invalid["gates"] = [dict(gate) for gate in self.profile["gates"]]
        invalid["gates"][0]["exclusive"] = "yes"
        with self.assertRaisesRegex(governance.GovernanceError, "exclusive must be a boolean"):
            governance.validate_profile(invalid, self.profile_path)

    def test_profile_rejects_invalid_evidence_reuse_and_incremental_command(self):
        invalid_reuse = dict(self.profile)
        invalid_reuse["evidence_reuse"] = {"enabled": True, "gates": ["missing"]}
        with self.assertRaisesRegex(governance.GovernanceError, "unknown gate"):
            governance.validate_profile(invalid_reuse, self.profile_path)

        invalid_incremental = dict(self.profile)
        invalid_incremental["gates"] = [dict(gate) for gate in self.profile["gates"]]
        invalid_incremental["gates"][0]["incremental_command"] = "unsafe shell"
        with self.assertRaisesRegex(governance.GovernanceError, "incremental_command"):
            governance.validate_profile(invalid_incremental, self.profile_path)

        invalid_inputs = dict(self.profile)
        invalid_inputs["gates"] = [dict(gate) for gate in self.profile["gates"]]
        invalid_inputs["gates"][0]["input_patterns"] = []
        with self.assertRaisesRegex(governance.GovernanceError, "input_patterns"):
            governance.validate_profile(invalid_inputs, self.profile_path)

    def test_select_when_and_input_patterns_are_decoupled(self):
        gate = dict(self.profile["gates"][1])
        gate.pop("scopes")
        gate["select_when"] = ["governance"]
        gate["input_patterns"] = ["src/**", "package.json"]
        profile = dict(self.profile)
        profile["gates"] = [gate]
        governance.validate_profile(profile, self.profile_path)

        selected = governance.select_gates(profile, ["governance"], "full")
        self.assertEqual([item["id"] for item in selected], ["source"])
        files = [".github/workflow.yml", "src/tracked.py", "package.json"]
        self.assertEqual(
            governance.gate_input_files(profile, gate, files),
            ["src/tracked.py", "package.json"],
        )

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

    def test_exclusive_gate_runs_without_other_active_gates(self):
        trace = self.root / "exclusive.trace"
        script = (
            "from pathlib import Path; import sys, time; "
            "trace = Path(sys.argv[1]); label = sys.argv[2]; "
            "trace.write_text(trace.read_text() + label + ':start\\n'); "
            "time.sleep(0.05); "
            "trace.write_text(trace.read_text() + label + ':end\\n')"
        )
        trace.write_text("")
        gates = []
        for gate_id in ("first", "exclusive", "last"):
            gates.append({
                "id": gate_id,
                "label": gate_id,
                "command": [sys.executable, "-c", script, str(trace), gate_id],
                "cwd": ".",
                "scopes": ["always"],
                "levels": ["full"],
                "exclusive": gate_id == "exclusive",
            })

        results = governance.execute_gates(
            self.root, gates, False, False, max_concurrency=2
        )
        self.assertEqual([result["status"] for result in results], ["ok", "ok", "ok"])
        self.assertEqual(
            trace.read_text().splitlines(),
            [
                "first:start",
                "first:end",
                "exclusive:start",
                "exclusive:end",
                "last:start",
                "last:end",
            ],
        )

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

    def test_reused_dependency_is_not_repeated_for_a_fresh_consumer(self):
        marker = self.root / "producer-ran"
        producer = dict(self.profile["gates"][0])
        producer["id"] = "producer"
        producer["command"] = [
            sys.executable,
            "-c",
            "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('ran')",
            str(marker),
        ]
        consumer = dict(self.profile["gates"][1])
        consumer["id"] = "consumer"
        consumer["needs"] = ["producer"]
        reused = {
            "producer": {
                "id": "producer",
                "label": "producer",
                "status": "ok",
                "detail": "reused",
                "reused": True,
            }
        }

        results = governance.execute_gates(
            self.root,
            [producer, consumer],
            False,
            False,
            reused_results=reused,
        )
        self.assertEqual([result["status"] for result in results], ["ok", "ok"])
        self.assertTrue(results[0]["reused"])
        self.assertFalse(marker.exists())

    def test_incremental_command_composes_with_prior_evidence(self):
        marker = self.root / "incremental-head"
        gate = dict(self.profile["gates"][0])
        gate["command"] = [sys.executable, "-c", "raise SystemExit(9)"]
        gate["incremental_command"] = [
            sys.executable,
            "-c",
            "from pathlib import Path; import sys; Path(sys.argv[1]).write_text(sys.argv[2])",
            str(marker),
            "{evidence_head}",
        ]
        results = governance.execute_gates(
            self.root,
            [gate],
            False,
            False,
            incremental_from={"always": "abc123"},
        )
        self.assertEqual(results[0]["status"], "ok")
        self.assertTrue(results[0]["incremental"])
        self.assertEqual(marker.read_text(), "abc123")

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
        fingerprints = governance.gate_input_fingerprints(
            self.root, self.profile, gates, payload["changed_files"], None
        )
        results = governance.execute_gates(
            self.root,
            gates,
            False,
            False,
            input_fingerprints=fingerprints,
        )
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

    def test_reuses_exact_gate_inputs_when_only_an_unrelated_scope_changes(self):
        (self.root / "docs").mkdir()
        self.profile["scope_rules"].append({"scope": "docs", "patterns": ["docs/**"]})
        self.profile["evidence_reuse"] = {"enabled": True, "gates": ["source"]}
        self.profile_path.write_text(json.dumps(self.profile), encoding="utf-8")
        (self.root / "src" / "new.py").write_text("VALUE = 2\n", encoding="utf-8")
        payload = governance.plan_payload(
            self.root, self.profile, self.profile_path, "source", "full", None
        )
        gates = governance.select_gates(self.profile, payload["scopes"], "full")
        fingerprints = governance.gate_input_fingerprints(
            self.root, self.profile, gates, payload["changed_files"], None
        )
        results = governance.execute_gates(
            self.root,
            gates,
            False,
            False,
            input_fingerprints=fingerprints,
        )
        report = self.root / "reuse.json"
        governance.write_attestation(
            report,
            self.root,
            self.profile,
            self.profile_path,
            payload,
            results,
            None,
        )

        (self.root / "docs" / "note.md").write_text("unrelated\n", encoding="utf-8")
        current_files = governance.changed_files(self.root, None)
        current_fingerprints = governance.gate_input_fingerprints(
            self.root, self.profile, gates, current_files, None
        )
        reused, incremental, evidence_head = governance.load_reusable_evidence(
            report,
            self.root,
            self.profile,
            self.profile_path,
            gates,
            current_files,
            None,
            current_fingerprints,
        )
        self.assertIn("source", reused)
        self.assertEqual(incremental, {})
        self.assertEqual(evidence_head, governance.git_head(self.root))

    def test_docs_only_selection_reuses_source_build_with_explicit_inputs(self):
        (self.root / "docs").mkdir()
        source_build = dict(self.profile["gates"][1])
        source_build["id"] = "source-build"
        source_build.pop("scopes")
        source_build["select_when"] = ["source", "docs"]
        source_build["input_patterns"] = ["src/**", "package.json", "pnpm-lock.yaml"]
        doc_sync = dict(self.profile["gates"][0])
        doc_sync["id"] = "doc-sync"
        doc_sync["scopes"] = ["docs"]
        doc_sync["levels"] = ["full"]
        doc_sync["needs"] = ["source-build"]
        profile = dict(self.profile)
        profile["scope_rules"] = [
            *self.profile["scope_rules"],
            {"scope": "docs", "patterns": ["docs/**"]},
        ]
        profile["gates"] = [source_build, doc_sync]
        profile["evidence_reuse"] = {"enabled": True, "gates": ["source-build"]}
        self.profile_path.write_text(json.dumps(profile), encoding="utf-8")
        note = self.root / "docs" / "note.md"
        note.write_text("first\n", encoding="utf-8")

        payload = governance.plan_payload(
            self.root, profile, self.profile_path, "auto", "full", None
        )
        self.assertEqual(payload["gates"], ["source-build", "doc-sync"])
        gates = governance.select_gates(profile, payload["scopes"], "full")
        fingerprints = governance.gate_input_fingerprints(
            self.root, profile, gates, payload["changed_files"], None
        )
        results = governance.execute_gates(
            self.root, gates, False, False, input_fingerprints=fingerprints
        )
        report = self.root / "docs-reuse.json"
        governance.write_attestation(
            report,
            self.root,
            profile,
            self.profile_path,
            payload,
            results,
            None,
        )

        note.write_text("second\n", encoding="utf-8")
        current_payload = governance.plan_payload(
            self.root, profile, self.profile_path, "auto", "full", None
        )
        current_fingerprints = governance.gate_input_fingerprints(
            self.root, profile, gates, current_payload["changed_files"], None
        )
        self.assertEqual(
            fingerprints["source-build"], current_fingerprints["source-build"]
        )
        reused, incremental, _ = governance.load_reusable_evidence(
            report,
            self.root,
            profile,
            self.profile_path,
            gates,
            current_payload["changed_files"],
            None,
            current_fingerprints,
        )
        self.assertIn("source-build", reused)
        self.assertEqual(incremental, {})

    def test_explicit_input_patterns_invalidate_source_manifest_lock_and_runtime(self):
        gate = dict(self.profile["gates"][1])
        gate["input_patterns"] = ["src/**", "package.json", "pnpm-lock.yaml"]
        profile = dict(self.profile)
        profile["gates"] = [gate]
        lockfile = self.root / "pnpm-lock.yaml"
        lockfile.write_text("lockfileVersion: 9\n", encoding="utf-8")
        (self.root / "docs").mkdir()
        (self.root / "docs" / "note.md").write_text("docs\n", encoding="utf-8")
        files = ["src/tracked.py", "package.json", "pnpm-lock.yaml"]

        def fingerprint(paths: list[str], runtime_version: str) -> str:
            with mock.patch.object(
                governance,
                "executable_identity",
                return_value={"program": sys.executable, "version": runtime_version},
            ):
                return governance.gate_input_fingerprints(
                    self.root, profile, [gate], paths, None
                )["source"]

        baseline = fingerprint(files, "runtime-v1")
        self.assertEqual(baseline, fingerprint([*files, "docs/note.md"], "runtime-v1"))

        source = self.root / "src" / "tracked.py"
        source_text = source.read_text(encoding="utf-8")
        source.write_text("VALUE = 2\n", encoding="utf-8")
        self.assertNotEqual(baseline, fingerprint(files, "runtime-v1"))
        source.write_text(source_text, encoding="utf-8")

        manifest = self.root / "package.json"
        manifest_text = manifest.read_text(encoding="utf-8")
        manifest.write_text('{"scripts":{"changed":true}}\n', encoding="utf-8")
        self.assertNotEqual(baseline, fingerprint(files, "runtime-v1"))
        manifest.write_text(manifest_text, encoding="utf-8")

        lockfile.write_text("lockfileVersion: 10\n", encoding="utf-8")
        self.assertNotEqual(baseline, fingerprint(files, "runtime-v1"))
        self.assertNotEqual(baseline, fingerprint(files, "runtime-v2"))

    def test_dsh_profile_migrates_shared_build_and_install_inputs(self):
        profile = json.loads(PROJECT_PROFILE.read_text(encoding="utf-8"))
        governance.validate_profile(profile, PROJECT_PROFILE)
        gates = {gate["id"]: gate for gate in profile["gates"]}
        for gate_id in (
            "source-build",
            "agent-teams-install",
            "controlled-plugin-install",
            "web-ui-install",
        ):
            self.assertIn("select_when", gates[gate_id])
            self.assertNotIn("scopes", gates[gate_id])
            self.assertIn("input_patterns", gates[gate_id])
        for gate_id in (
            "agent-teams-install",
            "controlled-plugin-install",
            "web-ui-install",
        ):
            self.assertIn("package.json", gates[gate_id]["input_patterns"])
        source_build = gates["source-build"]
        self.assertIn(
            "source-build",
            [gate["id"] for gate in governance.select_gates(profile, ["documentation"], "full")],
        )
        self.assertEqual(
            governance.gate_input_files(
                profile,
                source_build,
                ["docs/note.md", "packages/core/source.ts", "package.json", "pnpm-lock.yaml"],
            ),
            ["packages/core/source.ts", "package.json", "pnpm-lock.yaml"],
        )
        self.assertIn(
            "scripts/solar/install-controlled-plugin-deps.mjs",
            gates["controlled-plugin-install"]["input_patterns"],
        )
        install_cases = {
            "agent-teams-install": (
                [
                    "plugins/managed/agent-teams/README.md",
                    "plugins/managed/agent-teams/package.json",
                    "plugins/managed/agent-teams/pnpm-lock.yaml",
                ],
                [
                    "plugins/managed/agent-teams/package.json",
                    "plugins/managed/agent-teams/pnpm-lock.yaml",
                ],
            ),
            "controlled-plugin-install": (
                [
                    "plugins/managed/better-sidebar/README.md",
                    "plugins/managed/better-sidebar/package.json",
                    "plugins/managed/better-sidebar/pnpm-lock.yaml",
                    "scripts/solar/install-controlled-plugin-deps.mjs",
                ],
                [
                    "plugins/managed/better-sidebar/package.json",
                    "plugins/managed/better-sidebar/pnpm-lock.yaml",
                    "scripts/solar/install-controlled-plugin-deps.mjs",
                ],
            ),
            "web-ui-install": (
                [
                    "plugins/managed/web-ui/README.md",
                    "plugins/managed/web-ui/package.json",
                    "plugins/managed/web-ui/pnpm-lock.yaml",
                    "plugins/managed/web-ui/packages/dsh-pet/package.json",
                ],
                [
                    "plugins/managed/web-ui/package.json",
                    "plugins/managed/web-ui/pnpm-lock.yaml",
                    "plugins/managed/web-ui/packages/dsh-pet/package.json",
                ],
            ),
        }
        for gate_id, (files, expected) in install_cases.items():
            self.assertEqual(
                governance.gate_input_files(profile, gates[gate_id], files), expected
            )

    def test_reuses_exact_gate_inputs_after_commit_is_amended(self):
        self.profile["evidence_reuse"] = {"enabled": True, "gates": ["always"]}
        self.profile_path.write_text(json.dumps(self.profile), encoding="utf-8")
        subprocess.run(
            ["git", "add", "."], cwd=self.root, check=True, stdout=subprocess.DEVNULL
        )
        subprocess.run(
            ["git", "commit", "-m", "record reusable evidence"],
            cwd=self.root,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        payload = governance.plan_payload(
            self.root, self.profile, self.profile_path, "full", "quick", None
        )
        gates = governance.select_gates(self.profile, payload["scopes"], "quick")
        fingerprints = governance.gate_input_fingerprints(
            self.root, self.profile, gates, payload["changed_files"], None
        )
        results = governance.execute_gates(
            self.root, gates, False, False, input_fingerprints=fingerprints
        )
        report = self.root.parent / f"{self.root.name}-amended-reuse.json"
        governance.write_attestation(
            report,
            self.root,
            self.profile,
            self.profile_path,
            payload,
            results,
            None,
        )
        evidence_head = governance.git_head(self.root)
        subprocess.run(
            ["git", "commit", "--amend", "-m", "rewrite reusable evidence"],
            cwd=self.root,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        self.assertNotEqual(evidence_head, governance.git_head(self.root))

        current_files = governance.changed_files(self.root, None)
        current_fingerprints = governance.gate_input_fingerprints(
            self.root, self.profile, gates, current_files, None
        )
        reused, incremental, reused_head = governance.load_reusable_evidence(
            report,
            self.root,
            self.profile,
            self.profile_path,
            gates,
            current_files,
            None,
            current_fingerprints,
        )
        self.assertIn("always", reused)
        self.assertEqual(reused["always"]["reuse_basis"], "exact-input")
        self.assertEqual(incremental, {})
        self.assertEqual(reused_head, evidence_head)
        report.unlink(missing_ok=True)

    def test_does_not_reuse_a_consumer_when_its_dependency_changed(self):
        (self.root / "docs").mkdir()
        self.profile["scope_rules"].append({"scope": "docs", "patterns": ["docs/**"]})
        producer = dict(self.profile["gates"][1])
        producer["id"] = "producer"
        consumer = dict(self.profile["gates"][0])
        consumer["id"] = "consumer"
        consumer["scopes"] = ["docs"]
        consumer["needs"] = ["producer"]
        self.profile["gates"] = [producer, consumer]
        self.profile["evidence_reuse"] = {
            "enabled": True,
            "gates": ["producer", "consumer"],
        }
        self.profile_path.write_text(json.dumps(self.profile), encoding="utf-8")
        (self.root / "docs" / "note.md").write_text("stable\n", encoding="utf-8")
        subprocess.run(
            ["git", "add", "."], cwd=self.root, check=True, stdout=subprocess.DEVNULL
        )
        subprocess.run(
            ["git", "commit", "-m", "add dependency fixture"],
            cwd=self.root,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        payload = governance.plan_payload(
            self.root, self.profile, self.profile_path, "docs", "full", None
        )
        gates = governance.select_gates(self.profile, payload["scopes"], "full")
        fingerprints = governance.gate_input_fingerprints(
            self.root, self.profile, gates, payload["changed_files"], None
        )
        results = governance.execute_gates(
            self.root, gates, False, False, input_fingerprints=fingerprints
        )
        report = self.root / "dependency-reuse.json"
        governance.write_attestation(
            report,
            self.root,
            self.profile,
            self.profile_path,
            payload,
            results,
            None,
        )
        subprocess.run(
            ["git", "add", "."], cwd=self.root, check=True, stdout=subprocess.DEVNULL
        )
        subprocess.run(
            ["git", "commit", "-m", "record consumer evidence"],
            cwd=self.root,
            check=True,
            stdout=subprocess.DEVNULL,
        )

        (self.root / "src" / "base.py").write_text("VALUE = 2\n", encoding="utf-8")
        current_files = governance.changed_files(self.root, None)
        current_fingerprints = governance.gate_input_fingerprints(
            self.root, self.profile, gates, current_files, None
        )
        reused, _, _ = governance.load_reusable_evidence(
            report,
            self.root,
            self.profile,
            self.profile_path,
            gates,
            current_files,
            None,
            current_fingerprints,
        )
        self.assertNotIn("producer", reused)
        self.assertNotIn("consumer", reused)

    def test_verify_cli_reuses_unchanged_successful_evidence(self):
        counter = self.root.parent / f"{self.root.name}-governance-counter"
        gate = dict(self.profile["gates"][0])
        gate["command"] = [
            sys.executable,
            "-c",
            (
                "from pathlib import Path; import sys; "
                "path = Path(sys.argv[1]); "
                "path.write_text(str(int(path.read_text()) + 1) if path.exists() else '1')"
            ),
            str(counter),
        ]
        self.profile["gates"] = [gate]
        self.profile["evidence_reuse"] = {"enabled": True, "gates": ["always"]}
        self.profile_path.write_text(json.dumps(self.profile), encoding="utf-8")
        arguments = [
            "governance.py",
            "verify",
            "--project",
            str(self.root),
            "--profile",
            str(self.profile_path),
            "--scope",
            "full",
            "--level",
            "quick",
            "--report",
            "@git",
            "--json",
        ]
        try:
            with mock.patch.object(sys, "argv", arguments), mock.patch(
                "sys.stdout", new_callable=io.StringIO
            ):
                self.assertEqual(governance.main(), 0)
            with mock.patch.object(sys, "argv", arguments), mock.patch(
                "sys.stdout", new_callable=io.StringIO
            ) as output:
                self.assertEqual(governance.main(), 0)
            self.assertEqual(counter.read_text(), "1")
            self.assertIn('"reused": true', output.getvalue())
        finally:
            counter.unlink(missing_ok=True)

    def test_git_report_alias_resolves_inside_repository_metadata(self):
        report = governance.resolve_report_path(self.root, "@git")
        expected = (self.root / ".git" / "governance-attestation.json").resolve()
        self.assertEqual(report, expected)

    def test_verify_lock_rejects_overlap_and_releases_after_exit(self):
        with governance.verify_lock(self.root):
            with self.assertRaisesRegex(governance.GovernanceError, "already running"):
                with governance.verify_lock(self.root):
                    self.fail("a concurrent verify acquired the same worktree lock")
        with governance.verify_lock(self.root):
            pass

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

    def test_export_bundle_accepts_the_installed_project_profile_as_its_source(self):
        profile = self.root / ".agent-governance" / "profile.json"
        profile.parent.mkdir()
        profile.write_text(json.dumps(self.profile), encoding="utf-8")
        manifest = exporter.export_bundle(self.root, profile, "test-commit")
        self.assertEqual(
            manifest["files"][".agent-governance/profile.json"],
            exporter.sha256_file(profile),
        )


if __name__ == "__main__":
    unittest.main()
