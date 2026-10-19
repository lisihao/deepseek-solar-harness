#!/usr/bin/env python3
"""Keyless controller adapter tests; all constructed trial outputs are fixtures."""
import ast
import base64
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import dateutil.parser

import controller_scorer
import official_scorer


def encoded(value):
    return (json.dumps(value, sort_keys=True) + "\n").encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.freeze = self.root / "freeze"
        self.source.mkdir()
        (self.freeze / "runner-inputs").mkdir(parents=True)
        (self.freeze / "controller-only").mkdir()
        self.row = {"id": 1, "context_window_id": 1, "dataset": "spam", "context_len": 32768,
                    "split": "validation", "context_window_text": "unaltered fixture context\n",
                    "question": "fixture question", "answer": "['ham', 'spam']",
                    "answer_type": "ANSWER_TYPE.LABEL"}
        self.case = {"case_id": "1", "benchmark": "oolong", "partition": "development",
                     "dataset": "spam", "context_window_id": 1, "context_len": 32768,
                     "context": self.row["context_window_text"], "question": self.row["question"],
                     "input_sha256": digest((self.row["context_window_text"] + "\n" + self.row["question"]).encode()),
                     "metric": "exact_match", "cluster_id": "fixture-cluster"}
        self.pick = {"id": 1, "dataset": "spam", "context_len": 32768, "split": "validation",
                     "partition": "development", "metric": "exact_match"}
        self.oracle = {"case_id": "1", "metric": "exact_match", "gold": ["ham", "spam"],
                       "answer_type": self.row["answer_type"]}
        self.trials = [{"trial_id": "trial-" + str(i), "case_id": "1",
                        **{k: self.case[k] for k in ("input_sha256", "benchmark", "cluster_id", "partition")}}
                       for i in range(2)]
        self.schedule_path = self.root / "schedule.json"
        self.results_path = self.root / "results.jsonl"
        self.rebind()
        self.results([self.output()])
        raw = base64.b64decode(Path(official_scorer.__file__).with_name("oolong_eval_helpers.py.base64").read_bytes())
        nodes = [n for n in ast.parse(raw).body if isinstance(n, ast.FunctionDef)
                 and n.name in ("synth_attempt_answer_parse", "synth_process_response")]
        self.original = {"ast": ast, "datetime": datetime, "dateutil": dateutil}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "original-parity-reference", "exec"), self.original)

    def rebind(self):
        files = {"rows.jsonl": encoded(self.row), "selection.json": encoded({"cases": [self.pick]}),
                 "source-manifest.json": encoded({"fixture": True}), "record-map.json": encoded({}),
                 "extractor.py": b"# fixture identity only\n"}
        for name, raw in files.items():
            (self.source / name).write_bytes(raw)
        metadata = {"recordExtractionReviewed": True, "dataset": "oolongbench/oolong-synth",
                    "revision": "f" * 40, "files": [{"path": n, "sha256": digest(r)} for n, r in files.items()],
                    "rowsSha256": digest(files["rows.jsonl"]),
                    "selectionSha256": digest(files["selection.json"]), "extractorSha256": digest(files["extractor.py"])}
        meta_raw = encoded(metadata)
        (self.source / "metadata-reviewed.json").write_bytes(meta_raw)
        public_raw, oracle_raw = encoded([self.case]), encoded([self.oracle])
        (self.freeze / "runner-inputs/cases.json").write_bytes(public_raw)
        (self.freeze / "controller-only/oracles.json").write_bytes(oracle_raw)
        (self.freeze / "freeze.json").write_bytes(encoded({
            "sourceMetadataSha256": digest(meta_raw), "selectionSha256": digest(files["selection.json"]),
            "publicSha256": digest(public_raw), "oracleSha256": digest(oracle_raw),
            "dataset": metadata["dataset"], "revision": metadata["revision"], "caseCount": 1}))
        self.schedule_path.write_bytes(encoded({"cases_sha256": digest(public_raw), "trials": self.trials}))

    def output(self, **changes):
        return {"trial_id": "trial-0", "case_id": "1", "input_sha256": self.case["input_sha256"],
                "output": "Answer: ham", "model": "scripted-fixture", "status": "completed", **changes}

    def results(self, values):
        self.results_path.write_bytes(b"".join(encoded(v) for v in values))

    def run_score(self):
        return controller_scorer.score(self.source, self.freeze, self.schedule_path, self.results_path)

    def cli(self, out):
        return subprocess.run([sys.executable, str(Path(controller_scorer.__file__)),
                               "--source", str(self.source), "--freeze", str(self.freeze),
                               "--schedule", str(self.schedule_path), "--results", str(self.results_path),
                               "--out", str(out)], capture_output=True, text=True)

    def test_raw_output_parity_and_first_gold(self):
        for text in ["Answer: **[ham]**", "spam", "", "Answer: HAM", "reason: ignored: ham",
                     "a long explanation ending with ham"]:
            with self.subTest(text=text):
                self.results([self.output(output=text)])
                item = self.run_score()["results"][0]
                expected = self.original["synth_process_response"](self.row, text, "scripted-fixture")
                self.assertEqual(item["official"], expected)
                self.assertEqual(item["raw_output_sha256"], digest(text.encode()))
                self.assertEqual(item["completion_aware_score"], expected["score"])
        self.results([self.output(output="spam")])
        self.assertEqual(self.run_score()["results"][0]["official"]["score"], 0)

    def test_terminal_states_keep_official_credit_separate(self):
        for status in ["completed", "truncated", "budget_exhausted", "timeout", "aborted", "failed"]:
            with self.subTest(status=status):
                self.results([self.output(status=status)])
                report = self.run_score()
                self.assertEqual(report["results"][0]["official"]["score"], 1)
                self.assertEqual(report["results"][0]["completion_aware_score"], int(status == "completed"))
                self.assertEqual(report["missing_trial_ids"], ["trial-1"])
                self.assertEqual(report["usage_accounting"], "not_performed")
                self.assertFalse(report["paidLaunchAllowed"])

    def test_unknown_state_is_not_completed(self):
        self.results([self.output(status="unknown")])
        out = self.root / "refused.json"
        self.assertNotEqual(self.cli(out).returncode, 0)
        self.assertFalse(out.exists())

    def test_result_identity_errors_refuse_before_output(self):
        invalid = [[self.output(), self.output()], [self.output(trial_id="unplanned")],
                   [self.output(case_id="wrong")], [self.output(input_sha256="0" * 64)],
                   [self.output(model="")], [self.output(output=None)]]
        for i, values in enumerate(invalid):
            with self.subTest(i=i):
                self.results(values)
                out = self.root / ("refused-" + str(i) + ".json")
                self.assertNotEqual(self.cli(out).returncode, 0)
                self.assertFalse(out.exists())

    def test_missing_results_remain_missing(self):
        self.results([])
        report = self.run_score()
        self.assertEqual(report["supplied_trials"], 0)
        self.assertEqual(report["missing_trial_ids"], ["trial-0", "trial-1"])
        self.assertEqual(report["results"], [])

    def test_file_drift_and_rebound_wrong_oracle_refuse(self):
        (self.source / "rows.jsonl").write_bytes(b"replaced")
        with self.assertRaisesRegex(ValueError, "Source file drift"):
            self.run_score()
        self.oracle["gold"] = ["wrong"]
        self.rebind()
        with self.assertRaisesRegex(ValueError, "Original oracle mismatch"):
            self.run_score()

    def test_rebound_wrong_input_or_schedule_refuse(self):
        self.case["context"] = "different"
        self.rebind()
        with self.assertRaisesRegex(ValueError, "Original input text mismatch"):
            self.run_score()
        self.case["context"] = self.row["context_window_text"]
        self.trials[0]["input_sha256"] = "0" * 64
        self.rebind()
        with self.assertRaisesRegex(ValueError, "Scheduled input identity mismatch"):
            self.run_score()

    def test_unreviewed_and_unexpected_pin_refuse(self):
        path = self.source / "metadata-reviewed.json"
        value = json.loads(path.read_bytes())
        value["recordExtractionReviewed"] = False
        path.write_bytes(encoded(value))
        with self.assertRaisesRegex(ValueError, "Unreviewed"):
            self.run_score()
        value["recordExtractionReviewed"] = True
        value["files"][0]["path"] = "../outside"
        path.write_bytes(encoded(value))
        with self.assertRaisesRegex(ValueError, "Unexpected source file set"):
            self.run_score()

    def test_cli_writes_once(self):
        out = self.root / "graded.json"
        self.assertEqual(self.cli(out).returncode, 0)
        before = out.read_bytes()
        self.assertNotEqual(self.cli(out).returncode, 0)
        self.assertEqual(out.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
