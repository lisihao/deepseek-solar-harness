import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RESULT_MARKER = 'DSH_ORCHESTRATION_E2E_RESULT='
const scriptPath = fileURLToPath(import.meta.url)
const defaultAppRoot = '/Applications/DSH Desktop.app'
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'indeterminate'])

function assert(condition, message) {
  if (!condition) throw new Error(`verify-installed-orchestration-e2e: ${message}`)
}

function valueAfter(name) {
  const argument = process.argv.slice(2).find(value => value.startsWith(`${name}=`))
  return argument?.slice(name.length + 1)
}

function appVersion(appRoot) {
  return execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw',
    join(appRoot, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim()
}

function commonNode(id, overrides = {}) {
  return {
    id,
    dependsOn: [],
    requiredForCompletion: true,
    title: id,
    task: `Return exactly ${id}. Do not call tools.`,
    role: 'implementation',
    capabilityRequirements: [],
    capabilityBudget: [],
    contextPolicy: {
      maxTokens: 8_192,
      allowedSourceKinds: ['intent', 'artifact', 'capsule', 'knowledge'],
      unavailableSource: 'block',
    },
    effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
    readScopes: [],
    writeScopes: [],
    approvedSecretRefs: [],
    acceptance: [{ id: 'completed', description: 'native subscription operator completes', kind: 'operator-completed' }],
    retryPolicy: { maxAttempts: 2, backoffMs: 250, retryableCodes: ['RUNTIME_UNAVAILABLE'] },
    phase: 'execution',
    rlm: { mode: 'disabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
    ...overrides,
  }
}

function graph(title, workspace, nodes, maxParallel = 4) {
  return { version: 1, title, workspace, maxParallel, risk: 'low', nodes }
}

function admission(sourceSessionId, optimization, overrides = {}) {
  return {
    policy: 'auto',
    route: 'taskgraph',
    sourceSessionId,
    rlm: 'auto',
    continualHarness: 'off',
    optimization,
    ...overrides,
  }
}

async function startRun(client, request, timeoutMs = 20 * 60_000) {
  const compilation = await client.compile(request)
  assert(compilation.requiresClarification === false, `${request.graph.title} unexpectedly requires clarification`)
  const started = await client.start({ compilationId: compilation.compilationId })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await client.inspect(String(started.runId))
    if (terminalStates.has(snapshot.state)) {
      const events = (await client.readEvents({ runId: snapshot.runId, limit: 500 })).events
      if (snapshot.state !== 'completed' || snapshot.nodes.some(node => node.state !== 'passed')) {
        throw new Error(`${request.graph.title} ended as ${snapshot.state}: ${JSON.stringify({ snapshot, events })}`)
      }
      return { snapshot, events }
    }
    if (Date.now() >= deadline) throw new Error(`${request.graph.title} did not settle within ${String(timeoutMs)}ms`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
}

function allocationByNode(events) {
  return new Map(events
    .filter(event => event.type === 'model.allocated' && event.nodeId !== undefined)
    .map(event => [event.nodeId, event.data]))
}

function assertNativeCompleted(result) {
  for (const node of result.snapshot.nodes) {
    assert(node.modelSource === 'native-subscription', `${node.id} used ${String(node.modelSource)} instead of a subscription`)
    assert(typeof node.model === 'string' && node.model.length > 0, `${node.id} did not retain its selected model`)
    assert(node.evidenceRefs.length === 1, `${node.id} did not retain exactly one accepted Evidence artifact`)
  }
}

function assertQuotaAcceleratedAllocation(providers, allocation, objective) {
  assert(allocation?.tier === 'low', `${objective} selected ${String(allocation?.tier)} instead of an accelerated low tier`)
  assert(allocation.rationale?.includes('accelerate-before-quota-reset') === true, `${objective} low-tier allocation did not record quota-reset acceleration`)
  const provider = providers.find(candidate => candidate.operatorId === allocation.operatorId)
  const pool = provider?.quotaPools?.find(candidate => candidate.poolId === allocation.quotaPoolId)
  assert(pool !== undefined, `${objective} allocation references unknown quota pool ${String(allocation.quotaPoolId)}`)
  const nowSeconds = Math.floor(Date.now() / 1_000)
  const urgent = [pool.primary, pool.secondary].some(window => (
    window?.resetsAt !== undefined
    && window.resetsAt > nowSeconds
    && window.resetsAt - nowSeconds <= 6 * 60 * 60
    && window.usedPercent < 100
  ))
  assert(urgent, `${objective} quota pool ${pool.poolId} is not actually approaching reset`)
}

async function runInner(appRoot) {
  const version = appVersion(appRoot)
  process.env.DSH_BUILD_COMMIT = `desktop-${version}`
  const unpackedRoot = join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked')
  const orchestrationModule = pathToFileURL(join(
    unpackedRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-orchestration-local',
    'lib',
    'index.js',
  )).href
  const residentModule = pathToFileURL(join(
    unpackedRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-resident-operator-local',
    'lib',
    'index.js',
  )).href
  const [{ OrchestrationDaemonClient }, { ResidentDaemonClient }] = await Promise.all([
    import(orchestrationModule),
    import(residentModule),
  ])
  const dshHome = join(homedir(), '.dsh')
  const client = new OrchestrationDaemonClient({
    root: join(dshHome, 'orchestrations'),
    dshHome,
    autoStart: false,
    connectTimeoutMs: 15_000,
    residentDriverModules: [],
  })
  const resident = new ResidentDaemonClient({
    root: join(dshHome, 'resident-operators'),
    autoStart: false,
    connectTimeoutMs: 15_000,
    pollIntervalMs: 250,
    driverModules: [],
  })
  await client.ready()
  const providers = await resident.providers()
  for (const operatorId of ['claude-code', 'codex']) {
    const provider = providers.find(candidate => candidate.operatorId === operatorId)
    assert(provider?.available === true, `${operatorId} subscription Provider is unavailable: ${provider?.unavailableReason ?? 'missing'}`)
    assert(provider.authentication === 'native-subscription', `${operatorId} did not attest native-subscription authentication`)
  }
  process.stdout.write('[10%] Desktop daemon 与 Claude Code/Codex 订阅资格已确认\n')

  const nonce = randomUUID().slice(0, 8)
  const workspace = mkdtempSync('/tmp/dsh-orchestration-e2e-')
  const sourceSessionId = `desktop-e2e-${version}-${nonce}`

  const cycleGraph = graph(`DSH ${version} cycle rejection ${nonce}`, workspace, [
    commonNode('cycle-a', { dependsOn: ['cycle-b'] }),
    commonNode('cycle-b', { dependsOn: ['cycle-a'] }),
  ], 2)
  let cycleCode
  try {
    await client.compile({ intent: { request: 'Reject a cyclic TaskGraph.' }, graph: cycleGraph })
  } catch (error) {
    cycleCode = error?.code
  }
  assert(cycleCode === 'GRAPH_CYCLE', `cyclic TaskGraph returned ${String(cycleCode)} instead of GRAPH_CYCLE`)
  process.stdout.write('[20%] 循环 Graph 已在真实 daemon 边界拒绝\n')

  const goalExpectations = { quality: 'high', balanced: 'medium-or-accelerated-low', economy: 'low' }
  const goalResults = await Promise.all(Object.entries(goalExpectations).map(async ([objective, expectedTier]) => {
    const id = `goal-${objective}`
    const title = `DSH ${version} ${objective} objective E2E ${nonce}`
    const result = await startRun(client, {
      intent: { request: `Exercise the ${objective} model-allocation objective.` },
      admission: admission(sourceSessionId, objective),
      graph: graph(title, workspace, [commonNode(id, {
        title: `${objective} objective`,
        task: `Implementation allocation acceptance. Return exactly DSH_E2E_${objective.toUpperCase()}_${nonce}. Do not call tools.`,
      })], 1),
    })
    assertNativeCompleted(result)
    const allocation = allocationByNode(result.events).get(id)
    if (objective === 'balanced') {
      if (allocation?.tier !== 'medium') assertQuotaAcceleratedAllocation(providers, allocation, objective)
    } else {
      assert(allocation?.tier === expectedTier, `${objective} selected ${String(allocation?.tier)} instead of ${expectedTier}`)
    }
    return { objective, expectedTier, title, runId: String(result.snapshot.runId), allocation }
  }))
  process.stdout.write('[40%] 质量/综合/成本目标已通过真实订阅模型验收\n')

  const pipelineTitle = `DSH ${version} RLM parallel pipeline E2E ${nonce}`
  const pipeline = await startRun(client, {
    intent: { request: 'Run a high-tier plan, parallel low-tier leaves, and a high-tier verification gate.' },
    admission: admission(sourceSessionId, 'speed', { continualHarness: 'workspace' }),
    graph: graph(pipelineTitle, workspace, [
      commonNode('plan', {
        title: 'Plan with bounded RLM',
        task: `Plan two independent verification paths for orchestration E2E ${nonce}. Use only the supplied task context; do not call tools. Return a concise plan ending with PLAN_${nonce}.`,
        role: 'architecture planning',
        phase: 'planning',
        rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
      }),
      commonNode('worker-a', {
        dependsOn: ['plan'],
        title: 'Parallel worker A',
        task: `Implementation worker A for orchestration E2E ${nonce}. Return exactly WORKER_A_${nonce}. Do not call tools.`,
        writeScopes: ['e2e/worker-a'],
      }),
      commonNode('worker-b', {
        dependsOn: ['plan'],
        title: 'Parallel worker B',
        task: `Implementation worker B for orchestration E2E ${nonce}. Return exactly WORKER_B_${nonce}. Do not call tools.`,
        writeScopes: ['e2e/worker-b'],
      }),
      commonNode('verify', {
        dependsOn: ['worker-a', 'worker-b'],
        title: 'High-tier verification',
        task: `Verify the two orchestration E2E ${nonce} worker outcomes using only the supplied upstream artifacts. Do not call tools. Return a concise verdict ending with VERIFIED_${nonce}.`,
        role: 'verification review',
        phase: 'verification',
        readScopes: ['e2e/worker-a', 'e2e/worker-b'],
      }),
    ], 2),
  })
  assertNativeCompleted(pipeline)
  const pipelineAllocations = allocationByNode(pipeline.events)
  assert(pipelineAllocations.get('plan')?.tier === 'high', 'planning node did not use a high-tier model')
  assert(pipelineAllocations.get('worker-a')?.tier === 'low', 'worker-a did not use a low-tier model')
  assert(pipelineAllocations.get('worker-b')?.tier === 'low', 'worker-b did not use a low-tier model')
  assert(pipelineAllocations.get('verify')?.tier === 'high', 'verification node did not use a high-tier model')
  const rlm = pipeline.events.find(event => event.type === 'rlm.resolved' && event.nodeId === 'plan')
  assert(rlm?.data.enabled === true, 'planning node did not seal and execute an enabled RLM plan')
  const workerIds = new Set(['worker-a', 'worker-b'])
  const workerDispatches = pipeline.events.filter(event => event.type === 'node.dispatched' && workerIds.has(event.nodeId))
  const workerEvidence = pipeline.events.filter(event => event.type === 'node.evidence.accepted' && workerIds.has(event.nodeId))
  assert(workerDispatches.length === 2 && workerEvidence.length === 2, 'parallel workers did not both dispatch and settle')
  assert(Math.max(...workerDispatches.map(event => event.sequence)) < Math.min(...workerEvidence.map(event => event.sequence)), 'parallel workers were not both active before either settled')
  process.stdout.write('[65%] RLM + 高低阶分工 + DAG 并行已通过真实执行\n')

  const conflictTitle = `DSH ${version} scope conflict E2E ${nonce}`
  const conflict = await startRun(client, {
    intent: { request: 'Serialize overlapping scopes without deadlock.' },
    admission: admission(sourceSessionId, 'speed'),
    graph: graph(conflictTitle, workspace, [
      commonNode('conflict-a', {
        task: `First shared-scope worker. Return exactly CONFLICT_A_${nonce}. Do not call tools.`,
        writeScopes: ['e2e/shared'],
      }),
      commonNode('conflict-b', {
        task: `Second shared-scope worker. Return exactly CONFLICT_B_${nonce}. Do not call tools.`,
        writeScopes: ['e2e/shared'],
      }),
    ], 2),
  })
  assertNativeCompleted(conflict)
  const conflictWait = conflict.events.find(event => event.type === 'scheduler.waiting.updated'
    && Array.isArray(event.data.waiting)
    && event.data.waiting.some(entry => entry?.code === 'SCOPE_CONFLICT'))
  assert(conflictWait !== undefined, 'scope conflict was not retained in the durable scheduler event stream')
  const conflictDispatches = conflict.events.filter(event => event.type === 'node.dispatched')
  const conflictEvidence = conflict.events.filter(event => event.type === 'node.evidence.accepted')
  assert(conflictDispatches.length === 2 && conflictEvidence.length === 2, 'serialized scope workers did not both complete')
  assert(conflictEvidence[0].sequence < conflictDispatches[1].sequence, 'overlapping scope workers executed concurrently')
  process.stdout.write('[80%] scope 冲突已串行消解，未形成死锁\n')

  const recallTitle = `DSH ${version} Continuous Harness recall E2E ${nonce}`
  const recall = await startRun(client, {
    intent: { request: 'Reuse the preceding workspace-scoped orchestration outcome.' },
    admission: admission(sourceSessionId, 'balanced', { continualHarness: 'workspace' }),
    graph: graph(recallTitle, workspace, [commonNode('recall', {
      title: 'Continuous Harness recall',
      task: `Review prior orchestration E2E ${nonce} outcomes and return exactly HARNESS_RECALLED_${nonce}. Do not call tools.`,
      role: 'orchestration review',
      phase: 'execution',
    })], 1),
  })
  assertNativeCompleted(recall)
  const harness = recall.events.find(event => event.type === 'harness.snapshot' && event.nodeId === 'recall')
  assert(Number(harness?.data.entryCount ?? 0) > 0, 'Continuous Harness recall snapshot did not include an earlier durable outcome')
  assert(Number(harness?.data.generation ?? 0) > 0, 'Continuous Harness generation did not advance')
  process.stdout.write('[90%] Continuous Harness 跨 Run 回忆已通过\n')

  const runs = [
    ...goalResults,
    { title: pipelineTitle, runId: String(pipeline.snapshot.runId) },
    { title: conflictTitle, runId: String(conflict.snapshot.runId) },
    { title: recallTitle, runId: String(recall.snapshot.runId) },
  ]
  const selectedModels = [
    ...goalResults.map(value => value.allocation),
    ...pipelineAllocations.values(),
  ].map(value => ({
    operatorId: value.operatorId,
    model: value.model,
    tier: value.tier,
    source: value.source,
    quotaPoolId: value.quotaPoolId ?? null,
  }))
  const evidence = {
    version,
    generatedAt: new Date().toISOString(),
    workspace,
    sourceSessionId,
    cycleRejection: cycleCode,
    providers: providers.map(provider => ({
      operatorId: provider.operatorId,
      available: provider.available,
      authentication: provider.authentication,
      models: provider.models.map(model => model.model),
      quotaPools: provider.quotaPools ?? [],
    })),
    goalResults,
    pipeline: {
      title: pipelineTitle,
      runId: String(pipeline.snapshot.runId),
      workerDispatchSequences: workerDispatches.map(event => event.sequence),
      workerEvidenceSequences: workerEvidence.map(event => event.sequence),
      rlm: rlm.data,
    },
    conflict: {
      title: conflictTitle,
      runId: String(conflict.snapshot.runId),
      wait: conflictWait.data,
      dispatchSequences: conflictDispatches.map(event => event.sequence),
      evidenceSequences: conflictEvidence.map(event => event.sequence),
    },
    continualHarness: {
      title: recallTitle,
      runId: String(recall.snapshot.runId),
      snapshot: harness.data,
    },
    selectedModels,
    runs,
  }
  process.stdout.write(`[100%] ${RESULT_MARKER}${JSON.stringify(evidence)}\n`)
}

function listeningPorts() {
  const rows = execFileSync('/usr/sbin/lsof', [
    '-nP', '-a', '-c', 'DSH Desktop', '-iTCP', '-sTCP:LISTEN', '-F', 'pn',
  ], { encoding: 'utf8' }).split('\n')
  return [...new Set(rows.flatMap(row => {
    if (!row.startsWith('n')) return []
    const match = row.match(/:(\d+)$/u)
    return match === null ? [] : [Number(match[1])]
  }))]
}

async function discoverDesktopEndpoints() {
  const deadline = Date.now() + 20_000
  for (;;) {
    let baseUrl
    let cdpTarget
    for (const port of listeningPorts()) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/api/orchestrations?include_diagnostics=1`)
        if (response.ok) baseUrl = `http://127.0.0.1:${String(port)}`
      } catch { /* A non-HTTP product listener is not the Desktop Host. */ }
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json`)
        if (!response.ok) continue
        const targets = await response.json()
        const target = targets.find(candidate => candidate.type === 'page' && typeof candidate.webSocketDebuggerUrl === 'string')
        if (target !== undefined) cdpTarget = target
      } catch { /* Only the explicit remote-debugging listener serves CDP discovery. */ }
    }
    if (baseUrl !== undefined && cdpTarget !== undefined) return { baseUrl, cdpTarget }
    if (Date.now() >= deadline) {
      assert(baseUrl !== undefined, 'running Desktop Host /api/orchestrations endpoint was not found')
      assert(cdpTarget !== undefined, 'running Desktop CDP page was not found; relaunch with --remote-debugging-port')
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
}

async function cdpSession(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', rejectPromise, { once: true })
  })
  let requestId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error === undefined) waiter.resolve(message.result)
    else waiter.reject(new Error(message.error.message))
  })
  return {
    evaluate(expression) {
      const id = ++requestId
      const result = new Promise((resolvePromise, rejectPromise) => {
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      })
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }))
      return result.then(response => {
        if (response.exceptionDetails !== undefined) throw new Error(response.exceptionDetails.text)
        return response.result.value
      })
    },
    close() { socket.close() },
  }
}

async function waitFor(read, accept, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`verify-installed-orchestration-e2e: ${message}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
}

async function verifyDesktopProjection(baseUrl, target, evidence) {
  for (const run of evidence.runs) {
    const response = await fetch(`${baseUrl}/api/orchestrations?run_id=${encodeURIComponent(run.runId)}&include_diagnostics=1`)
    assert(response.ok, `Desktop projection returned HTTP ${String(response.status)} for ${run.runId}`)
    const dashboard = await response.json()
    assert(dashboard.selectedRunId === run.runId, `Desktop projection did not select ${run.runId}`)
    assert(dashboard.runs.some(candidate => candidate.runId === run.runId && candidate.state === 'completed'), `${run.title} is not completed in Desktop projection`)
  }

  const cdp = await cdpSession(target)
  try {
    const openPanel = () => cdp.evaluate(`(() => {
      const button = document.querySelector('.dshDesktopOrchestrationAction')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })()`)
    let opened = await openPanel()
    if (!opened) {
      const selected = await cdp.evaluate(`(() => {
        const row = document.querySelector('[role="treeitem"][aria-selected="false"]')
        if (!(row instanceof HTMLElement)) return false
        row.click()
        return true
      })()`)
      assert(selected === true, 'Desktop has no persisted Session for the orchestration header action')
      await waitFor(
        () => cdp.evaluate(`document.querySelector('.dshDesktopOrchestrationAction') !== null`),
        value => value === true,
        'Desktop orchestration action did not mount after selecting a persisted Session',
      )
      opened = await openPanel()
    }
    assert(opened === true, 'Desktop orchestration Session action is not mounted')
    await waitFor(
      () => cdp.evaluate(`document.querySelector('[aria-label="持久化任务编排"]') !== null`),
      value => value === true,
      'Desktop orchestration dialog did not open',
    )
    await waitFor(
      () => cdp.evaluate(`(() => {
        const title = ${JSON.stringify(evidence.pipeline.title)}
        const button = [...document.querySelectorAll('.dshDesktopOrchestrationRun')]
          .find(candidate => candidate.textContent?.includes(title))
        if (!(button instanceof HTMLElement)) return false
        button.click()
        return true
      })()`),
      value => value === true,
      'Desktop orchestration panel did not render the E2E pipeline Run',
    )
    const view = await waitFor(
      () => cdp.evaluate(`(() => {
        const panel = document.querySelector('[aria-label="持久化任务编排"]')
        if (!(panel instanceof HTMLElement)) return null
        return {
          text: panel.innerText,
          completeStages: [...panel.querySelectorAll('.dshDesktopOrchestrationPipeline [data-complete="true"]')]
            .map(element => element.textContent),
          nodes: [...panel.querySelectorAll('.dshDesktopOrchestrationNodes > li')]
            .map(element => ({ state: element.getAttribute('data-state'), text: element.textContent })),
        }
      })()`),
      value => value?.text?.includes(evidence.pipeline.title) === true && value.nodes?.length === 4,
      'Desktop orchestration panel did not converge on the E2E pipeline Run',
    )
    for (const stage of ['Intent', 'Graph', 'Capsule', 'RLM', 'Harness', 'Context', 'Plan', 'Operator']) {
      assert(view.completeStages.includes(stage), `Desktop pipeline stage ${stage} is not complete`)
    }
    assert(view.nodes.every(node => node.state === 'passed'), 'Desktop DAG does not show all pipeline nodes as passed')
    assert(view.text.includes('高阶') && view.text.includes('低阶'), 'Desktop DAG does not expose high/low model allocation tiers')
    assert(view.text.includes('native-subscription') === false, 'raw model-source identifier leaked instead of the user-facing subscription label')
    return { title: evidence.pipeline.title, completeStages: view.completeStages, nodeCount: view.nodes.length }
  } finally {
    cdp.close()
  }
}

async function runOuter() {
  const appRoot = resolve(valueAfter('--app') ?? defaultAppRoot)
  const executable = join(appRoot, 'Contents', 'MacOS', 'DSH Desktop')
  const version = appVersion(appRoot)
  const endpoints = await discoverDesktopEndpoints()
  const child = spawn(executable, [scriptPath, '--inner', `--app=${appRoot}`], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_BUILD_COMMIT: `desktop-${version}`,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
    process.stdout.write(chunk)
  })
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', resolvePromise)
  })
  assert(exitCode === 0, `packaged orchestration E2E child exited ${String(exitCode)}`)
  const resultLine = output.split('\n').findLast(line => line.includes(RESULT_MARKER))
  assert(resultLine !== undefined, 'packaged orchestration E2E child returned no evidence')
  const evidence = JSON.parse(resultLine.slice(resultLine.indexOf(RESULT_MARKER) + RESULT_MARKER.length))
  const desktopProjection = await verifyDesktopProjection(endpoints.baseUrl, endpoints.cdpTarget, evidence)
  const result = {
    ...evidence,
    application: {
      appRoot,
      version,
      baseUrl: endpoints.baseUrl,
      cdpUrl: endpoints.cdpTarget.url,
      desktopProjection,
    },
  }
  const defaultEvidencePath = resolve(
    import.meta.dirname,
    '..',
    'dist',
    'acceptance',
    `orchestration-e2e-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`,
  )
  const evidencePath = resolve(valueAfter('--evidence') ?? defaultEvidencePath)
  mkdirSync(dirname(evidencePath), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(result, undefined, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ status: 'ok', evidencePath, application: result.application, runs: result.runs }, undefined, 2)}\n`)
}

if (process.argv.includes('--inner')) await runInner(resolve(valueAfter('--app') ?? defaultAppRoot))
else await runOuter()
