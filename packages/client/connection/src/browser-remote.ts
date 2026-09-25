/** Static browser bootstrap surface used before the Cordis module table starts. */

export {
  getBrowserRemoteAccessToken,
  setBrowserRemoteAccessToken,
  withBrowserRemoteAuthorization,
} from './client/browser-access-token.ts'
export { WebRemoteAuthClient } from './client/remote-auth-client.ts'
export type { RemoteAuthClient } from './client/remote-auth-client.ts'
export type {
  RemoteAccessSession,
  RemoteDeviceCredential,
  RemoteDeviceScope,
  RemoteDeviceView,
  RemotePairingChallenge,
} from './remote-auth-wire.ts'
