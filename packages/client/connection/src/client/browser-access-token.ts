/** Memory-only bearer installed by the browser pairing bootstrap. */

let accessToken: string | undefined

/**
 * Install or clear the short-lived browser access token.
 * @param value - bearer token for the current browser lifetime, or undefined to clear it.
 */
export function setBrowserRemoteAccessToken(value: string | undefined): void {
  accessToken = value
}

/**
 * Read the current browser bearer without persisting it into URL or storage.
 * @returns the current in-memory bearer, when one has been installed.
 */
export function getBrowserRemoteAccessToken(): string | undefined {
  return accessToken
}

/**
 * Merge the current browser bearer into a fetch request.
 * @param init - existing fetch options whose headers should be preserved.
 * @returns fetch options carrying the current bearer when available.
 */
export function withBrowserRemoteAuthorization(init: RequestInit = {}): RequestInit {
  if (accessToken === undefined) return init
  const headers = new Headers(init.headers)
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${accessToken}`)
  return { ...init, headers }
}
