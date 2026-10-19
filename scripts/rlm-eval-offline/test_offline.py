"""Synthetic keyless acceptance cases; none are OOLONG experimental results."""
import base64
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from official_scorer import grade, load_functions
from prepare_data import DATASET, REVISION, digest, freeze_rows, prepare
from budget import Caps, OfflineBudget, BudgetExceeded, quote
from arm_adapter import ARMS, OfflineCodeLoop, ScriptedFakeProvider

class OfficialScorerTests(unittest.TestCase):
    def row(self, answer, kind='ANSWER_TYPE.NUMERIC'):
        return dict(id='synthetic-question', context_window_id='synthetic-context', dataset='synthetic', answer=answer, answer_type=kind)

    def test_exact_original_functions_and_complete_source(self):
        self.assertIn('synth_process_response', load_functions())
        raw = base64.b64decode(Path(__file__).with_name('oolong_eval_helpers.py.base64').read_bytes())
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            load_functions(raw + b' ')

    def test_numeric_official_int_partial_credit_and_first_gold(self):
        self.assertEqual(grade(self.row('[3, 4]'), 'Answer: 4', 'fake')['official']['score'], 0.75)
        self.assertEqual(grade(self.row('[3]'), '3.0', 'fake')['official']['score'], 0)
        self.assertEqual(grade(self.row('[3]'), '3', 'fake')['completion_aware_score'], 1)

    def test_comparison_date_case_and_last_colon_extraction(self):
        self.assertEqual(grade(self.row("['A is more common than B']", 'LABEL'), 'Answer: more common', 'fake')['official']['score'], 1)
        self.assertEqual(grade(self.row('[datetime.date(2020, 1, 2)]', 'ANSWER_TYPE.DATE'), 'Date: January 2, 2020', 'fake')['official']['score'], True)
        self.assertEqual(grade(self.row("['YES']", 'LABEL'), 'yes', 'fake')['official']['score'], 0)
        self.assertEqual(grade(self.row('[3]'), 'User: wrong: **[3]**', 'fake')['official']['score'], 1)

    def test_incomplete_trials_keep_official_score_but_zero_completion_score(self):
        for status in ('truncated', 'timeout', 'budget_exhausted', 'aborted', 'failed'):
            result = grade(self.row('[3]'), '3', 'fake', status)
            self.assertEqual(result['official']['score'], 1)
            self.assertEqual(result['completion_aware_score'], 0)
        with self.assertRaises(ValueError):
            grade(self.row('[3]'), '3', 'fake', 'unknown-terminal')

