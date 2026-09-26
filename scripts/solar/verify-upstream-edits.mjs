#!/usr/bin/env node
/**
 * Keep DSH's edits to upstream DeepSeek Harness source explicit.
 *
 * Every upstream-owned source file (`packages/<group>/<name>/src/**` or
 * `apps/<name>/src/**` that existed at the recorded fork point) that DSH
 * modifies or deletes must be listed in `distribution/upstream-source-edits.json`
 * with a kind and a note. New DSH behavior belongs in DSH-owned packages, so an
 * unlisted edit fails; an entry whose file no longer differs from upstream is
 * stale and fails too, which keeps the list an exact inventory of upgrade
 * conflict surface.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Edit kinds: an extension point, a selected upstream fix, generated output, or behavior to move into a plugin. */
export const EDIT_KINDS = Object.freeze(['seam', 'backport', 'generated', 'migration-debt'])

const SOURCE_PATH = /^(?:packages\/[^/]+\/[^/]+\/src\/|apps\/[^/]+\/src\/)/u

/**
 * Select upstream-owned source edits from `git diff --name-status --no-renames` output.
 * @param {string} nameStatus - diff output between the fork point and HEAD.
 * @returns {string[]} sorted modified or deleted upstream source paths.
 */
export function upstreamSourceEdits(nameStatus) {
  return nameStatus.split('\n')
    .map(line => line.split('\t'))
    .filter(([status, path]) => (status === 'M' || status === 'D') && path !== undefined && SOURCE_PATH.test(path))
    .map(([, path]) => path)
    .sort()
}

/**
 * Compare actual upstream source edits with the allowlist.
 * @param {{ schemaVersion: number, forkPoint: string, edits: Record<string, { kind: string, note: string }> }} allowlist
 * @param {string[]} edits - actual modified or deleted upstream source paths.
 * @returns {string[]} violations; empty when the inventory is exact.
 */
export function validateUpstreamEdits(allowlist, edits) {
  const errors = []
  if (allowlist.schemaVersion !== 1) errors.push(`unsupported schemaVersion ${String(allowlist.schemaVersion)}`)
  if (!/^[0-9a-f]{40}$/u.test(String(allowlist.forkPoint))) errors.push('forkPoint must be a full commit SHA')
  const listed = allowlist.edits ?? {}
  for (const [path, entry] of Object.entries(listed)) {
    if (!EDIT_KINDS.includes(entry?.kind)) errors.push(`${path}: kind must be one of ${EDIT_KINDS.join(', ')}`)
    if (typeof entry?.note !== 'string' || entry.note.trim().length === 0) errors.push(`${path}: note must explain the edit`)
  }
  const actual = new Set(edits)
  for (const path of edits) {
    if (!(path in listed)) {
      errors.push(`${path}: unlisted edit to upstream source; move the behavior into a DSH-owned plugin, or list it with a kind and note`)
    }
  }
  for (const path of Object.keys(listed)) {
    if (!actual.has(path)) errors.push(`${path}: listed but no longer differs from upstream; remove the entry`)
  }
  return errors
}

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const allowlist = JSON.parse(readFileSync(`${root}/distribution/upstream-source-edits.json`, 'utf8'))
  const nameStatus = execFileSync('git', ['diff', '--name-status', '--no-renames', allowlist.forkPoint, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const edits = upstreamSourceEdits(nameStatus)
  const errors = validateUpstreamEdits(allowlist, edits)
  if (errors.length > 0) {
    console.error(`verify-upstream-edits: ${String(errors.length)} violation(s):\n${errors.map(error => `  - ${error}`).join('\n')}`)
    process.exit(1)
  }
  const kinds = Object.values(allowlist.edits).reduce((counts, entry) => ({ ...counts, [entry.kind]: (counts[entry.kind] ?? 0) + 1 }), {})
  console.log(`verify-upstream-edits: ${String(edits.length)} upstream source edits listed (${Object.entries(kinds).map(([kind, count]) => `${kind} ${String(count)}`).join(', ')})`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
