/** Trusted Worker program; model code is evaluated only by QuickJS. */
export const QUICKJS_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { Buffer } = require('node:buffer');
let vm;
let runtime;
let control;
let active;
let phase = 'initializing';
let checks = 0;
let ordinal = 0;
let deadline = 0;
let calls = 0;
let logBytes = 0;
let logs = [];
let hostFailure;
const pending = new Map();
const limits = workerData.limits;
const error = (message, code = 'RLM_GUEST_ERROR') => Object.assign(new Error(message), { code });
function boundedString(handle, cap) {
  if (vm.typeof(handle) !== 'string') throw error('guest protocol requires a string');
  const length = vm.getProp(handle, 'length');
  const size = vm.getNumber(length);
  length.dispose();
  if (size > cap) throw error('guest string exceeds byte limit', 'RLM_OUTPUT_LIMIT');
  const text = vm.getString(handle);
  if (Buffer.byteLength(text) > cap) throw error('guest string exceeds byte limit', 'RLM_OUTPUT_LIMIT');
  return text;
}
function describe(handle) {
  const message = vm.getProp(handle, 'message');
  try { return vm.typeof(message) === 'string' ? boundedString(message, limits.maxBridgeBytes) : 'QuickJS execution failed'; }
  finally { message.dispose(); }
}
function unwrap(result) {
  if (result.error) {
    try { throw error(describe(result.error)); } finally { result.error.dispose(); }
  }
  return result.value;
}
function callControl(name, ...args) {
  const method = vm.getProp(control, name);
  try { return unwrap(vm.callFunction(method, control, ...args)); }
  finally { method.dispose(); }
}
function checkActive(id) {
  if (phase !== 'executing' || id !== active || Date.now() >= deadline) throw error('cell capability is closed', 'RLM_CELL_CLOSED');
}
async function initialize() {
  const [{ newQuickJSWASMModuleFromVariant }, variant] = await Promise.all([import(workerData.core), import(workerData.variant)]);
  const module = await newQuickJSWASMModuleFromVariant(variant.default);
  runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryLimitBytes);
  runtime.setMaxStackSize(limits.maxStackBytes);
  runtime.removeModuleLoader();
  runtime.setInterruptHandler(() => ++checks > limits.maxInterruptChecks || Date.now() >= deadline);
  vm = runtime.newContext();
  const bridge = vm.newFunction('__dshBridge', (cell, method, input) => {
    const id = vm.getNumber(cell);
    checkActive(id);
    if (++calls > limits.maxHostCalls || pending.size >= limits.maxPendingHostCalls) throw error('cell host-call limit exceeded', 'RLM_HOST_CALL_LIMIT');
    const name = boundedString(method, limits.maxBridgeBytes);
    if (!['spawn', 'listChildren', 'childSummaries', 'readChildResult', 'deleteChild'].includes(name)) throw error('host method unavailable');
    const args = boundedString(input, limits.maxBridgeBytes);
    const deferred = vm.newPromise();
    const callId = ++ordinal;
    pending.set(callId, { deferred, cell: id });
    parentPort.postMessage({ type: 'host-call', executionId: id, callId, method: name, args });
    return deferred.handle;
  });
  const logger = vm.newFunction('__dshLog', (cell, input) => {
    checkActive(vm.getNumber(cell));
    const text = boundedString(input, limits.maxLogBytes);
    logBytes += Buffer.byteLength(text);
    if (logBytes > limits.maxLogBytes) throw error('cell log limit exceeded', 'RLM_OUTPUT_LIMIT');
    logs.push(text);
  });
  vm.setProp(vm.global, '__dshBridge', bridge);
  vm.setProp(vm.global, '__dshLog', logger);
  bridge.dispose(); logger.dispose();
  control = unwrap(vm.evalCode(workerData.guest));
  const initial = vm.newString(workerData.initial);
  try { callControl('initialize', initial).dispose(); } finally { initial.dispose(); }
}
async function execute(message) {
  if (active !== undefined) throw error('concurrent guest cell refused');
  active = message.executionId;
  deadline = message.deadline;
  checks = 0; calls = 0; logBytes = 0; logs = []; hostFailure = undefined;
  let root;
  let rootValue;
  let caps;
  try {
    if (!vm) await initialize();
    const tsModule = await import(workerData.typescript);
    const analyze = new Function('ts', workerData.analyzer + '; return analyzeCell;')(tsModule.default ?? tsModule);
    const analyzed = analyze(message.code, tsModule.default ?? tsModule);
    if (Date.now() >= deadline) throw error('cell initialization deadline exceeded', 'RLM_CELL_TIMEOUT');
    const names = vm.newString(JSON.stringify(analyzed.names));
    const id = vm.newNumber(active);
    try { caps = callControl('begin', names, id); } finally { names.dispose(); id.dispose(); }
    phase = 'executing';
    const fn = unwrap(vm.evalCode(analyzed.code));
    const rlm = vm.getProp(caps, 'rlm');
    const console = vm.getProp(caps, 'console');
    try { root = unwrap(vm.callFunction(fn, vm.undefined, rlm, console)); }
    finally { fn.dispose(); rlm.dispose(); console.dispose(); }
    for (;;) {
      if (Date.now() >= deadline) throw error('cell deadline exceeded', 'RLM_CELL_TIMEOUT');
      const jobs = runtime.executePendingJobs(limits.jobBatchSize);
      if (jobs.error) { try { throw error(describe(jobs.error)); } finally { jobs.error.dispose(); } }
      if (rootValue === undefined) {
        const state = vm.getPromiseState(root);
        if (state.type === 'rejected') { try { throw error(describe(state.error), hostFailure?.code ?? 'RLM_GUEST_ERROR'); } finally { state.error.dispose(); } }
        if (state.type === 'fulfilled') rootValue = state.value;
      }
      if (rootValue !== undefined && pending.size === 0 && !runtime.hasPendingJob()) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    if (hostFailure) throw error(hostFailure.message, hostFailure.code);
    phase = 'snapshot';
    const packed = callControl('pack', rootValue);
    let result;
    try { result = JSON.parse(boundedString(packed, limits.maxBridgeBytes)); } finally { packed.dispose(); }
    let total = Buffer.byteLength(JSON.stringify(result.context));
    if (total > workerData.snapshotLimits.maxBytes || total > workerData.snapshotLimits.maxVariableBytes) throw error('context snapshot limit exceeded', 'RLM_OUTPUT_LIMIT');
    result.variables = result.variables.map(item => {
      if (item.error) return { name: item.name, declaration: item.declaration, error: item.error };
      const raw = JSON.stringify({ defined: item.defined, value: item.value });
      const bytes = Buffer.byteLength(raw);
      if (bytes > workerData.snapshotLimits.maxVariableBytes || total + bytes > workerData.snapshotLimits.maxBytes) return { name: item.name, declaration: item.declaration, error: 'binding exceeds snapshot limit' };
      total += bytes;
      return { name: item.name, declaration: item.declaration, valueBase64: 'qjs-json-v1:' + Buffer.from(raw).toString('base64') };
    });
    result.degradedVariables = result.variables.filter(item => item.error).map(item => item.name);
    result.logs = logs;
    const wire = JSON.stringify(result);
    if (Buffer.byteLength(wire) > limits.maxBridgeBytes) throw error('cell result limit exceeded', 'RLM_OUTPUT_LIMIT');
    parentPort.postMessage({ type: 'result', executionId: active, result: wire });
  } catch (failure) {
    parentPort.postMessage({ type: 'error', executionId: active, code: failure.code ?? 'RLM_GUEST_ERROR', message: String(failure.message).slice(0, limits.maxBridgeBytes) });
  } finally {
    phase = 'closed';
    for (const { deferred } of pending.values()) deferred.dispose();
    pending.clear();
    rootValue?.dispose(); root?.dispose(); caps?.dispose();
    if (control) { try { callControl('close').dispose(); } catch { /* Parent terminates a failed or timed-out Worker. */ } }
    active = undefined;
  }
}
parentPort.on('message', message => {
  if (message.type === 'execute') { void execute(message); return; }
  if (message.type !== 'host-result' || phase !== 'executing' || message.executionId !== active) return;
  const record = pending.get(message.callId);
  if (!record || record.cell !== active) return;
  pending.delete(message.callId);
  try {
    if (!message.ok) {
      hostFailure = { message: message.message, code: message.code };
      const handle = vm.newError({ message: message.message });
      record.deferred.reject(handle); handle.dispose();
    } else {
      if (Buffer.byteLength(message.value) > limits.maxBridgeBytes) throw error('host result exceeds byte limit');
      const serialized = vm.newString(message.value);
      let handle;
      try { handle = callControl('decode', serialized); } finally { serialized.dispose(); }
      record.deferred.resolve(handle); handle.dispose();
    }
  } catch (failure) {
    hostFailure = { message: failure.message, code: failure.code ?? 'RLM_GUEST_ERROR' };
    const handle = vm.newError({ message: failure.message }); record.deferred.reject(handle); handle.dispose();
  } finally { record.deferred.dispose(); }
});
`
