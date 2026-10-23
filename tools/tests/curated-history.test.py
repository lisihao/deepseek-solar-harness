"""Historical archive versions stay exact when the active preview is bumped."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('curated_checker', TOOLS / 'check-curated-packages.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

class HistoricalVersions(unittest.TestCase):
    def check_history(self, active, historical=None):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            archive = base / 'old.tgz'
            with tarfile.open(archive, 'w:gz') as packed:
                files = {'package/package.json': json.dumps({'name': '@lisihao/test', 'version': '0.1.0-dev.0', 'license': 'MIT'}).encode(),
                         'package/LICENSE': (TOOLS.parent / 'distribution/plugins/LICENSE-Solar.txt').read_bytes()}
                for name, data in files.items():
                    member = tarfile.TarInfo(name); member.size = len(data)
                    packed.addfile(member, io.BytesIO(data))
            entry = {'sourceCommit': 'a' * 40, 'file': 'old.tgz', 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'size': archive.stat().st_size, 'origin': 'previous-preview', 'installableCandidate': False}
            if historical is not None:
                entry['version'] = historical
            package = {'name': '@lisihao/test', 'version': active, 'license': {'spdx': 'MIT', 'licenseFile': 'package/LICENSE'}, 'historicalArtifacts': [entry]}
            reporter = checker.Reporter()
            checker.check_historical_artifacts(package, base, reporter, 'test', set())
            return reporter.errors

    def test_previous_version_is_checked_against_its_own_manifest(self):
        self.assertEqual(self.check_history('0.1.0-dev.1', '0.1.0-dev.0'), [])

    def test_legacy_history_retains_current_version_fallback(self):
        self.assertEqual(self.check_history('0.1.0-dev.0'), [])

    def test_wrong_version_is_still_rejected(self):
        self.assertTrue(any('package version' in error for error in self.check_history('0.1.0-dev.1', '0.1.0-dev.1')))

if __name__ == '__main__':
    unittest.main()
