#!/usr/bin/env python3
"""Local-only OOLONG export. No download, implicit selection, or oracle delivery."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

REVISION = 'f0d59eaf0febf130664cfceb710436c8e3216b2b'
DATASET = 'oolongbench/oolong-synth'
PINNED_FRAGMENTS = {
    'data/validation-00000-of-00009.parquet': 'a0420298223aaca11c702ffe6e9fdf773f27a99066a84e5e05c06d843214aca6',
}
RUNNER_FIELDS = ('id', 'context_window_id', 'dataset', 'split', 'context_len', 'question', 'context_window_text')

def digest(value):
    return hashlib.sha256(value).hexdigest()

def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf8')

def freeze_rows(rows, selection, provenance):
    """Validate explicit controller evidence before splitting runner and oracle files.

    Record ranges are an audited extractor input, not a newly inferred parser.
    Their byte coverage and hashes are checked here; semantic record boundaries
    and dataset license review remain named controller responsibilities.
    """
    if provenance.get('dataset') != DATASET or provenance.get('revision') != REVISION:
        raise ValueError('Pinned dataset/revision required')
    license_review = provenance.get('dataset_license')
    if not isinstance(license_review, dict) or license_review.get('reviewed') is not True or not license_review.get('evidence'):
        raise ValueError('Dataset license evidence required; code MIT license is insufficient')
    extractor = provenance.get('extractor')
    if not isinstance(extractor, dict) or extractor.get('reviewed') is not True or len(extractor.get('sha256', '')) != 64:
        raise ValueError('Reviewed record extractor fingerprint required')
    if not selection or len({str(x['id']) for x in selection}) != len(selection):
        raise ValueError('Explicit unique selected question IDs required')
    by_id = {}
    for row in rows:
        key = str(row['id'])
        if key in by_id:
            raise ValueError('Duplicate source question ID')
        by_id[key] = row
    runner, controller, records, contexts = [], [], {}, {}
    for item in selection:
        if item.get('partition') not in ('development', 'holdout'):
            raise ValueError('Explicit development/holdout partition required')
        row = by_id.get(str(item['id']))
        if row is None:
            raise ValueError('Selected real question ID absent from local frozen fragments')
        for key in ('dataset', 'split', 'context_len', 'context_window_id'):
            if item.get(key) != row.get(key):
                raise ValueError('Selection metadata differs: ' + key)
        if not isinstance(row.get('answer'), str) or not isinstance(row.get('answer_type'), str):
            raise ValueError('Original official oracle strings required')
        if item.get('metric') != 'official-synth':
            raise ValueError('Unsupported metric; Pairs needs its separately frozen official data/scorer')
        if any(k not in row for k in RUNNER_FIELDS) or not isinstance(row['context_window_text'], str):
            raise ValueError('Complete original runner fields required')
        raw = row['context_window_text'].encode('utf8', errors='strict')
        context_key = str(row['context_window_id'])
        previous = contexts.get(context_key)
        identity = (digest(raw), item['partition'])
        if previous is not None and previous != identity:
            raise ValueError('Context identity or partition conflict')
        contexts[context_key] = identity
        ranges = provenance.get('record_ranges_by_context', {}).get(context_key)
        if not ranges:
            raise ValueError('Audited original record byte ranges missing')
        cursor, hashes = 0, set()
        for record in ranges:
            start, end = record['start'], record['end']
            if type(start) is not int or type(end) is not int or start != cursor or end <= start or end > len(raw):
                raise ValueError('Record ranges must cover complete original bytes in order')
            value = raw[start:end]
            value.decode('utf8', errors='strict')
            actual = digest(value)
            if actual != record['sha256']:
                raise ValueError('Original record hash mismatch')
            hashes.add(actual)
            cursor = end
        if cursor != len(raw):
            raise ValueError('Record ranges omit original tail')
        records.setdefault(item['partition'], set()).update(hashes)
        runner.append({k: row[k] for k in RUNNER_FIELDS} | {'partition': item['partition'], 'context_sha256': digest(raw)})
        controller.append({k: row[k] for k in ('id', 'context_window_id', 'dataset', 'answer', 'answer_type')})
    if records.get('development', set()) & records.get('holdout', set()):
        raise ValueError('Development/holdout original-record overlap')
    return runner, controller, {'schemaVersion': 1, 'provenance': provenance, 'selection': selection,
        'runnerSha256': digest(b''.join(encoded(r) + b'\n' for r in runner)),
        'oracleSha256': digest(b''.join(encoded(r) + b'\n' for r in controller)),
        'launchAllowed': False}

def prepare(manifest_path, output):
    """Read only explicitly named, hash-checked local Parquet fragments."""
    value = json.loads(Path(manifest_path).read_text())
    rows, sources = [], []
    if not value.get('fragments'):
        raise ValueError('Local original Parquet bytes not supplied; no network fallback')
    mode = value.get('mode')
    if mode not in ('oolong-fixed-revision', 'synthetic-fixture'):
        raise ValueError('Explicit original-data or synthetic-fixture mode required')
    import pyarrow as pa
    import pyarrow.parquet as parquet
    for fragment in value['fragments']:
        if mode == 'oolong-fixed-revision':
            expected = PINNED_FRAGMENTS.get(fragment.get('repository_path'))
            if expected is None or fragment['sha256'] != expected:
                raise ValueError('Published fragment checksum not independently frozen')
        path = Path(fragment['path'])
        if not path.is_file():
            raise ValueError('Local original Parquet fragment missing: ' + str(path))
        raw = path.read_bytes()
        if digest(raw) != fragment['sha256']:
            raise ValueError('Parquet SHA256 mismatch')
        if fragment['split'] not in ('train', 'validation', 'test'):
            raise ValueError('Explicit source split required')
        for row in parquet.read_table(pa.BufferReader(raw)).to_pylist():
            if 'split' in row and row['split'] != fragment['split']:
                raise ValueError('Source split conflict')
            rows.append(row | {'split': fragment['split']})
        sources.append({k: fragment[k] for k in ('path', 'sha256', 'split')})
    provenance = value['provenance'] | {'fragments': sources}
    runner, oracle, frozen = freeze_rows(rows, value['selection'], provenance)
    frozen['dataMode'] = mode
    frozen['paidLaunchAllowed'] = False
    output = Path(output)
    if output.exists():
        raise ValueError('Never overwrite an existing freeze')
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.offline-freeze-', dir=output.parent))
    try:
        for name, entries in [('runner.jsonl', runner), ('controller-oracles.jsonl', oracle)]:
            (staging / name).write_bytes(b''.join(encoded(x) + b'\n' for x in entries))
        (staging / 'manifest.json').write_bytes(encoded(frozen) + b'\n')
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return frozen

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.manifest, args.out)
