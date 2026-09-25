/** Prepare a credential-free macOS build for repository-supported ad-hoc signing. */

const APPLE_RELEASE_VARIABLES = [
  'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE', 'APPLE_TEAM_ID', 'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_NAME', 'MACOS_SIGN_IDENTITY',
  'MAC_CERT_P12_BASE64',
] as const

/** Safe release facts confirmed by the ad-hoc preflight. */
export interface MacReleasePreflightResult {
  /** Signing mechanism selected by the standing Desktop delivery policy. */
  readonly signing: 'ad-hoc'
}

/**
 * Remove Apple distribution credentials from every local build subprocess.
 * @param env - Environment inherited from the caller.
 * @returns A clone containing no Apple signing or notarization variables.
 */
export function withoutMacReleaseSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env }
  for (const name of APPLE_RELEASE_VARIABLES) delete sanitized[name]
  return sanitized
}

/**
 * Assert that the repository-supported local macOS release can run here.
 * @param platform - Platform executing the release.
 * @returns The selected credential-free signing mode.
 */
export function assertMacReleaseReady(platform: NodeJS.Platform): MacReleasePreflightResult {
  if (platform !== 'darwin') {
    throw new Error('The ad-hoc macOS release must be built on macOS')
  }
  return { signing: 'ad-hoc' }
}
