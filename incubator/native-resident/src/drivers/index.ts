import type { NativeDrivers } from '../contracts.js'
import { ClaudeNativeDriver } from './claude.js'
import { CodexNativeDriver } from './codex.js'

/** Public daemon configuration. Native authentication remains product-owned. */
export interface NativeDriverConfig {
  readonly codexExecutable?: string
  readonly claudeExecutable?: string
}

/** Creates the two public native-product adapters used by the Resident daemon. */
export function createNativeDrivers(config: NativeDriverConfig = {}): NativeDrivers {
  return {
    codex: new CodexNativeDriver({ executable: config.codexExecutable }),
    'claude-code': new ClaudeNativeDriver({ executable: config.claudeExecutable }),
  }
}

export { DRIVER_ERROR_CODE } from './errors.js'
