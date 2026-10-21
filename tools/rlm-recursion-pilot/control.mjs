const EXPECTED = Object.freeze({
  runCount: 4,
  priorCharged: 463,
  priorConfirmed: 456,
  priorUnknown: 7,
  globalCap: 522,
  maxNew: 56,
  perTreeLimit: 14,
})

function error(code, message, cause) {
  const value = new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause })
  value.code = code
  return value
}

function fail(code, message) {
  throw error(code, message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value.length > 0
}

function createAbortError(id, reason = 'aborted') {
  const value = error('DISPATCH_ABORTED', `${reason}: ${String(id)}`)
  value.name = 'AbortError'
  return value
}

function defer() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function iteratorOf(value) {
  if (value === null || value === undefined || typeof value[Symbol.asyncIterator] !== 'function') {
    throw error('DISPATCH_STREAM', 'base.call() must return an AsyncIterable')
  }
  const iterator = value[Symbol.asyncIterator]()
  if (iterator === null || typeof iterator.next !== 'function') {
    throw error('DISPATCH_STREAM', 'base.call() returned an invalid AsyncIterator')
  }
  return iterator
}

/**
 * Serialize one model dispatcher without changing the provider-facing call shape.
 *
 * Calls are placed in FIFO order when `call` is invoked, but the base call is not
 * admitted until that stream's first consumer request.  This lets a queued abort
 * cancel a stream without touching the provider.  A base stream remains active
 * until its consumer drains it to EOF (or explicitly returns), so a child cannot
 * overlap its parent's provider stream.
 */
export function serializeDispatcher(base) {
  if (!isObject(base) || typeof base.call !== 'function' || typeof base.abort !== 'function' || typeof base.abortAll !== 'function') {
    throw new TypeError('serializeDispatcher requires base.call, base.abort, and base.abortAll')
  }

  const queue = []
  const byId = new Map()
  let active = null
  let pumping = false
  let pumpAgain = false
  let stopped = false
  let abortAllPromise = null

  function addById(entry) {
    const entries = byId.get(entry.id)
    if (entries) entries.add(entry)
    else byId.set(entry.id, new Set([entry]))
  }

  function removeById(entry) {
    const entries = byId.get(entry.id)
    if (!entries) return
    entries.delete(entry)
    if (entries.size === 0) byId.delete(entry.id)
  }

  function settleWaiters(entry, result, failure) {
    const waiters = entry.waiters.splice(0)
    for (const waiter of waiters) {
      if (failure !== undefined) waiter.reject(failure)
      else waiter.resolve(result)
    }
  }

  function finishEntry(entry, failure) {
    if (entry.finished) return
    entry.finished = true
    entry.state = failure === undefined ? 'done' : 'error'
    entry.error = failure
    removeById(entry)
    if (failure !== undefined) settleWaiters(entry, undefined, failure)
    else settleWaiters(entry, { value: undefined, done: true })
    if (active === entry) active = null
  }

  function removeQueued(entry) {
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
  }

  async function cleanupIterator(entry, primaryError) {
    const iterator = entry.iterator
    if (!iterator || typeof iterator.return !== 'function' || entry.returnCalled) return primaryError
    entry.returnCalled = true
    try {
      await iterator.return()
    } catch (cleanupError) {
      // A stream error is the observable failure.  Cleanup is best effort and
      // must never hide the primary provider/consumer error.
      if (primaryError !== undefined) return primaryError
      return cleanupError
    }
    return primaryError
  }

  async function closeEntry(entry, primaryError) {
    if (entry.closePromise) return entry.closePromise
    entry.closeRequested = true
    entry.closePromise = (async () => {
      const failure = await cleanupIterator(entry, primaryError)
      finishEntry(entry, failure)
      requestPump()
      return failure
    })()
    return entry.closePromise
  }

  function requestPump() {
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = true
    void pump().catch(failure => {
      // pump catches per-entry errors.  This branch protects the queue if an
      // unexpected bookkeeping error escapes that boundary.
      if (active) finishEntry(active, failure)
      for (const entry of queue.splice(0)) finishEntry(entry, failure)
    }).finally(() => {
      pumping = false
      if (pumpAgain) {
        pumpAgain = false
        requestPump()
      }
    })
  }

  async function pump() {
    while (true) {
      if (active === null) {
        while (queue.length > 0 && queue[0].finished) queue.shift()
        const candidate = queue[0]
        if (!candidate || candidate.waiters.length === 0 || stopped) return
        queue.shift()
        active = candidate
        candidate.state = 'admitting'
        try {
          // Do not call base.call until the first next() is pending.  This is
          // the provider admission point and keeps queued aborts side-effect free.
          candidate.iterator = iteratorOf(await base.call(candidate.id, candidate.options))
          candidate.state = 'active'
          if (candidate.finished && candidate.closeRequested && !candidate.returnCalled) {
            // An abort/return may arrive while base.call() is still awaiting
            // the provider handle.  The cancellation bookkeeping can finish
            // the wrapper before that handle resolves; close the late handle
            // as soon as it becomes available instead of leaking its stream.
            await cleanupIterator(candidate, candidate.error)
          }
        } catch (failure) {
          finishEntry(candidate, failure)
          continue
        }
      }

      const entry = active
      if (!entry) continue
      if (entry.closeRequested || entry.finished) {
        await closeEntry(entry, entry.error)
        continue
      }
      if (entry.waiters.length === 0) return

      let result
      try {
        result = await entry.iterator.next()
      } catch (failure) {
        const primary = failure
        const finalError = await cleanupIterator(entry, primary)
        finishEntry(entry, finalError)
        continue
      }

      if (entry.closeRequested || entry.finished) {
        // A consumer returned while next() was pending.  Its waiters were
        // settled by return(); discard the late value and release the slot.
        if (entry.iterator && typeof entry.iterator.return === 'function' && !entry.returnCalled) {
          await cleanupIterator(entry, entry.error)
        }
        finishEntry(entry, entry.error)
        continue
      }

      if (result?.done) {
        // finishEntry settles every pending next() call, including the one
        // whose underlying iterator produced EOF.
        finishEntry(entry)
      } else {
        const waiter = entry.waiters.shift()
        if (waiter) waiter.resolve({ value: result?.value, done: false })
      }
    }
  }

  function cancelQueued(entry, failure) {
    if (entry.finished) return false
    removeQueued(entry)
    finishEntry(entry, failure)
    return true
  }

  function abort(id) {
    const entries = [...(byId.get(id) ?? [])]
    let found = false
    for (const entry of entries) {
      if (entry.finished) continue
      found = true
      if (entry === active || entry.state === 'admitting' || entry.state === 'active') {
        // The base owns active cancellation semantics.  The wrapper does not
        // invent a retry or consume a second provider stream.
        try {
          const delegated = base.abort(id)
          if (delegated && typeof delegated.then === 'function') {
            void delegated.catch(failure => { void closeEntry(entry, failure) })
          }
        } catch (failure) {
          void closeEntry(entry, failure)
        }
      } else {
        cancelQueued(entry, createAbortError(id))
      }
    }
    if (found) requestPump()
    return found
  }

  function abortAll() {
    if (abortAllPromise) return abortAllPromise
    stopped = true
    const failure = createAbortError('*', 'abortAll')
    for (const entry of queue.splice(0)) finishEntry(entry, failure)
    if (active && !active.finished) {
      active.closeRequested = true
      active.error = failure
      settleWaiters(active, undefined, failure)
    }

    let delegated
    try {
      delegated = base.abortAll()
    } catch (cause) {
      delegated = Promise.reject(cause)
    }
    abortAllPromise = Promise.resolve(delegated).then(
      value => closeActiveAfterAbortAll(value),
      cause => closeActiveAfterAbortAll(undefined, cause),
    )
    return abortAllPromise
  }

  async function closeActiveAfterAbortAll(value, delegateError) {
    let cleanupError
    if (active && !active.finished) {
      const entry = active
      try {
        await closeEntry(entry, entry.error)
      } catch (failure) {
        cleanupError = failure
      }
    }
    requestPump()
    if (delegateError !== undefined) throw delegateError
    if (cleanupError !== undefined) throw cleanupError
    return value
  }

  function call(id, options) {
    const entry = {
      id,
      options,
      state: stopped ? 'error' : 'queued',
      waiters: [],
      iterator: null,
      finished: false,
      closeRequested: false,
      returnCalled: false,
      closePromise: null,
      error: stopped ? createAbortError(id, 'abortAll') : undefined,
      started: false,
    }
    addById(entry)
    if (stopped) finishEntry(entry, entry.error)
    else queue.push(entry)

    const signal = options?.signal
    let signalListener
    if (signal && typeof signal.addEventListener === 'function') {
      signalListener = () => { abort(id) }
      if (signal.aborted) signalListener()
      else signal.addEventListener('abort', signalListener, { once: true })
    }
    const detachSignal = () => {
      if (signalListener && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', signalListener)
        signalListener = undefined
      }
    }

    const iterator = {
      next(value) {
        if (entry.finished) {
          detachSignal()
          return entry.error === undefined
            ? Promise.resolve({ value: undefined, done: true })
            : Promise.reject(entry.error)
        }
        if (entry.closeRequested) {
          detachSignal()
          return Promise.reject(entry.error ?? createAbortError(id))
        }
        entry.started = true
        const pending = defer()
        entry.waiters.push(pending)
        requestPump()
        return pending.promise.finally(() => {
          if (entry.finished) detachSignal()
        })
      },
      async return(value) {
        if (entry.finished) {
          detachSignal()
          return { value, done: true }
        }
        entry.closeRequested = true
        removeQueued(entry)
        settleWaiters(entry, { value: undefined, done: true })
        if (active === entry || entry.state === 'admitting' || entry.state === 'active') {
          const failure = await closeEntry(entry)
          detachSignal()
          if (failure !== undefined) throw failure
          return { value, done: true }
        }
        finishEntry(entry)
        detachSignal()
        return { value, done: true }
      },
      async throw(reason) {
        if (entry.finished) throw reason
        entry.closeRequested = true
        removeQueued(entry)
        settleWaiters(entry, undefined, reason)
        let failure = reason
        if (active === entry || entry.state === 'admitting' || entry.state === 'active') {
          try {
            if (entry.iterator && typeof entry.iterator.throw === 'function') await entry.iterator.throw(reason)
            else await cleanupIterator(entry, reason)
          } catch (cleanupError) {
            failure = reason
          }
        }
        finishEntry(entry, failure)
        detachSignal()
        throw reason
      },
      [Symbol.asyncIterator]() { return this },
    }
    return iterator
  }

  return {
    call,
    abort,
    abortAll,
    get activeId() { return active?.id },
    get stopped() { return stopped || base.stopped === true },
  }
}

function assertFixedBudget(options) {
  if (!isObject(options)) fail('EXPERIMENT_BUDGET_INVALID', 'options must be an object')
  if (options.priorCharged !== options.priorConfirmed + options.priorUnknown) {
    fail('EXPERIMENT_BUDGET_INVALID', 'priorCharged must equal priorConfirmed + priorUnknown')
  }
  if (options.priorCharged + options.maxNew > options.globalCap) {
    fail('EXPERIMENT_BUDGET_INVALID', 'priorCharged + maxNew exceeds globalCap')
  }
  for (const [name, expected] of Object.entries(EXPECTED)) {
    if (name === 'runCount') continue
    if (options[name] !== expected) fail('EXPERIMENT_BUDGET_INVALID', `${name} must be ${expected}`)
  }
  if (!Array.isArray(options.runIds) || options.runIds.length !== EXPECTED.runCount) {
    fail('EXPERIMENT_RUN_MANIFEST', 'exactly four runIds are required')
  }
  if (options.runIds.some(runId => !isNonEmptyText(runId))) {
    fail('EXPERIMENT_RUN_MANIFEST', 'runIds must be non-empty strings')
  }
  if (new Set(options.runIds).size !== options.runIds.length) {
    fail('EXPERIMENT_RUN_MANIFEST', 'runIds must be unique')
  }
}

/**
 * Present a fresh 56-request Ledger as the continuation of the frozen 463-call
 * summary.  The historical requests are intentionally represented only by the
 * three counters; no synthetic request-N rows are inserted into the new ledger.
 */
export function aggregateBudgetView(base, options) {
  assertFixedBudget(options)
  if (!isObject(base)) fail('EXPERIMENT_LEDGER_INVALID', 'base ledger must be an object')
  for (const method of ['admit', 'admitPhysical', 'settle', 'appendSync', 'receipt']) {
    if (typeof base[method] !== 'function') fail('EXPERIMENT_LEDGER_INVALID', `base.${method} is required`)
  }
  if (base.total !== undefined && base.total !== EXPECTED.maxNew) fail('EXPERIMENT_LEDGER_INVALID', 'base.total must be 56')
  if (base.perRun !== undefined && base.perRun !== EXPECTED.perTreeLimit) fail('EXPERIMENT_LEDGER_INVALID', 'base.perRun must be 14')
  if (base.priorAdmitted !== undefined && base.priorAdmitted !== 0) fail('EXPERIMENT_LEDGER_INVALID', 'base ledger must have no priorCalls')

  const runIds = new Set(options.runIds)
  const admittedByRun = new Map(options.runIds.map(runId => [runId, 0]))
  const logicalRun = new Map()
  const physicalLogical = new Set()
  let newAdmitted = 0

  function assertRun(runId) {
    if (!runIds.has(runId)) throw error('EXPERIMENT_RUN_MANIFEST', `run ${String(runId)} is not in the four-run manifest`)
  }

  function assertAdmitCapacity(runId) {
    if (newAdmitted >= EXPECTED.maxNew || options.priorCharged + newAdmitted >= options.globalCap) {
      throw error('EXPERIMENT_REQUEST_LIMIT', 'the new/global model-request budget is exhausted')
    }
    if ((admittedByRun.get(runId) ?? 0) >= EXPECTED.perTreeLimit) {
      throw error('EXPERIMENT_REQUEST_LIMIT', `run ${runId} reached its per-tree limit`)
    }
  }

  const view = {
    async admit(runId, request) {
      assertRun(runId)
      assertAdmitCapacity(runId)
      newAdmitted += 1
      admittedByRun.set(runId, (admittedByRun.get(runId) ?? 0) + 1)
      try {
        const id = await base.admit(runId, request)
        logicalRun.set(id, runId)
        return id
      } catch (failure) {
        // Reserve before awaiting so concurrent roots cannot pass the same
        // budget check.  A failed base admission did not create a logical row.
        newAdmitted -= 1
        admittedByRun.set(runId, admittedByRun.get(runId) - 1)
        throw failure
      }
    },
    admitPhysical(input = {}) {
      if (!isObject(input)) throw error('EXPERIMENT_PHYSICAL_UNCORRELATED', 'physical admission must be an object')
      const { runId, logicalRequest } = input
      assertRun(runId)
      if (logicalRun.get(logicalRequest) !== runId) throw error('EXPERIMENT_PHYSICAL_UNCORRELATED', 'physical admission is not correlated with an admitted logical request')
      if (physicalLogical.has(logicalRequest)) throw error('EXPERIMENT_PHYSICAL_DUPLICATE', 'each logical request may admit physical work only once')
      const ordinal = base.admitPhysical(input)
      physicalLogical.add(logicalRequest)
      return ordinal
    },
    async settle(id, chunks, failure) {
      return base.settle(id, chunks, failure)
    },
    appendSync(value) {
      return base.appendSync(value)
    },
    async receipt() {
      const receipt = await base.receipt()
      return {
        ...receipt,
        cumulativeAdmitted: options.priorCharged + (receipt.newAdmitted ?? newAdmitted),
        cumulativeConfirmed: options.priorConfirmed + (receipt.settled ?? 0),
        cumulativeUnknown: options.priorUnknown + (receipt.unknown ?? 0),
      }
    },
    get stopped() { return base.stopped },
    get calls() { return base.calls },
    get total() { return base.total },
    get perRun() { return base.perRun },
    get newAdmitted() { return newAdmitted },
  }
  return view
}