class BudgetTests(unittest.TestCase):
    def test_known_overrun_is_charged_in_full_and_stops_new_admission(self):
        budget = OfflineBudget(); budget.admit('one', b'body', 10, 10)
        with self.assertRaises(BudgetExceeded):
            budget.settle('one', dict(input=12, output=11, reasoning_included=True))
        self.assertEqual((budget.input, budget.output), (12, 11))
        self.assertEqual(budget.requests['one']['state'], 'settled')
        with self.assertRaises(BudgetExceeded): budget.admit('two', b'body', 1, 1)

    def test_cells_read_limits_and_actual_wall_timer(self):
        budget = OfflineBudget(replace(Caps(), cells=1, cell_seconds=.02))
        loop = OfflineCodeLoop('rlm_nosub', 'q', 'c', ScriptedFakeProvider([]), budget)
        with self.assertRaisesRegex(BudgetExceeded, 'wall-time'):
            loop.cell('while True: pass')
        with self.assertRaises(BudgetExceeded): loop.cell("result = 'never'")
        with self.assertRaises(ValueError): budget.spawn('recursive', -1)
    def test_reserve_before_attempt_and_refuse_missing_bound(self):
        b = OfflineBudget()
        with self.assertRaises(ValueError): b.admit('a', b'body', None, 4096)
        self.assertEqual(b.attempts, 0)
        b.admit('a', b'body', 100, 4096)
        self.assertEqual((b.input, b.output, b.attempts), (100, 4096, 1))
        with self.assertRaises(BudgetExceeded): b.admit('b', b'body', 1, 1)
        with self.assertRaises(ValueError): b.admit('a', b'body', 1, 1)

    def test_unknown_usage_retains_reservation_and_late_settlement_is_exact(self):
        b = OfflineBudget(); b.admit('a', b'body', 100, 200)
        b.settle('a', None)
        self.assertEqual((b.input, b.output), (100, 200))
        with self.assertRaises(BudgetExceeded): b.admit('b', b'x', 1, 1)
        with self.assertRaises(ValueError): b.settle('a', {'input': 1, 'output': 1})
        usage = dict(input=90, output=120, reasoning_included=True)
        b.settle('a', usage); b.settle('a', usage)
        self.assertEqual((b.input, b.output), (90, 120))
        with self.assertRaises(ValueError): b.settle('a', usage | {'output': 0})

    def test_token_attempt_output_and_admission_caps(self):
        b = OfflineBudget(replace(Caps(), attempts=1, input_tokens=100, output_tokens=20, per_request_output=20))
        with self.assertRaises(BudgetExceeded): b.admit('too-big', b'x', 101, 1)
        b.admit('one', b'x', 100, 20)
        b.settle('one', dict(input=100, output=20, reasoning_included=True))
        with self.assertRaises(BudgetExceeded): b.admit('two', b'x', 0, 1)
        clock = [0]; b = OfflineBudget(clock=lambda: clock[0]); clock[0] = 1200
        with self.assertRaises(BudgetExceeded): b.admit('expired', b'x', 1, 1)

    def test_spawn_policies_and_cumulative_caps_are_independent(self):
        b = OfflineBudget()
        with self.assertRaises(BudgetExceeded): b.spawn('none', 0)
        self.assertEqual(b.spawn('root-only', 0), 1)
        with self.assertRaises(BudgetExceeded): b.spawn('root-only', 1)
        self.assertEqual(b.spawn('recursive', 1), 2)
        with self.assertRaises(BudgetExceeded): b.spawn('recursive', 2)
        for _ in range(6): b.spawn('recursive', 0)
        with self.assertRaises(BudgetExceeded): b.spawn('recursive', 0)
        self.assertEqual(b.children, 8)

    def test_quote_refuses_unknown_bound_reasoning_and_prices(self):
        with self.assertRaises(ValueError): quote(Caps(), 16, {}, {})
        proof = {k: 'synthetic-proof-only' for k in ('input_bound', 'reasoning_ceiling', 'physical_transport', 'wp1_integration', 'model_parameters')}
        with self.assertRaises(ValueError): quote(Caps(), 16, {}, proof)
        prices = dict(input_worst_per_million=1, output_worst_per_million=2, fixed_cost=0,
                      model='synthetic-model', source='synthetic-fixture', as_of='2026-10-18', currency='USD')
        result = quote(Caps(), 16, prices, proof)
        self.assertAlmostEqual(result['conditional_cost_ceiling'], 16 * .232)
        self.assertFalse(result['launchAllowed'])

