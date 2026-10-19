"""Offline readiness report. It never starts trials or grants paid authority."""
import argparse
from dataclasses import asdict
import hashlib
import importlib.metadata
import json
from pathlib import Path
from budget import Caps
from official_scorer import SOURCE_SHA256, SOURCE_GIT_BLOB, load_functions
from prepare_data import DATASET, REVISION, PINNED_FRAGMENTS

def inspect(inputs):
    """Report separately what local artifacts prove and what remains absent."""
    load_functions()
    data = inputs.get('data_freeze')
    blockers = []
    if not isinstance(data, dict) or not data.get('manifest'):
        blockers.append('original-dataset-bytes-and-real-question-freeze-missing')
    else:
        path = Path(data['manifest'])
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != data.get('sha256'):
            blockers.append('data-freeze-manifest-missing-or-drifted')
        else:
            value = json.loads(path.read_text())
            if value.get('dataMode') != 'oolong-fixed-revision':
                blockers.append('synthetic-fixture-is-not-real-data')
            blockers.append('real-data-license-record-extractor-and-partition-review-required')
    # The checked-in adapter intentionally accepts only ScriptedFakeProvider.
    # A JSON assertion cannot convert this prototype into DSH transport proof.
    blockers.extend([
        'production-common-tool-loop-and-independent-spawn-policy-not-integrated',
        'provider-tokenizer-template-input-bound-not-proven',
        'reasoning-inclusive-output-ceiling-not-proven-for-target-model',
        'actual-DSH-transport-WP1-entire-tree-binding-not-accepted',
        'runner-oracle-filesystem-and-network-isolation-not-proven',
        'model-parameters-pricing-and-new-paid-authority-not-frozen',
        'official-OOLONG-Pairs-data-generator-and-scorer-not-frozen',
    ])
    dependencies = {}
    for package in ('pyarrow', 'python-dateutil'):
        try:
            dependencies[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            dependencies[package] = None
            blockers.append('local-dependency-missing:' + package)
    return dict(schemaVersion=1, kind='offline-preparation-only', paidLaunchAllowed=False,
        experimentReady=False, dataset=dict(id=DATASET, revision=REVISION, knownFragmentChecksums=PINNED_FRAGMENTS),
        officialScorer=dict(sourceSha256=SOURCE_SHA256, gitBlob=SOURCE_GIT_BLOB, functionsVerified=True),
        candidateCaps=asdict(Caps()), dependencies=dependencies, blockers=blockers)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = inspect(json.loads(args.inputs.read_text()))
    with args.out.open('x') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
