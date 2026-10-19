"""Synthetic report adaptation only; real controller oracle files are not read."""
import copy
import json
import unittest
from unittest.mock import patch

import study8_controller
import test_controller_scorer


class Study8ControllerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_controller_scorer.ControllerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.case = self.fixture.case
        self.schedule = []
        for index, (repeat, policy) in enumerate([(1, 'root-only'), (1, 'recursive'), (2, 'recursive'), (2, 'root-only'),
                                                  (3, 'recursive'), (3, 'root-only'), (4, 'root-only'), (4, 'recursive')]):
            self.schedule.append({'sequence': index + 1, 'designTrialKey': 'synthetic-' + str(index),
                                  'case_id': self.case['case_id'], 'cluster_id': self.case['cluster_id'],
                                  'input_sha256': self.case['input_sha256'], 'repeat': repeat, 'spawnPolicy': policy})
        blocks = [{'type': 'text', 'text': 'Answer: '}, {'type': 'text', 'text': 'ham'}]
        output_sha = study8_controller.sha(json.dumps(blocks, ensure_ascii=False, separators=(',', ':')).encode())
        self.report = {'route': {'model': 'scripted-fixture'}, 'rows': [
            {**row, 'status': 'completed', 'output': blocks, 'outputSHA256': output_sha} for row in self.schedule]}

    def prepare(self):
        return study8_controller.prepare(self.report, [self.case], {'schedule': self.schedule}, 'synthetic-cases-sha')

    def test_unchanged_controller_grades_exact_text_and_keeps_all_eight(self):
        value = self.prepare()
        self.assertEqual(value['results'][0]['output'], 'Answer: ham')
        self.assertFalse(value['oracleReadByPreparation'])
        self.fixture.trials = value['schedule']['trials']
        self.fixture.rebind()
        value['schedule']['cases_sha256'] = json.loads(self.fixture.schedule_path.read_text())['cases_sha256']
        result = study8_controller.score_prepared(value, self.fixture.source, self.fixture.freeze,
                                                  self.fixture.root/'mapped-schedule.json', self.fixture.root/'mapped-outputs.jsonl')
        self.assertEqual(len(result['rows']), 8)
        self.assertEqual(len(result['pairs']), 4)
        self.assertTrue(result['allPairsResolved'])
        self.assertTrue(all(row['quality']['official']['score'] == 1 for row in result['rows']))
        self.assertEqual(result['realModelRequests'], 0)

    def test_unknown_missing_and_nontext_output_keep_null_without_survivor_aggregate(self):
        self.report['rows'][0]['status'] = 'unknown'
        self.report['rows'][1]['output'] = None
        self.report['rows'][2]['output'] = [{'type': 'image', 'url': 'synthetic'}]
        value = self.prepare()
        self.assertEqual([row['ungradedReason'] for row in value['rows'][:3]],
                         ['unknown-or-not-started', 'no-raw-output', 'unsupported-output-blocks'])
        self.assertEqual(len(value['rows']), 8)
        self.assertEqual(len(value['results']), 5)
        self.assertTrue(all(row['quality'] is None for row in value['rows']))
        self.fixture.trials = value['schedule']['trials']
        self.fixture.rebind()
        value['schedule']['cases_sha256'] = json.loads(self.fixture.schedule_path.read_text())['cases_sha256']
        result = study8_controller.score_prepared(value, self.fixture.source, self.fixture.freeze,
                                                  self.fixture.root/'partial-schedule.json', self.fixture.root/'partial-outputs.jsonl')
        self.assertFalse(result['allPairsResolved'])
        self.assertIsNone(result['pairs'][0]['completionAwareDelta'])
        self.assertIsNone(result['rows'][0]['quality'])
        self.assertIsNone(result['benefitClaim'])

    def test_no_terminal_output_does_not_open_controller_oracles_or_create_scores(self):
        for row in self.report['rows']:
            row['status'] = 'unknown'
        value = self.prepare()
        with patch.object(study8_controller.controller_scorer, 'score', side_effect=AssertionError('must not read oracle')):
            result = study8_controller.score_prepared(value, self.fixture.root/'unavailable-source', self.fixture.root/'unavailable-freeze',
                                                      self.fixture.root/'unknown-schedule.json', self.fixture.root/'unknown-outputs.jsonl')
        self.assertIsNone(result['officialController'])
        self.assertFalse(result['allPairsResolved'])
        self.assertTrue(all(row['quality'] is None for row in result['rows']))

    def test_empty_blocks_and_empty_text_never_call_scorer_or_resolve_pairs(self):
        for index, blocks in enumerate(([], [{'type': 'text', 'text': ''}])):
            with self.subTest(blocks=blocks):
                for row in self.report['rows']:
                    row['output'] = blocks
                    row['outputSHA256'] = study8_controller.sha(json.dumps(blocks, ensure_ascii=False, separators=(',', ':')).encode())
                value = self.prepare()
                self.assertEqual(value['results'], [])
                self.assertTrue(all(row['ungradedReason'] == 'no-text-output' for row in value['rows']))
                with patch.object(study8_controller.controller_scorer, 'score', side_effect=AssertionError('must not score missing text')):
                    result = study8_controller.score_prepared(value, self.fixture.root/'unavailable-source', self.fixture.root/'unavailable-freeze',
                                                              self.fixture.root/('empty-schedule-' + str(index) + '.json'),
                                                              self.fixture.root/('empty-outputs-' + str(index) + '.jsonl'))
                self.assertIsNone(result['officialController'])
                self.assertEqual(len(result['pairs']), 4)
                self.assertTrue(all(not pair['resolved'] and pair['completionAwareDelta'] is None for pair in result['pairs']))
                self.assertTrue(all(row['quality'] is None for row in result['rows']))

    def test_nonempty_whitespace_text_is_forwarded_without_stripping(self):
        blocks = [{'type': 'text', 'text': ' \n\t'}]
        self.report['rows'][0]['output'] = blocks
        self.report['rows'][0]['outputSHA256'] = study8_controller.sha(json.dumps(blocks, ensure_ascii=False, separators=(',', ':')).encode())
        value = self.prepare()
        self.assertEqual(value['results'][0]['output'], ' \n\t')
        self.assertIsNone(value['rows'][0]['ungradedReason'])

    def test_rejects_output_tampering_reorder_missing_rows_and_input_identity_changes(self):
        original = copy.deepcopy(self.report)
        for change in ('hash', 'order', 'missing', 'identity'):
            self.report = copy.deepcopy(original)
            if change == 'hash': self.report['rows'][0]['outputSHA256'] = '0' * 64
            if change == 'order': self.report['rows'].reverse()
            if change == 'missing': self.report['rows'].pop()
            if change == 'identity': self.report['rows'][0]['input_sha256'] = '0' * 64
            with self.assertRaises(ValueError): self.prepare()


if __name__ == '__main__':
    unittest.main()
