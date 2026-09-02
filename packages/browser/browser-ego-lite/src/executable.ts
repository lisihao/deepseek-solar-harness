/** Ego Lite executable resolution in the mounted subprocess execution world. */

import { isAbsolute, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Absolute helper bundled by the signed macOS Ego Lite application. */
export const DEFAULT_EGO_LITE_APP_EXECUTABLE = '/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser'

/** Configured or discovered Ego Lite executable plus its discovery source. */
export interface ResolvedEgoLiteExecutable {
  readonly path: string
  readonly source: 'configured' | 'home' | 'application'
}

/**
 * Resolve an explicitly configured absolute executable, then the Finder-safe
 * `~/.local/bin/ego-browser` location, then the signed macOS app helper.
 * @param subprocess - executable resolver for the Provider's execution world.
 * @param configured - optional deployment-owned absolute executable path.
 * @param home - home directory used for the Finder-safe candidate.
 * @returns the resolved executable, or undefined when automatic discovery finds none.
 */
export async function resolveEgoLiteExecutable(
  subprocess: SubprocessRuntime,
  configured: string | undefined,
  home: string | undefined,
): Promise<ResolvedEgoLiteExecutable | undefined> {
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new Error('browser-ego-lite: executable must be an absolute path')
    }
    return {
      path: await subprocess.resolveExecutable(configured),
      source: 'configured',
    }
  }

  const candidates: readonly (readonly [string, ResolvedEgoLiteExecutable['source']])[] = [
    ...(home === undefined
      ? []
      : [[join(home, '.local', 'bin', 'ego-browser'), 'home'] as const]),
    [DEFAULT_EGO_LITE_APP_EXECUTABLE, 'application'],
  ]
  for (const [candidate, source] of candidates) {
    try {
      return {
        path: await subprocess.resolveExecutable(candidate),
        source,
      }
    } catch {
      // Automatic discovery probes independent conventional locations. Failure
      // leaves the Provider registered but unavailable for execution-time selection.
    }
  }
  return undefined
}
