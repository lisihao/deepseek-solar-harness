#!/usr/bin/env python3
"""Read-only comparison of a Web build, the catalogued release and an optional install."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--built', type=Path, default=ROOT / 'incubator/chatgpt-web')
    parser.add_argument('--installed', type=Path)
    options = parser.parse_args()
    catalog = json.loads((ROOT / 'distribution/plugins/catalog.json').read_text())
    package = next(item for item in catalog['packages'] if item['id'] == 'chatgpt-web')
    artifact = ROOT / 'distribution/plugins' / package['artifact']['file']
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    if digest != package['artifact']['sha256']:
        raise ValueError('The release archive does not match its catalogued SHA-256')
    directories = [('built', options.built)]
    if options.installed is not None:
        directories.append(('installed', options.installed))
    matched = 0
    with tarfile.open(artifact, 'r:gz') as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if not path.parts or path.parts[0] != 'package' or '..' in path.parts:
                raise ValueError(f'Invalid archive member: {member.name}')
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f'Non-file archive member: {member.name}')
            relative = Path(*path.parts[1:])
            expected = archive.extractfile(member).read()
            for label, directory in directories:
                candidate = directory / relative
                if not candidate.is_file() or candidate.read_bytes() != expected:
                    raise ValueError(f'{label} file differs from release: {relative}')
            matched += 1
    for label, directory in directories:
        manifest = json.loads((directory / 'package.json').read_text())
        if manifest['name'] != package['name'] or manifest['version'] != package['version']:
            raise ValueError(f'{label} package identity differs from release')
    print(json.dumps({'name': package['name'], 'version': package['version'],
                      'releaseSourceCommit': package['sourceCommit'], 'artifactSha256': digest,
                      'matchedFilesPerTarget': matched, 'targets': [label for label, _ in directories]}))

if __name__ == '__main__':
    main()