class ArmTests(unittest.TestCase):
    def test_same_code_loop_preserves_state_but_externalizes_rlm_initial_context(self):
        original = 'synthetic original corpus: 完整😀' * 20
        for arm in ('codeact_subcalls', 'rlm_nosub', 'rlm_flat', 'rlm_full'):
            p = ScriptedFakeProvider([{'code': "saved = read_context(0, 9); result = saved"},
                {'code': 'result = saved + str(len(context))'}, {'final': 'synthetic done'}])
            loop = OfflineCodeLoop(arm, 'synthetic question', original, p)
            self.assertEqual(loop.run(), 'synthetic done')
            self.assertIn('saved', loop.namespace)
            self.assertEqual(p.inputs[0]['tools'], ['run_code'])
            self.assertEqual('context' in p.inputs[0], arm == 'codeact_subcalls')
            if arm != 'codeact_subcalls': self.assertNotIn(original, json.dumps(p.inputs[0]))
            self.assertEqual(loop.raw, original.encode())
            self.assertEqual(loop.budget.children, 0)
            with self.assertRaises(ValueError): loop.read(0, 8193)

    def test_none_flat_recursive_and_no_forced_fanout(self):
        steps = [{'code': "result = spawn([{'final': 'child'}])"}, {'final': 'root'}]
        with self.assertRaises(BudgetExceeded): OfflineCodeLoop('rlm_nosub', 'q', 'c', ScriptedFakeProvider(steps)).run()
        flat = OfflineCodeLoop('rlm_flat', 'q', 'c', ScriptedFakeProvider(steps)); flat.run()
        self.assertEqual((flat.budget.children, len(flat.children[0].children)), (1, 0))
        nested = [{'code': "result = spawn([{'code': \"result = spawn([{'final': 'grandchild'}])\"}, {'final': 'child'}])"}, {'final': 'root'}]
        with self.assertRaises(BudgetExceeded): OfflineCodeLoop('rlm_flat', 'q', 'c', ScriptedFakeProvider(nested)).run()
        full = OfflineCodeLoop('rlm_full', 'q', 'c', ScriptedFakeProvider(nested)); full.run()
        self.assertEqual(full.budget.children, 2)
        self.assertEqual(len(full.children[0].children), 1)
        one = OfflineCodeLoop('rlm_full', 'q', 'c', ScriptedFakeProvider([{'final': 'direct result'}])); one.run()
        self.assertEqual(one.budget.children, 0)

    def test_no_real_provider_or_missing_preprocessing_fallback(self):
        with self.assertRaises(ValueError): OfflineCodeLoop('rlm_full', 'q', 'c', lambda _: {})
        for arm in ('summary', 'chunk_map_reduce'):
            with self.assertRaisesRegex(ValueError, 'preprocessing evidence'):
                OfflineCodeLoop(arm, 'q', 'c', ScriptedFakeProvider([])).run()
        self.assertEqual(len(ARMS), 8)

