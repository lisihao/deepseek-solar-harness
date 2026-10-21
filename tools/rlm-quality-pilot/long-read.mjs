import { Agent } from 'undici-long-read'

const TARGET_HOST = 'chatgpt.com'
const TARGET_PATH = '/backend-api/codex/responses'
const DEFAULT_BODY_TIMEOUT_MS = 1_200_000

function targetRequest(input, init) {
  let url
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url) } catch { return false }
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
  return url.hostname === TARGET_HOST && url.pathname === TARGET_PATH && method === 'POST'
}

function timeout(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('bodyTimeoutMs must be a positive integer')
  return value
}

/**
 * Own one Undici agent and override only the per-dispatch body timeout.  The
 * request options are copied rather than mutated because Node fetch writes its
 * own shorter bodyTimeout before it calls a dispatcher.
 */
export function createLongReadDispatcher({ bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS, agentFactory = options => new Agent(options) } = {}) {
  const configuredTimeout = timeout(bodyTimeoutMs)
  if (typeof agentFactory !== 'function') throw new TypeError('agentFactory must be a function')
  const agent = agentFactory({})
  if (!agent || typeof agent.dispatch !== 'function' || typeof agent.close !== 'function') throw new TypeError('agentFactory must return an Undici dispatcher with close()')
  let closed = false
  return {
    dispatcher: {
      dispatch(options, handler) {
        return agent.dispatch({ ...options, bodyTimeout: configuredTimeout }, handler)
      },
    },
    async close() {
      if (closed) return
      closed = true
      await agent.close()
    },
  }
}

/**
 * Parent-only fetch wrapper.  Only the exact Codex response POST gains the
 * owned dispatcher; every other request is passed through unchanged.
 */
export function createLongReadProfile({ baseFetch = globalThis.fetch, bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS, agentFactory } = {}) {
  if (typeof baseFetch !== 'function') throw new TypeError('baseFetch must be a function')
  const owned = createLongReadDispatcher({ bodyTimeoutMs, ...(agentFactory === undefined ? {} : { agentFactory }) })
  return {
    fetch(input, init) {
      if (!targetRequest(input, init)) return arguments.length > 1 ? baseFetch(input, init) : baseFetch(input)
      if (init?.dispatcher !== undefined) throw new Error('LONG_READ_DISPATCHER: target request already has an explicit dispatcher')
      return baseFetch(input, { ...(init ?? {}), dispatcher: owned.dispatcher })
    },
    close: owned.close,
  }
}
