/**
 * Shared by the tests that run the real Python collectors: interpreter lookup
 * and a Radar store seeded through the real CLI.
 */

import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const COLLECTOR_SOURCES = fileURLToPath(new URL('../../../../python/scheduling-evidence/src', import.meta.url))
const RADAR_PAYLOADS = fileURLToPath(new URL('./fixtures/radar/payloads.json', import.meta.url))

/** First interpreter on PATH that reports Python 3.11 or newer. */
export function findPython(): string | undefined {
  return ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3', 'python'].find((name) => {
    const probe = spawnSync(name, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' })
    return probe.status === 0 && probe.stdout.trim() === 'True'
  })
}

/**
 * Import the committed Radar payloads into `<stateRoot>/radar` through the real CLI, as an owner who holds the receipt would.
 * @param python - interpreter that runs the collector.
 * @param stateRoot - directory whose `radar/` child the gateway reads.
 */
export async function seedRadarStore(python: string, stateRoot: string): Promise<void> {
  const receipt = join(stateRoot, 'authorization.json')
  await writeFile(receipt, JSON.stringify({
    schema: 'codex-radar-provider-authorization', version: 1, provider: 'codex-radar', status: 'authorized',
    scope: ['model-quality-json'], attribution: '数据来自 Codex 雷达 codexradar.com',
  }))
  const imported = spawnSync(python, [
    '-m', 'codex_radar_provider.cli', '--state-root', join(stateRoot, 'radar'), 'import',
    '--authorization-file', receipt, '--payloads-json', RADAR_PAYLOADS,
    '--fetched-at', new Date().toISOString().replace(/\.\d+Z$/u, 'Z'),
  ], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: COLLECTOR_SOURCES, PYTHONUTF8: '1' } })
  if (imported.status !== 0) throw new Error(`Radar import failed: ${imported.stdout}${imported.stderr}`)
}
