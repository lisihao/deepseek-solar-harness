# 用户凭据

[English](credentials.md) | 中文

[dsh-credentials](../../packages/credentials/credentials) 的凭据 seam 把机密挡在配置之外：settings 分节与 `cordis.yml` 条目携带的是*引用*（环境变量名），值归 [dsh-credentials-local](../../packages/credentials/credentials-local) 这类提供方所有，消费方每个操作解析一次引用——LLM（大语言模型）适配器每次模型请求解析一次，因此轮换后的凭据无需任何重启即可作用于紧随其后的下一次请求。一条 seam 级规则约束每个提供方：空的存储值在任何地方都视为不存在。

来源：[`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## 标识

引用以 POSIX 风格环境变量名命名一条凭据。brand 防止调用方将凭据引用与在包或进程之间传递的其他字符串混用；构造时校验 shell 标识符语法。

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

## 解析

`resolve(ref)` 返回值及提供该值的来源层（由提供方定义）；未配置期间返回 `undefined`。消费方在每个操作中重新解析，绝不跨操作缓存——这种按操作进行的读取正是热更新机制。

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}
```

## 描述

`describe(ref)` 在绝不暴露值的前提下回应配置界面：引用当前是否可解析、来自哪一层、`set` 当前能否成功。本地提供方把由当前进程环境供值的引用报告为 `writable: false`——那样的写入会表面成功而解析持续返回遮蔽值，因此 seam 直接拒绝，界面也得以提前把该引用渲染为只读。

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

## 已提交的变更

`credentials/updated (ref)` 在提供方管理的来源发生已提交变更后发出——`set`、`unset` 或在存储中观察到的外部编辑。进程环境自身的变化不可观测，永不发出事件。消费方不需要该事件（它们按操作重新解析）；它服务于配置界面刷新「已配置」徽标。

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

Source: [`packages/host/remote-auth/src/index.ts:113`](../../packages/host/remote-auth/src/index.ts)

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