class DataTests(unittest.TestCase):
    def fixture(self):
        rows, selected, ranges = [], [], {}
        for i, partition in enumerate(('development', 'holdout')):
            text = 'synthetic record ' + str(i) + '😀\n'
            rows.append(dict(id=str(i), context_window_id='c'+str(i), dataset='synthetic', split='validation',
                context_len=32, question='synthetic?', context_window_text=text, answer='[3]', answer_type='ANSWER_TYPE.NUMERIC',
                context_window_text_with_labels='SECRET LABELS'))
            selected.append(dict(id=str(i), context_window_id='c'+str(i), dataset='synthetic', split='validation',
                context_len=32, metric='official-synth', partition=partition))
            raw = text.encode(); ranges['c'+str(i)] = [dict(start=0, end=len(raw), sha256=digest(raw))]
        provenance = dict(dataset=DATASET, revision=REVISION, dataset_license=dict(reviewed=True, evidence='synthetic license fixture'),
            extractor=dict(reviewed=True, sha256='a'*64), record_ranges_by_context=ranges)
        return rows, selected, provenance

    def test_complete_bytes_and_oracles_are_separated_in_actual_parquet_export(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        rows, selected, provenance = self.fixture()
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); path = root/'synthetic.parquet'; pq.write_table(pa.Table.from_pylist(rows), path)
            manifest = root/'input.json'; manifest.write_text(json.dumps(dict(mode='synthetic-fixture', fragments=[dict(path=str(path), sha256=digest(path.read_bytes()),
                split='validation')], selection=selected, provenance=provenance)))
            result = prepare(manifest, root/'freeze')
            runner = (root/'freeze/runner.jsonl').read_text()
            self.assertNotIn('SECRET LABELS', runner); self.assertNotIn('answer_type', runner)
            self.assertEqual(json.loads(runner.splitlines()[0])['context_window_text'], rows[0]['context_window_text'])
            self.assertEqual(json.loads((root/'freeze/controller-oracles.jsonl').read_text().splitlines()[0])['answer'], '[3]')
            self.assertFalse(result['launchAllowed'])
            self.assertEqual(result['dataMode'], 'synthetic-fixture')
            with self.assertRaises(ValueError): prepare(manifest, root/'freeze')
            original = json.loads(manifest.read_text()); original['mode'] = 'oolong-fixed-revision'
            original['fragments'][0]['repository_path'] = 'data/validation-00000-of-00009.parquet'
            manifest.write_text(json.dumps(original))
            with self.assertRaisesRegex(ValueError, 'checksum not independently frozen'):
                prepare(manifest, root/'not-real-freeze')

    def test_parquet_parse_uses_the_verified_bytes_when_original_path_changes(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        rows, selected, provenance = self.fixture()
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); path = root/'synthetic.parquet'
            pq.write_table(pa.Table.from_pylist(rows), path)
            verified = path.read_bytes()
            manifest = root/'input.json'
            manifest.write_text(json.dumps(dict(mode='synthetic-fixture', fragments=[dict(
                path=str(path), sha256=digest(verified), split='validation')],
                selection=selected, provenance=provenance)))
            original_read = pq.read_table
            def replace_path_then_parse(source):
                self.assertIsInstance(source, pa.BufferReader)
                changed = deepcopy(rows)
                changed[0]['answer'] = '[999]'
                pq.write_table(pa.Table.from_pylist(changed), path)
                return original_read(source)
            with patch.object(pq, 'read_table', side_effect=replace_path_then_parse):
                frozen = prepare(manifest, root/'freeze')
            self.assertNotEqual(digest(path.read_bytes()), digest(verified))
            oracle = json.loads((root/'freeze/controller-oracles.jsonl').read_text().splitlines()[0])
            self.assertEqual(oracle['answer'], '[3]')
            self.assertEqual(frozen['provenance']['fragments'][0]['sha256'], digest(verified))

    def test_license_extractor_revision_missing_tail_and_overlap_reject(self):
        rows, selected, provenance = self.fixture()
        for key in ('dataset_license', 'extractor'):
            changed = deepcopy(provenance); changed.pop(key)
            with self.assertRaises(ValueError): freeze_rows(rows, selected, changed)
        with self.assertRaises(ValueError): freeze_rows(rows, selected, provenance | {'revision': 'wrong'})
        changed = deepcopy(provenance); changed['record_ranges_by_context']['c0'][0]['end'] -= 1
        with self.assertRaises(ValueError): freeze_rows(rows, selected, changed)
        rows[1]['context_window_text'] = rows[0]['context_window_text']
        provenance['record_ranges_by_context']['c1'] = provenance['record_ranges_by_context']['c0']
        with self.assertRaisesRegex(ValueError, 'overlap'): freeze_rows(rows, selected, provenance)

    def test_missing_original_fragments_never_downloads(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'input.json'; path.write_text('{"fragments": []}')
            with self.assertRaisesRegex(ValueError, 'no network fallback'): prepare(path, Path(root)/'out')

class ReadinessTests(unittest.TestCase):
    def test_metadata_cannot_grant_paid_launch_or_hide_missing_real_data(self):
        from preflight import inspect
        report = inspect({'paidLaunchAllowed': True, 'experimentReady': True})
        self.assertFalse(report['paidLaunchAllowed']); self.assertFalse(report['experimentReady'])
        self.assertIn('original-dataset-bytes-and-real-question-freeze-missing', report['blockers'])
        self.assertIn('actual-DSH-transport-WP1-entire-tree-binding-not-accepted', report['blockers'])
        self.assertTrue(report['officialScorer']['functionsVerified'])

class PreprocessingTests(unittest.TestCase):
    def test_sqlite_bm25_pins_real_version_and_matches_original_records(self):
        from preprocessing import bm25
        records = [b'apple apple', b'pear', b'apple apple', b'banana']
        found = bm25(records, 'apple', 5)
        self.assertEqual([x['index'] for x in found['matches']], [0, 2])
        self.assertEqual(found['matches'][0]['text'].encode(), records[0])
        self.assertTrue(found['sqlite']); self.assertTrue(found['source_id'])
        self.assertEqual((found['k1'], found['b'], found['top_k']), (1.2, .75, 5))
        loop = OfflineCodeLoop('codeact_bm25', 'apple', b''.join(records).decode(), ScriptedFakeProvider([
            {'code': 'result = str(len(search("apple")["matches"]))'}, {'final': 'fake result'}]), records=records)
        self.assertEqual(loop.run(), 'fake result')
        self.assertEqual(loop.provider.inputs[0]['context'], b''.join(records).decode())
        self.assertEqual(loop.namespace['result'], '2')

    def test_chunks_keep_oversized_records_and_original_tail_without_truncation(self):
        from preprocessing import pack_records
        records = [b'a'*3, b'b'*7, b'c'*20]
        chunks = pack_records(records, len, 'synthetic-byte-tokenizer-v1', 8)
        self.assertEqual(b''.join(x['text'].encode() for x in chunks), b''.join(records))
        self.assertTrue(chunks[-1]['oversized']); self.assertEqual(chunks[-1]['end'], 30)
        with self.assertRaises(ValueError): pack_records(records, lambda _: None, 'invalid', 8)

    def test_summary_and_fixed_map_reduce_consume_every_chunk_and_log_exact_inputs(self):
        from preprocessing import pack_records, prepare_baseline
        records = [b'synthetic-A', b'synthetic-B', b'synthetic-C']
        chunks = pack_records(records, len, 'synthetic-byte-tokenizer-v1', 12)
        original = b''.join(records).decode()
        for kind, arm, children in [('summary', 'summary', 0), ('fixed-map-reduce', 'chunk_map_reduce', 3)]:
            budget = OfflineBudget()
            fake = ScriptedFakeProvider([{'text': 'map-A'}, {'text': 'map-B'}, {'text': 'map-C'}, {'text': 'reduced'}])
            prepared = prepare_baseline(kind, chunks, fake, budget)
            self.assertEqual([x['original_chunk']['text'] for x in fake.inputs[:-1]], [x['text'] for x in chunks])
            self.assertEqual((budget.attempts, budget.children), (4, children))
            provider = ScriptedFakeProvider([{'final': 'synthetic final'}])
            loop = OfflineCodeLoop(arm, 'q', original, provider, budget, preparation=prepared)
            self.assertEqual(loop.run(), 'synthetic final')
            request = provider.inputs[0]
            self.assertNotIn(original, json.dumps(request))
            self.assertEqual(request['prepared_context'], 'reduced')
            self.assertEqual(loop.raw, original.encode())
            self.assertEqual(budget.attempts, 5)

    def test_partial_preprocessing_budget_exhaustion_or_bad_chunk_cannot_report_success(self):
        from preprocessing import pack_records, prepare_baseline
        chunks = pack_records([b'A', b'B'], len, 'synthetic', 1)
        with self.assertRaises(BudgetExceeded):
            prepare_baseline('fixed-map-reduce', chunks, ScriptedFakeProvider([{'text': 'map'}]),
                             OfflineBudget(replace(Caps(), attempts=1)))
        budget = OfflineBudget()
        with self.assertRaises(ValueError): prepare_baseline('summary', chunks, ScriptedFakeProvider([{'text': ''}]), budget)
        self.assertEqual(next(iter(budget.requests.values()))['state'], 'unknown')
        bad = deepcopy(chunks); bad[-1]['sha256'] = 'wrong'
        with self.assertRaises(ValueError): prepare_baseline('summary', bad, ScriptedFakeProvider([]), OfflineBudget())

if __name__ == '__main__':
    unittest.main(verbosity=2)
