# User Credentials

English | [中文](credentials.zh.md)

The credential seam of [dsh-credentials](../../packages/credentials/credentials) keeps secrets out of configuration: settings sections and `cordis.yml` entries carry *references* (environment-variable names), providers such as [dsh-credentials-local](../../packages/credentials/credentials-local) own the values, and consumers resolve a reference once per operation — the LLM adapters resolve once per model request, so a rotated credential reaches the very next request without any restart. One seam-wide rule binds every provider: an empty stored value is absent everywhere.

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## Identity

A reference names one credential as a POSIX-style environment-variable name. The brand prevents callers from mixing credential references with other strings passed between packages or processes; construction validates the shell-identifier syntax.

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

## Resolution

`resolve(ref)` returns the value with the provider-defined source layer that supplied it, or `undefined` while unconfigured. Consumers re-resolve at each operation and never cache across operations — that per-operation read is the hot-update mechanism.

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}
```

## Description

`describe(ref)` answers configuration surfaces without ever exposing a value: whether the reference resolves, from which layer, and whether `set` would currently succeed. The local provider reports a reference supplied by the live process environment as `writable: false` — a write would appear to succeed while resolution kept returning the shadowing value, so the seam rejects it and the UI can render the reference read-only up front.

```ts type-equiv
/** Source and writability facts for one reference, safe for configuration UIs — never the value. */
interface CredentialInfo {
  /** Whether {@link CredentialProvider.resolve} would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
}
```

## Change commits

`credentials/updated (ref)` fires after a committed change to a provider-managed source — a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Consumers do not need the event (they re-resolve per operation); it exists for configuration surfaces refreshing a "configured" badge.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcredentials--credentialprovider-abstract-seam"></a>

### `ctx.credentials` — `CredentialProvider` (abstract seam)

Abstract credential service. Providers implement the four operations over their source layers; one seam-wide rule binds them all: an empty stored value is absent everywhere — `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a configured secret.

```ts cordis-catalog
/**
 * Resolve one reference to its current value. Resolution is per call:
 * consumers re-resolve at each operation and must not cache across
 * operations — that per-operation read is what makes a changed credential
 * reach the next operation without a restart.
 * @param ref - the reference to resolve.
 * @returns the value and its source, or `undefined` while unconfigured.
 */
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

/**
 * Describe one reference for configuration surfaces without exposing the
 * value.
 * @param ref - the reference to describe.
 * @returns configured state, supplying source, and writability.
 */
abstract describe(ref: CredentialRef): Promise<CredentialInfo>

/**
 * Durably store one value in the provider-managed writable source. Rejects
 * while a read-only source shadows the reference — the write would appear
 * to succeed while resolution keeps returning the shadowing value — and
 * rejects an empty value (use {@link unset}).
 * @param ref - the reference to store.
 * @param value - the non-empty secret value.
 */
abstract set(ref: CredentialRef, value: string): Promise<void>

/**
 * Remove one reference from the provider-managed writable source; removing
 * an absent reference is a no-op. Rejects while a read-only source shadows
 * the reference, like {@link set}.
 * @param ref - the reference to remove.
 */
abstract unset(ref: CredentialRef): Promise<void>
```

Source: [`packages/credentials/credentials/src/index.ts:60`](../../packages/credentials/credentials/src/index.ts)

<a id="ctxremoteauth--remoteauthservice"></a>

### `ctx.remoteAuth` — `RemoteAuthService`

Sole Server writer for pairing, refresh credentials, access sessions, and revocation.

```ts cordis-catalog
/**
 * Mint one local, one-time pairing code. The code is never persisted.
 * @param scope - fixed capability scope assigned to the paired device.
 * @returns the one-time challenge and its expiry.
 */
issuePairing(scope: RemoteDeviceScope): PairingChallenge

/**
 * Redeem one code exactly once and return the only copy of the refresh credential.
 * @param code - unexpired pairing code minted by this Server process.
 * @param deviceName - human-readable device label recorded in the registry.
 * @returns the durable device credential and assigned scope.
 */
redeemPairing(code: string, deviceName: string): Promise<DeviceCredential>

/**
 * Exchange a durable refresh credential for one short-lived access token.
 * @param credential - durable secret returned only when pairing was redeemed.
 * @returns the authenticated device principal and expiring bearer token.
 */
exchange(credential: string): AccessSession

/**
 * Resolve a short-lived bearer token; invalid and expired tokens are indistinguishable.
 * @param accessToken - bearer token issued by {@link exchange}.
 * @returns the authenticated principal, or undefined for every rejected token.
 */
authenticate(accessToken: string): RemotePrincipal | undefined

/**
 * Project the paired-device roster for the trusted administration surface.
 * @returns the durable device registry without credential hashes or access tokens.
 */
listDevices(): RemoteDeviceView[]

/**
 * Revoke one device and all of its current access sessions.
 * @param deviceId - durable identifier of the paired device.
 * @returns a promise settled after the registry is persisted.
 */
revoke(deviceId: string): Promise<void>

/**
 * Begin or reconcile one authenticated remote command without retaining its body.
 * @param deviceId - authenticated device that owns the command namespace.
 * @param commandId - caller-stable idempotency identity.
 * @param requestHash - canonical request digest used only for conflict detection.
 * @returns whether the caller may execute, must wait, or can reuse a prior result.
 */
beginCommand(deviceId: string, commandId: string, requestHash: string): Promise<RemoteCommandBeginResult>

/**
 * Cache the small carrier response for an accepted remote command.
 * @param deviceId - authenticated device that owns the command namespace.
 * @param commandId - caller-stable idempotency identity.
 * @param requestHash - canonical request digest accepted by {@link beginCommand}.
 * @param response - bounded response safe to return on an identical retry.
 * @returns a promise settled after the receipt is durable.
 */
settleCommand( deviceId: string, commandId: string, requestHash: string, response: RemoteCommandResponse, ): Promise<void>

/**
 * Fence a command whose business outcome could not be proven after acceptance.
 * @param deviceId - authenticated device that owns the command namespace.
 * @param commandId - caller-stable idempotency identity.
 * @param requestHash - canonical request digest accepted by {@link beginCommand}.
 * @returns a promise settled after the indeterminate state is durable.
 */
markCommandIndeterminate(deviceId: string, commandId: string, requestHash: string): Promise<void>
```

Source: [`packages/host/remote-auth/src/index.ts:165`](../../packages/host/remote-auth/src/index.ts)

<a id="credentials-events"></a>

### `credentials/*` events

<a id="credentialsupdated--emit"></a>

#### `credentials/updated` — emit

Committed change to a provider-managed credential source: a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Listener failures are contained and logged — a sync throw and an async rejection alike — without changing the committed operation's outcome, except `INVARIANT`-coded failures, which rethrow after every listener ran; that rethrow reaches the emitter only from synchronous listeners, so invariant checks on this event must not be async functions.

```ts cordis-catalog
/**
 * Committed change to a provider-managed credential source: a `set`, an
 * `unset`, or an external edit observed in storage. Ambient
 * process-environment changes are not observable and never emit. Listener
 * failures are contained and logged — a sync throw and an async rejection
 * alike — without changing the committed operation's outcome, except
 * `INVARIANT`-coded failures, which rethrow after every listener ran;
 * that rethrow reaches the emitter only from synchronous listeners, so
 * invariant checks on this event must not be async functions.
 * @param ref - the reference whose stored value changed.
 * @mode emit
 */
'credentials/updated'(ref: CredentialRef): void
```

Source: [`packages/credentials/credentials/src/types.ts:29`](../../packages/credentials/credentials/src/types.ts)
<!-- END GENERATED cordis-surface -->
