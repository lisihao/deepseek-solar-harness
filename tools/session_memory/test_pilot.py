import copy
import json
from pathlib import Path
import tempfile
import unittest

import pilot


class PilotTests(unittest.TestCase):
    def session(self, name="sample"):
        return {"sessionId": name, "format": "codex", "workspace": "/synthetic/project",
                "title": "Synthetic failure and correction", "sourceSha256": "a" * 64,
                "coverage": {"cleanChars": 9, "selectedChars": 9, "fullCleanTextIncluded": True},
                "excerpts": [{"seq": 11, "role": "user", "offset": 0, "text": "更正：先验证再安装"}]}

    def answer(self):
        return {"items": [{"kind": "lesson", "title": "先验证", "statement": "用户要求先验证再安装。",
                           "rule": "先验证再安装", "reason": "本次要求，不能扩展到其他项目。", "scope": "合成项目",
                           "timeStatus": "historical", "evidence": [{"seq": 11, "quote": "先验证再安装"}],
                           "uncertainties": ["没有安装实际回执"]}]}

    def write_plan(self, root, count=2):
        sessions = []
        for i in range(count):
            s = self.session("sample-" + str(i))
            body = pilot.request_body(s)
            s.update(requestSha256=pilot.digest(body), **pilot.reservation(body))
            sessions.append(s)
        p = {"version": 1, "model": pilot.MODEL, "endpoint": pilot.ENDPOINT,
             "reservedCny": sum(s["reservedCny"] for s in sessions), "sessions": sessions}
        p["planSha256"] = pilot.digest(p)
        path = Path(root) / "plan.json"
        pilot.write_json(path, p)
        return path

    def fake(self, body):
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertNotIn("tools", body)
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(self.answer(), ensure_ascii=False)}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 200}}

    def test_evidence_wrong_source_or_fabrication_refused(self):
        for field, value in (("seq", 12), ("quote", "虚构证据")):
            answer = self.answer()
            answer["items"][0]["evidence"][0][field] = value
            with self.assertRaises(ValueError):
                pilot.validate_result(answer, self.session())

    def test_no_current_fact_or_unexpected_fields(self):
        answer = self.answer()
        answer["items"][0]["timeStatus"] = "current"
        with self.assertRaises(ValueError):
            pilot.validate_result(answer, self.session())
        answer = self.answer()
        answer["action"] = "import"
        with self.assertRaises(ValueError):
            pilot.validate_result(answer, self.session())

    def test_excerpt_limits_are_explicit(self):
        messages = [{"seq": i, "role": "user", "text": "失败与更正" * 2000} for i in range(3)]
        parts = pilot.excerpts(messages, 4000)
        self.assertLessEqual(sum(len(pilot.encoded(p)) for p in parts), 4000)
        self.assertTrue(parts)
        self.assertLess(sum(len(p["text"]) for p in parts), sum(len(m["text"]) for m in messages))

    def test_selection_excludes_trivial_protocol_probes(self):
        sessions = []
        for origin in ("claude", "codex"):
            for i in range(3):
                sessions.append({"sessionId": origin + str(i), "format": origin,
                                 "workspace": "/project/" + str(i), "title": "Development",
                                 "messages": [{"seq": n, "role": "user", "text": "修复与验证" * 200} for n in range(3)]})
        probe = copy.deepcopy(sessions[0])
        probe.update(sessionId="probe", title="Protocol verification only")
        sessions.append(probe)
        chosen = pilot.select_sessions(sessions, 4)
        self.assertEqual(len(chosen), 4)
        self.assertNotIn("probe", [s["sessionId"] for s in chosen])
        self.assertEqual({s["format"] for s in chosen}, {"claude", "codex"})

    def test_budget_rejects_before_any_call(self):
        with tempfile.TemporaryDirectory() as root:
            p = self.write_plan(root)
            for budget in (0, 0.000001, 2.01, float("nan")):
                with self.assertRaises(ValueError):
                    pilot.extract(p, budget, lambda _: self.fail("must not call model"))
            self.assertFalse((Path(root) / "ledger.json").exists())

    def test_plan_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.write_plan(root)
            p = pilot.read_json(path)
            p["sessions"][0]["excerpts"][0]["text"] = "changed"
            pilot.write_json(path, p)
            with self.assertRaises(ValueError):
                pilot.extract(path, 2, lambda _: self.fail("must not dispatch"))

    def test_completed_receipts_reused_no_replay(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.write_plan(root)
            first = pilot.extract(path, 2, self.fake)
            self.assertEqual(len(first["calls"]), 2)
            pilot.extract(path, 2, lambda _: self.fail("completed call must not replay"))
            report = pilot.report(path).read_text()
            self.assertIn("尚未导入 Hindsight", report)
            self.assertIn("没有安装实际回执", report)

    def test_unknown_attempt_stops_and_is_not_replayed(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.write_plan(root)
            calls = []
            def fail(body):
                calls.append(body)
                raise TimeoutError()
            with self.assertRaises(RuntimeError):
                pilot.extract(path, 2, fail)
            self.assertEqual(len(calls), 1)
            with self.assertRaises(ValueError):
                pilot.extract(path, 2, lambda _: self.fail("unknown call must not replay"))

    def test_partial_response_is_retained_without_retry(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.write_plan(root, 1)
            def partial(body):
                result = self.fake(body)
                result["choices"][0]["finish_reason"] = "length"
                return result
            with self.assertRaises(RuntimeError):
                pilot.extract(path, 2, partial)
            self.assertTrue((Path(root) / "sample-0.response.json").exists())
            self.assertFalse((Path(root) / "sample-0.candidates.json").exists())

    def test_missing_usage_does_not_become_zero(self):
        receipt = pilot.usage_receipt({}, {"reservedCny": 0.1})
        self.assertIsNone(receipt["usage"])
        self.assertEqual(receipt["accountedCny"], 0.1)

    def test_private_preview_escapes_transcript_markup_without_network(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.write_plan(root, 1)
            p = pilot.read_json(path)
            s = p["sessions"][0]
            s["title"] = "<script>alert(1)</script>"
            body = pilot.request_body(s)
            s.update(requestSha256=pilot.digest(body), **pilot.reservation(body))
            p["reservedCny"] = s["reservedCny"]
            p.pop("planSha256")
            p["planSha256"] = pilot.digest(p)
            pilot.write_json(path, p)
            target = pilot.preview(path)
            rendered = target.read_text()
            self.assertNotIn("<script>", rendered)
            self.assertIn("&lt;script&gt;", rendered)
            self.assertIn("尚未调用模型", rendered)
            self.assertFalse((Path(root) / "ledger.json").exists())

    def test_usage_over_allowance_is_refused(self):
        s = {"inputTokenAllowance": 10, "outputTokenAllowance": 20}
        with self.assertRaises(ValueError):
            pilot.usage_receipt({"usage": {"prompt_tokens": 11, "completion_tokens": 1}}, s)

    def test_local_reconciliation_keeps_complete_prefix_without_replaying(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.write_plan(root, 1)
            def malformed(body):
                result = self.fake(body)
                item = json.dumps(self.answer()["items"][0], ensure_ascii=False)
                result["choices"][0]["message"]["content"] = '{"items":[' + item + ',{"unfinished":"'
                return result
            with self.assertRaises(RuntimeError):
                pilot.extract(path, 2, malformed)
            original = (Path(root) / "sample-0.response.json").read_bytes()
            result = pilot.reconcile(path, "sample-0")
            self.assertEqual(result["accepted"], 1)
            self.assertTrue(result["rejected"])
            self.assertEqual(original, (Path(root) / "sample-0.response.json").read_bytes())
            pilot.extract(path, 2, lambda _: self.fail("must not replay reconciled call"))

    def test_reconciliation_cannot_turn_timeout_into_success(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.write_plan(root, 1)
            def timeout(body):
                raise TimeoutError()
            with self.assertRaises(RuntimeError):
                pilot.extract(path, 2, timeout)
            with self.assertRaises(FileNotFoundError):
                pilot.reconcile(path, "sample-0")


if __name__ == "__main__":
    unittest.main()
