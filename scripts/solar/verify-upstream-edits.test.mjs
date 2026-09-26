import assert from 'node:assert/strict'
import test from 'node:test'
import { upstreamSourceEdits, validateUpstreamEdits } from './verify-upstream-edits.mjs'

const FORK = 'a'.repeat(40)

function allowlist(edits) {
  return { schemaVersion: 1, forkPoint: FORK, edits }
}

test('selects only modified or deleted upstream source files', () => {
  const nameStatus = [
    'M\tpackages/core/agent/src/model-selection.ts',
    'D\tapps/cli/src/legacy.ts',
    'A\tpackages/physical-operator/new/src/index.ts',
    'M\tpackages/core/agent/tests/agent.spec.ts',
    'M\tdocs/architecture.md',
    'M\tpackages/core/agent/README.md',
  ].join('\n')
  assert.deepEqual(upstreamSourceEdits(nameStatus), [
    'apps/cli/src/legacy.ts',
    'packages/core/agent/src/model-selection.ts',
  ])
})

test('accepts an exact inventory with kinds and notes', () => {
  assert.deepEqual(validateUpstreamEdits(allowlist({
    'packages/core/agent/src/model-selection.ts': { kind: 'seam', note: 'expose the captured model selection' },
  }), ['packages/core/agent/src/model-selection.ts']), [])
})

test('rejects an unlisted upstream source edit', () => {
  const [error] = validateUpstreamEdits(allowlist({}), ['packages/client/connection/src/index.ts'])
  assert.match(error, /packages\/client\/connection\/src\/index\.ts: unlisted edit to upstream source/u)
})

test('rejects a stale entry, an unknown kind, an empty note, and a bad fork point', () => {
  const errors = validateUpstreamEdits({
    schemaVersion: 1,
    forkPoint: 'main',
    edits: {
      'packages/core/tools/src/index.ts': { kind: 'feature', note: 'x' },
      'packages/core/session/src/index.ts': { kind: 'seam', note: ' ' },
    },
  }, ['packages/core/tools/src/index.ts', 'packages/core/session/src/index.ts'])
  assert.deepEqual(errors, [
    'forkPoint must be a full commit SHA',
    'packages/core/tools/src/index.ts: kind must be one of seam, backport, generated, migration-debt',
    'packages/core/session/src/index.ts: note must explain the edit',
  ])
  assert.match(
    validateUpstreamEdits(allowlist({ 'apps/web/src/main.ts': { kind: 'seam', note: 'boot hook' } }), [])[0],
    /apps\/web\/src\/main\.ts: listed but no longer differs from upstream/u,
  )
})
