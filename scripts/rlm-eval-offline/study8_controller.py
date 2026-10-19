#!/usr/bin/env python3
"""Map frozen eight-row runner reports to the existing controller-only official scorer.

The runner never imports this module. Only score_prepared invokes the existing
controller, which owns oracle access. Preparation reads runner-safe inputs only.
"""
import argparse
import hashlib
import json
from pathlib import Path

import controller_scorer

CASES_SHA = '2814397eac66de436bb468ee40b49c07661626f7182468ae2a0447d72d26f33b'
PREPARATION_SHA = '2dc83ffeea644f743f9d83ed51b64ed4e7904f0ebb2d62d55bacd6c926e213c2'
TERMINAL = {'completed': 'completed', 'max-tokens': 'truncated', 'truncated': 'truncated',
            'aborted': 'aborted', 'error': 'failed', 'refusal': 'failed', 'refused': 'failed',
            'failed': 'failed', 'timeout': 'timeout', 'budget_exhausted': 'budget_exhausted'}


def sha(raw):
    """Hash exact UTF-8 bytes, never a normalized answer."""
    return hashlib.sha256(raw).hexdigest()


def require(condition, message):
    """Reject inconsistent report identities."""
    if not condition:
        raise ValueError(message)


def prepare(report, cases, preparation, cases_sha):
    """Map every scheduled row; unknown, missing and non-text outputs stay ungraded."""
    schedule = preparation['schedule']
    require(len(schedule) == 8 and len(report['rows']) == 8, 'All eight rows required')
    require(isinstance(report['route']['model'], str) and report['route']['model'], 'Missing model identity')
    case_index = controller_scorer.index_unique(cases, 'case_id')
    row_index = controller_scorer.index_unique(report['rows'], 'designTrialKey')
    require(set(row_index) == {row['designTrialKey'] for row in schedule}, 'Report schedule mismatch')
    trials, outputs, observations = [], [], []
    for planned, row in zip(schedule, report['rows']):
        require(row['designTrialKey'] == planned['designTrialKey'], 'Report order mismatch')
        for key in ('sequence', 'case_id', 'repeat', 'spawnPolicy', 'input_sha256', 'cluster_id'):
            require(row[key] == planned[key], 'Report identity mismatch: ' + key)
        case = case_index[row['case_id']]
        require(case['input_sha256'] == row['input_sha256'] and case['cluster_id'] == row['cluster_id'], 'Frozen case mismatch')
        trial = {'trial_id': row['designTrialKey'], 'case_id': row['case_id'],
                 **{key: case[key] for key in ('input_sha256', 'benchmark', 'cluster_id', 'partition')}}
        trials.append(trial)
        observation = {**trial, 'repeat': row['repeat'], 'spawnPolicy': row['spawnPolicy'],
                       'nativeStatus': row['status'], 'quality': None, 'ungradedReason': None}
        blocks = row.get('output')
        if row['status'] not in TERMINAL:
            observation['ungradedReason'] = 'unknown-or-not-started'
        elif not isinstance(blocks, list):
            observation['ungradedReason'] = 'no-raw-output'
        elif not all(isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str) for block in blocks):
            observation['ungradedReason'] = 'unsupported-output-blocks'
        else:
            require(row.get('outputSHA256') == sha(json.dumps(blocks, ensure_ascii=False, separators=(',', ':')).encode()),
                    'Runner output blocks SHA mismatch')
            raw = ''.join(block['text'] for block in blocks)
            if raw == '':
                observation['ungradedReason'] = 'no-text-output'
            else:
                outputs.append({**trial, 'output': raw, 'model': report['route']['model'], 'status': TERMINAL[row['status']]})
                observation['rawOutputSHA256'] = sha(raw.encode())
        observations.append(observation)
    return {'schedule': {'cases_sha256': cases_sha, 'trials': trials}, 'results': outputs,
            'rows': observations, 'realModelRequests': 0, 'oracleReadByPreparation': False}


def score_prepared(prepared, source, freeze, schedule_path, results_path):
    """Delegate unchanged scoring to the existing controller; preserve all missing rows."""
    with Path(schedule_path).open('x', encoding='utf-8') as stream:
        json.dump(prepared['schedule'], stream, ensure_ascii=False)
        stream.write('\n')
    with Path(results_path).open('x', encoding='utf-8') as stream:
        for row in prepared['results']:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
    grades = controller_scorer.score(source, freeze, schedule_path, results_path) if prepared['results'] else None
    by_id = {} if grades is None else {item['trial_id']: item for item in grades['results']}
    rows = [{**row, 'quality': by_id.get(row['trial_id'])} for row in prepared['rows']]
    keys = list(dict.fromkeys((row['case_id'], row['repeat']) for row in rows))
    pairs = []
    for case_id, repeat in keys:
        members = [row for row in rows if row['case_id'] == case_id and row['repeat'] == repeat]
        policies = {row['spawnPolicy']: row for row in members}
        require(len(members) == 2 and set(policies) == {'root-only', 'recursive'}, 'Incomplete comparison pair')
        resolved = all(row['quality'] is not None for row in members)
        delta = (policies['recursive']['quality']['completion_aware_score']
                 - policies['root-only']['quality']['completion_aware_score']) if resolved else None
        pairs.append({'case_id': case_id, 'repeat': repeat, 'resolved': resolved,
                      'nativeStatuses': {key: row['nativeStatus'] for key, row in policies.items()},
                      'completionAwareDelta': delta})
    return {'scope': 'frozen8-controller-output-adaptation', 'rows': rows, 'pairs': pairs,
            'allPairsResolved': all(pair['resolved'] for pair in pairs), 'officialController': grades,
            'realModelRequests': 0, 'newTrialExecution': False, 'benefitClaim': None}


def main():
    """Create new controller artifacts without modifying runner reports or frozen inputs."""
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('report', 'cases', 'preparation', 'source', 'freeze', 'out_dir'):
        parser.add_argument('--' + name.replace('_', '-'), required=True, type=Path)
    args = parser.parse_args()
    cases_raw, prep_raw = args.cases.read_bytes(), args.preparation.read_bytes()
    require(sha(cases_raw) == CASES_SHA and sha(prep_raw) == PREPARATION_SHA, 'Original frozen inputs drifted')
    report_raw = args.report.read_bytes()
    prepared = prepare(json.loads(report_raw), json.loads(cases_raw), json.loads(prep_raw), sha(cases_raw))
    args.out_dir.mkdir()
    result = score_prepared(prepared, args.source, args.freeze, args.out_dir/'schedule.json', args.out_dir/'outputs.jsonl')
    result['runnerReportSHA256'] = sha(report_raw)
    with (args.out_dir/'quality.json').open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


if __name__ == '__main__':
    main()
