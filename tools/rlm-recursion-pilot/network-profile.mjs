import { channel as diagnosticsChannel } from 'node:diagnostics_channel'

const NO_REUSE_HOST = 'chatgpt.com'
const DIAGNOSTIC_CHANNELS = [
  'undici:client:connectError',
  'undici:request:error',
]

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return new URL(input)
  if (input && typeof input.url === 'string') return new URL(input.url)
  return null
}

function isNoReuseTarget(input) {
  try {
    return requestUrl(input)?.hostname === NO_REUSE_HOST
  } catch {
    return false
  }
}

function selectedError(error) {
  const value = error && typeof error === 'object' ? error : {}
  const cause = value.cause && typeof value.cause === 'object' ? value.cause : {}
  const result = {}
  if (typeof value.name === 'string') result.name = value.name
  if (typeof value.code === 'string') result.code = value.code
  const selectedCause = {}
  if (typeof cause.name === 'string') selectedCause.name = cause.name
  if (typeof cause.code === 'string') selectedCause.code = cause.code
  result.cause = selectedCause
  return result
}

function diagnosticPayload(name, message) {
  const error = message && typeof message === 'object' && 'error' in message
    ? message.error
    : message
  return { channel: name, error: selectedError(error) }
}

/**
 * Build a fetch wrapper which disables connection reuse only for chatgpt.com.
 * The caller owns installation of the returned function and disposal of the
 * diagnostics-channel subscriptions.
 */
export function installNoReuseProfile({ baseFetch = globalThis.fetch, onDiagnostic = () => {} } = {}) {
  if (typeof baseFetch !== 'function') throw new TypeError('baseFetch must be a function')
  if (typeof onDiagnostic !== 'function') throw new TypeError('onDiagnostic must be a function')

  const subscriptions = DIAGNOSTIC_CHANNELS.map(name => {
    const listener = message => onDiagnostic(diagnosticPayload(name, message))
    const source = diagnosticsChannel(name)
    source.subscribe(listener)
    return { source, listener }
  })
  let disposed = false

  function wrappedFetch(input, init) {
    if (!isNoReuseTarget(input)) {
      return arguments.length > 1 ? baseFetch(input, init) : baseFetch(input)
    }

    const sourceHeaders = init?.headers ?? input?.headers
    const headers = new Headers(sourceHeaders)
    headers.set('Connection', 'close')
    const nextInit = { ...(init ?? {}), headers }
    return baseFetch(input, nextInit)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const { source, listener } of subscriptions) source.unsubscribe(listener)
  }

  return { fetch: wrappedFetch, dispose }
}
