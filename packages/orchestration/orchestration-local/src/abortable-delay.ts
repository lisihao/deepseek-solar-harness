/**
 * Wait without losing cancellation while polling durable state.
 * @param delayMs - wait duration in milliseconds.
 * @param signal - cancellation signal owned by the polling operation.
 * @returns completion when the delay elapses.
 */
export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('observation wait aborted'))
  }
  return new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(complete, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('observation wait aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
