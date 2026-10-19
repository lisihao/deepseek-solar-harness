"""Mutation tests against retained, actually assembled fake Consumer receipts."""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import pilot_receipts as receipts


@unittest.skipUnless(os.environ.get("DSH_OFFLINE_RECEIPT_BUNDLE"), "Requires assembled keyless receipt bundle")
class ReceiptTests(unittest.TestCase):
    """Read existing executions; no test invokes or retries a Worker."""

    @classmethod
    def setUpClass(cls):
        cls.bundle = Path(os.environ["DSH_OFFLINE_RECEIPT_BUNDLE"])
        cls.manifest = json.loads((cls.bundle / "manifest.json").read_bytes())
        cls.cases = {c["case_id"]: c for c in json.loads((cls.bundle / "cases.json").read_bytes())}
        cls.reports = [json.loads((cls.bundle / pin["path"]).read_bytes())
                       for pin in cls.manifest["executions"] + cls.manifest["diagnostics"]]

    def check_report(self, report):
        """Use the same independent validation as the controller CLI."""
        case = self.cases[report["trial"]["case_id"]]
        return receipts.verify_trial(report, report["trial"], case, receipts.prepare(case))

    def test_real_bundle_and_unknown_remain_separate(self):
        report = receipts.verify(self.bundle)
        self.assertEqual(len(report["inventory"]), 16)
        self.assertEqual(report["missing"], [])
        unknown = next(r for r in report["diagnostics"] if r["terminal"] == "unknown")
        self.assertIsNone(unknown["derived"])
        self.assertEqual(unknown["exclusion"], "unknown_lifecycle")
        self.assertEqual({r["terminal"] for r in report["diagnostics"]}, {"failed", "unknown"})

    def test_mutated_identity_output_status_and_request_facts_refuse(self):
        mutations = {
            "model": lambda r: r.update(model="other"),
            "case_sha": lambda r: r["caseIdentity"].update(input_sha256="bad"),
            "raw_output": lambda r: r.update(rawOutput="replacement"),
            "false_completed": lambda r: r.update(terminal="failed"),
            "missing_send": lambda r: r["sends"].pop(),
            "duplicate_send": lambda r: r["sends"].append(copy.deepcopy(r["sends"][0])),
            "missing_attempt": lambda r: r["ledger"]["state"]["attempts"].pop(),
            "missing_physical": lambda r: r["physical"].pop(),
            "wrong_command": lambda r: r["entries"][0].update(commandId="orphan"),
            "body": lambda r: r["entries"][0].update(body="{}"),
            "orphan_worker": lambda r: r["workers"].append(dict(r["workers"][0], commandId="orphan")),
            "cap": lambda r: r["scope"]["scope"]["limits"].update(httpAttempts=25),
            "usage": lambda r: r["ledger"]["totals"].update(input=0),
            "time": lambda r: r["workers"][0]["finished"].update(monotonicMs=-1),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                value = copy.deepcopy(self.reports[0])
                mutate(value)
                with self.assertRaises((ValueError, KeyError)):
                    self.check_report(value)

    def test_full_map_results_cannot_be_replaced_with_handles_or_truncation(self):
        original = next(r for r in self.reports if r["trial"]["arm"] == "chunk_map_reduce")
        for mutate in (lambda r: r["resultReads"].clear(),
                       lambda r: r["storedResults"][0]["content"].update(output=[]),
                       lambda r: r["workers"][1]["prompt"][1].update(text="cropped chunk"),
                       lambda r: r["children"].pop()):
            value = copy.deepcopy(original)
            mutate(value)
            with self.assertRaises((ValueError, KeyError)):
                self.check_report(value)

    def test_unknown_cannot_be_marked_completed_or_zero_usage(self):
        original = next(r for r in self.reports if r["terminal"] == "unknown")
        for mutate in (lambda r: r.update(terminal="completed"),
                       lambda r: r["ledger"]["state"]["attempts"][0].update(usage={"input": 0, "output": 0}),
                       lambda r: r.update(usageComplete=True)):
            value = copy.deepcopy(original)
            mutate(value)
            with self.assertRaises(ValueError):
                self.check_report(value)

    def test_unknown_reservation_cannot_be_zeroed_with_matching_totals(self):
        value = copy.deepcopy(next(r for r in self.reports if r["terminal"] == "unknown"))
        value["ledger"]["state"]["attempts"][0].update(reservedInput=0, reservedOutput=0)
        value["ledger"]["totals"].update(input=0, output=0)
        with self.assertRaisesRegex(ValueError, "Sent reservation mismatch"):
            self.check_report(value)

    def test_physical_terminal_missing_conflicting_or_reversed_refuses(self):
        for mutate in (lambda r: r["physical"][0]["events"].pop(),
                       lambda r: r["physical"][0]["events"][-1].update(kind="unknown"),
                       lambda r: r["physical"][0]["events"].append(dict(r["physical"][0]["events"][-1], kind="not-sent")),
                       lambda r: r["physical"][0]["events"][-1].update(monotonicMs=r["physical"][0]["events"][0]["monotonicMs"]-1)):
            value = copy.deepcopy(self.reports[0])
            mutate(value)
            with self.assertRaises(ValueError):
                self.check_report(value)

    def test_missing_unknown_worker_stop_reason_cannot_complete(self):
        for reason in (None, "future-stop"):
            value = copy.deepcopy(self.reports[0])
            root = next(w for w in value["workers"] if w["identity"]["role"] == "root")
            if reason is None:
                root["result"].pop("stopReason")
                value["rootResult"].pop("stopReason")
            else:
                root["result"]["stopReason"] = value["rootResult"]["stopReason"] = reason
            with self.assertRaisesRegex(ValueError, "Worker stopReason"):
                self.check_report(value)

    def test_preprocessing_dependency_drift_refuses(self):
        for name in receipts.PREPROCESS_DEPENDENCIES:
            pins = {**receipts.PREPROCESS_DEPENDENCIES, name: "bad"}
            with patch.object(receipts, "PREPROCESS_DEPENDENCIES", pins):
                with self.assertRaisesRegex(ValueError, "Preprocessing source drift"):
                    receipts.verify(self.bundle)

    def test_manifest_mutations_and_missing_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "bundle"
            shutil.copytree(self.bundle, home)
            manifest = copy.deepcopy(self.manifest)
            absent = manifest["executions"].pop()
            (home / "manifest.json").write_text(json.dumps(manifest))
            self.assertEqual(receipts.verify(home)["missing"],
                             [{"trial_id": absent["trial_id"], "reason": "no_execution_receipt"}])
            for mutate in (lambda m: m["executions"][0].update(sha256="bad"),
                           lambda m: m["executions"].append(copy.deepcopy(m["executions"][0])),
                           lambda m: m["executions"][0].update(trial_id="unscheduled"),
                           lambda m: m["executions"][0].update(path="../manifest.json")):
                manifest = copy.deepcopy(self.manifest)
                mutate(manifest)
                (home / "manifest.json").write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    receipts.verify(home)

    def test_cli_refuses_nonoverwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "out.json"
            out.write_text("original")
            result = subprocess.run([sys.executable, "-B", str(Path(receipts.__file__)),
                                     "--bundle", str(self.bundle), "--out", str(out)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(out.read_text(), "original")


if __name__ == "__main__":
    unittest.main()
