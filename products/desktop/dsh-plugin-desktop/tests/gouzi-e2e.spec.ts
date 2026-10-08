/**
 * Gouzi members as real processes: two `dsh-gouzi-worker` processes with their own homes, reached over HTTP by a
 * real orchestration daemon and by raw execution requests. The members run a keyless fixture driver, so no model,
 * subscription, or network service is used.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gouziRequestHash, type RemoteResidentExecuteRequest } from '@deepseek-ai/dsh-client-connection'
import {
  GouziAuthorityEpoch, GouziHostId, GouziId, GouziOwnerId, type GouziExecutionGrant, type LogicalTaskGraphV1, type OrchestrationExecutionEvidenceV1,
} from '@deepseek-ai/dsh-orchestration'
import {
  OrchestrationDaemon,
  OrchestrationDaemonClient,
  OrchestrationStore,
  RemoteSyncHttpClient,
  RemoteSyncRejectedError,
} from '@deepseek-ai/dsh-orchestration-local'
import { orchestrationGraphGuidance } from '@deepseek-ai/dsh-tool-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import * as OrchestrationLocal from '@deepseek-ai/dsh-orchestration-local'
import * as UiGouzi from '@deepseek-ai/dsh-ui-gouzi'
import { GouziHostService, type GouziProvisionInput, type GouziSshTarget } from '@deepseek-ai/dsh-ui-gouzi'
import { LocalGouziHost, Config as HostConfig } from '../src/gouzi-host.ts'
import { SYSTEM_SSH } from '../src/gouzi-ssh.ts'
import { GouziActiveLimitError, GouziSupervisor, residentDaemonPid } from '../src/gouzi-supervisor.ts'
import type { GouziWorkerReady } from '../src/gouzi-worker.ts'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_DRIVER = join(PACKAGE_ROOT, 'tests', 'fixtures', 'gouzi-fixture-driver.mjs')
const REPOSITORY = 'github.com/lisihao/gouzi-fixture'
const EPOCH = 'epoch-e2e'
const OPERATOR = 'gouzi-fixture'
const MEMBERS = ['gouzi-a', 'gouzi-b'] as const

let scratch: string
let membersRoot: string
let mainHome: string
let commit: string
let supervisor: GouziSupervisor
const ready = new Map<string, GouziWorkerReady>()
/** Host of the members adopted through the route; its members live under their own root. */
let adoptedHost: LocalGouziHost | undefined
let adoptedRoot = ''
const adoptedMemberIds = new Set<string>()

/** Whether the member adopted through the route still has a live process, read from its own ready record. */
function adoptedMemberRuns(gouziId: string): boolean {
  let record: GouziWorkerReady
  try {
    record = JSON.parse(readFileSync(join(adoptedRoot, gouziId, 'gouzi', 'worker.json'), 'utf8')) as GouziWorkerReady
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    process.kill(record.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Relative file names and bytes used to detect writes inside a candidate project. */
function projectFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        files[`${relative}/`] = 'directory'
        visit(join(directory, entry.name), `${relative}/`)
      }
      else files[relative] = createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex')
    }
  }
  visit(root, '')
  return files
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'maintenance.autoDetach=false', '-c', 'gc.autoDetach=false', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** Workspaces a member currently holds; a settled turn's workspace is released by the member. */
function materialized(gouziId: string): string[] {
  const executions = join(supervisor.homeOf(gouziId), 'orchestrations', 'remote-workspaces', 'executions')
  return existsSync(executions) ? readdirSync(executions) : []
}

/** Executed turns recorded by the fixture driver as `[commandId, workspace]`. */
function executions(gouziId: string): Array<[string, string]> {
  const path = join(supervisor.homeOf(gouziId), 'fixture-executions.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map((line) => {
    const [commandId, workspace] = line.split('\t')
    return [commandId!, workspace!]
  })
}

function commandIds(gouziId: string): string[] {
  return executions(gouziId).map(([commandId]) => commandId)
}

function endpointOf(gouziId: string): string {
  return `http://127.0.0.1:${String(ready.get(gouziId)?.port)}/`
}

function request(commandId: string): RemoteResidentExecuteRequest {
  return {
    commandId,
    operatorId: OPERATOR,
    laneId: commandId,
    prompt: [{ type: 'text', text: 'write your file' }],
    workspaceIdentity: { version: 1, repository: REPOSITORY, commit },
    nativeToolPolicy: 'disabled',
  } as RemoteResidentExecuteRequest
}

function grantFor(gouziId: string, plan: RemoteResidentExecuteRequest, patch: Partial<Record<keyof GouziExecutionGrant, unknown>> = {}): GouziExecutionGrant {
  return {
    runId: 'run-wire', nodeId: 'node-wire', attempt: 1, executionId: plan.commandId, gouziId, generation: 1,
    authorityEpoch: EPOCH, planHash: gouziRequestHash(plan),
    scopes: { read: [], write: [], effects: [] }, credentialRefs: [],
    deadline: new Date(Date.now() + 600_000).toISOString(), offlineUntil: new Date(Date.now() + 600_000).toISOString(),
    ...patch,
  } as unknown as GouziExecutionGrant
}

function analysisGraph(workspace: string, operatorId: string): LogicalTaskGraphV1 {
  const none = { read: [], write: [], execute: [], network: [], cost: [], risk: [] }
  return {
    version: 1, title: 'gouzi e2e', workspace, maxParallel: 1, risk: 'low',
    nodes: [{
      id: 'A', dependsOn: [], requiredForCompletion: true, title: 'Write', task: 'Write one file.', role: 'analysis',
      capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'degrade' },
      effectBudget: none, readScopes: ['.'], writeScopes: [], approvedSecretRefs: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
      operator: { preferredIds: [operatorId] },
    }],
  } as LogicalTaskGraphV1
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`did not converge: ${JSON.stringify(value).slice(0, 600)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

describe.sequential('Gouzi members as real processes', () => {
  let daemon: OrchestrationDaemon | undefined

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-gouzi-e2e-'))
    membersRoot = join(scratch, 'members')
    mainHome = join(scratch, 'main')
    const source = join(scratch, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'README.md'), 'gouzi fixture\n')
    git(source, 'init', '--initial-branch=main')
    git(source, 'config', 'user.name', 'DSH Test')
    git(source, 'config', 'user.email', 'dsh-test@example.invalid')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'fixture')
    git(source, 'remote', 'add', 'origin', 'https://github.com/lisihao/gouzi-fixture.git')
    commit = git(source, 'rev-parse', 'HEAD')

    supervisor = new GouziSupervisor({
      membersRoot,
      workerCommand: () => ({
        command: process.execPath,
        args: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href, join(PACKAGE_ROOT, 'src', 'gouzi-worker-bin.ts'), '--host', '127.0.0.1', '--port', '0'],
      }),
      activeLimit: 2,
      readyTimeoutMs: 120_000,
      stopTimeoutMs: 20_000,
    })
    for (const gouziId of [...MEMBERS, 'gouzi-c']) {
      const project = join(supervisor.homeOf(gouziId), 'selected-project')
      mkdirSync(dirname(project), { recursive: true })
      git(dirname(project), 'clone', '--', source, project)
      const projectId = createHash('sha256').update(realpathSync(project)).digest('hex')
      const home = await supervisor.provision({
        gouziId, ownerId: 'owner-e2e', hostId: 'host-e2e', generation: 1, authorityEpoch: EPOCH,
        projects: [{ projectId, source: realpathSync(project), repository: REPOSITORY }], defaultProjectId: projectId,
      })
      // Raw Git wire requests exercise the existing materialization path independently of Gouzi defaults.
      const clusterPath = join(home, 'orchestrations', 'cluster.json')
      const cluster = JSON.parse(readFileSync(clusterPath, 'utf8')) as {
        members: Array<{ remoteExecution: { repositories: Array<{ repository: string; source: string }> } }>
      }
      cluster.members[0]!.remoteExecution.repositories = [{ repository: REPOSITORY, source }]
      writeFileSync(clusterPath, `${JSON.stringify(cluster, null, 2)}\n`)
      // A member-home patch is the existing way to add a Resident Driver module to one profile.
      writeFileSync(join(home, 'cordis.patch.yml'), [
        '- id: resident-operators',
        '  config:',
        '    driverModules:',
        `      - ${FIXTURE_DRIVER}`,
        '',
      ].join('\n'))
    }
    await Promise.all(MEMBERS.map(async (gouziId) => { ready.set(gouziId, await supervisor.start(gouziId)) }))
  }, 300_000)

  afterAll(async () => {
    await daemon?.close()
    if (adoptedHost !== undefined) {
      for (const gouziId of adoptedMemberIds) await adoptedHost.stop('local', gouziId, { reclaimResident: true })
    }
    for (const gouziId of [...MEMBERS, 'gouzi-c']) await supervisor.stop(gouziId, { reclaimResident: true })
    rmSync(scratch, { recursive: true, force: true })
  }, 60_000)

  it('runs each member as its own process with its own home and identity, and caps the running members', async () => {
    const a = ready.get('gouzi-a')!
    const b = ready.get('gouzi-b')!
    expect(a.pid).not.toBe(b.pid)
    expect(a.port).not.toBe(b.port)
    expect(supervisor.homeOf('gouzi-a')).not.toBe(supervisor.homeOf('gouzi-b'))
    expect(a).toMatchObject({ gouziId: 'gouzi-a', generation: 1, authorityEpoch: EPOCH })
    expect(b).toMatchObject({ gouziId: 'gouzi-b', generation: 1, authorityEpoch: EPOCH })
    // A third member would exceed the two the pilot host may run at once.
    await expect(supervisor.start('gouzi-c')).rejects.toBeInstanceOf(GouziActiveLimitError)
    expect(supervisor.running('gouzi-c')).toBeUndefined()
    // The member runs no scheduler: no orchestration state is created in its home.
    for (const gouziId of MEMBERS) {
      expect(existsSync(join(supervisor.homeOf(gouziId), 'orchestrations', 'state.sqlite'))).toBe(false)
    }
  })

  it('refuses a request without a grant, with a wrong generation, epoch, plan hash, or deadline, before any effect', async () => {
    const client = new RemoteSyncHttpClient(endpointOf('gouzi-a'))
    const plan = request('orch:wire:refused:1')
    const refusals: Array<[string, Record<string, unknown> | undefined, string]> = [
      ['no grant', undefined, 'gouziGrant must be an object'],
      ['generation', { generation: 2 }, 'GOUZI_GENERATION_MISMATCH'],
      ['epoch', { authorityEpoch: 'epoch-stale' }, 'GOUZI_EPOCH_MISMATCH'],
      ['member', { gouziId: 'gouzi-b' }, 'GOUZI_IDENTITY_MISMATCH'],
      ['plan hash', { planHash: 'f'.repeat(64) }, 'GOUZI_PLAN_MISMATCH'],
      ['deadline', { deadline: new Date(Date.now() - 1_000).toISOString() }, 'GOUZI_GRANT_EXPIRED'],
    ]
    for (const [label, patch, code] of refusals) {
      const body = patch === undefined ? plan : { ...plan, gouziGrant: grantFor('gouzi-a', plan, patch) }
      await expect(client.operatorExecute(body), label).rejects.toThrow(code)
    }
    expect(materialized('gouzi-a')).toEqual([])
    expect(commandIds('gouzi-a')).toEqual([])
  })

  it('executes an authorized request once, returns the stored receipt for a repeat, and conflicts on another request', async () => {
    const client = new RemoteSyncHttpClient(endpointOf('gouzi-a'))
    const plan = request('orch:wire:ok:1')
    const grant = grantFor('gouzi-a', plan)
    const first = await client.operatorExecute({ ...plan, gouziGrant: grant })
    const repeat = await client.operatorExecute({ ...plan, gouziGrant: grant })
    expect(repeat).toEqual(first)

    const settled = await eventually(() => client.operatorInspect(first.turnId), turn => turn.state === 'settled')
    expect(settled.result?.stopReason).toBe('completed')
    expect(commandIds('gouzi-a')).toEqual(['orch:wire:ok:1'])
    // The turn ran in a workspace the member materialized under its own home.
    expect(executions('gouzi-a')[0]![1]).toContain(join(supervisor.homeOf('gouzi-a'), 'orchestrations', 'remote-workspaces'))

    const changed = { ...plan, laneId: 'another-lane' }
    const error = await client.operatorExecute({ ...changed, gouziGrant: grantFor('gouzi-a', changed) }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(RemoteSyncRejectedError)
    expect(String(error)).toContain('GOUZI_EXECUTION_CONFLICT')
    expect(commandIds('gouzi-a')).toEqual(['orch:wire:ok:1'])
    // The other member never saw the work.
    expect(commandIds('gouzi-b')).toEqual([])
    expect(materialized('gouzi-b')).toEqual([])
  })

  it('reconciles after the member process restarts without running the execution a second time', async () => {
    const before = ready.get('gouzi-a')!
    await supervisor.stop('gouzi-a')
    expect(supervisor.running('gouzi-a')).toBeUndefined()
    const after = await supervisor.start('gouzi-a')
    ready.set('gouzi-a', after)
    expect(after.pid).not.toBe(before.pid)
    expect(after.incarnation).toBe(before.incarnation + 1)

    // The main instance lost the response: it asks again with the same execution id and grant.
    const client = new RemoteSyncHttpClient(endpointOf('gouzi-a'))
    const plan = request('orch:wire:ok:1')
    const replayed = await client.operatorExecute({ ...plan, gouziGrant: grantFor('gouzi-a', plan) })
    const turn = await client.operatorInspect(replayed.turnId)
    expect(turn.state).toBe('settled')
    expect(commandIds('gouzi-a')).toEqual(['orch:wire:ok:1'])
  }, 180_000)

  it('runs two TaskGraph runs on two members through a real orchestration daemon, each in its own workspace', async () => {
    const mainRoot = join(mainHome, 'orchestrations')
    const store = new OrchestrationStore(mainRoot)
    store.gouzi.pairHost({
      hostId: GouziHostId('host-e2e'), label: 'This Mac', authorityEpoch: GouziAuthorityEpoch(EPOCH), credentialRef: 'GOUZI_HOST_E2E',
    })
    for (const gouziId of MEMBERS) {
      store.gouzi.create({
        gouziId: GouziId(gouziId), ownerId: GouziOwnerId('owner-e2e'), hostId: GouziHostId('host-e2e'),
        name: gouziId, avatarId: 'shiba', role: 'development', grantDeadlineMs: 600_000,
      })
      store.gouzi.setMembership(GouziId(gouziId), 'enabled')
      store.gouzi.setEndpoint(GouziId(gouziId), endpointOf(gouziId))
    }
    store.close()

    // Local execution is not used; any call to the local Resident client would be a bug in the routing.
    const local = new Proxy({ providers: () => Promise.resolve([]) }, {
      get: (target, property: string) => {
        if (property in target) return (target as Record<string, unknown>)[property]
        throw new Error(`the local Resident client must not be used: ${property}`)
      },
    }) as unknown as ResidentDaemonClient
    daemon = new OrchestrationDaemon({
      root: mainRoot, dshHome: mainHome, residentClient: local, modelWorkerProviders: [], schedulerIntervalMs: 50,
    })
    await daemon.start()
    const client = new OrchestrationDaemonClient({ root: mainRoot, dshHome: mainHome, autoStart: false, connectTimeoutMs: 5_000 })
    const workspace = join(scratch, 'source')

    const runs = await Promise.all(MEMBERS.map(async (gouziId) => {
      const compilation = await client.compile({
        intent: { request: `Write the file on ${gouziId}.` },
        admission: {
          policy: 'auto', route: 'taskgraph', sourceSessionId: `e2e-${gouziId}`,
          rlm: 'disabled', continualHarness: 'off', optimization: 'economy',
        },
        graph: analysisGraph(workspace, `gouzi.${gouziId}.${OPERATOR}`),
      })
      return client.start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId })
    }))
    const completed = await Promise.all(runs.map(started => eventually(
      () => client.inspect(String(started.runId)), value => value.state === 'completed' || value.state === 'failed', 120_000,
    )))
    expect(completed.map(value => value.state)).toEqual(['completed', 'completed'])
    expect(completed.map(value => value.nodes[0]?.operatorId)).toEqual(MEMBERS.map(gouziId => `gouzi.${gouziId}.${OPERATOR}`))

    // Each member executed its own run in its selected directory. gouzi-a also holds the earlier Git wire turn.
    const [a, b] = MEMBERS.map(gouziId => executions(gouziId))
    expect(a!.map(([commandId]) => commandId)).toEqual(['orch:wire:ok:1', expect.stringContaining(String(runs[0]!.runId))])
    expect(b!.map(([commandId]) => commandId)).toEqual([expect.stringContaining(String(runs[1]!.runId))])
    expect(a![1]![1]).toBe(realpathSync(join(supervisor.homeOf('gouzi-a'), 'selected-project')))
    expect(b![0]![1]).toBe(realpathSync(join(supervisor.homeOf('gouzi-b'), 'selected-project')))
    expect(a![1]![1]).not.toBe(b![0]![1])

    // The daemon recorded the observed state of both members in the main store.
    const watcher = new OrchestrationStore(mainRoot)
    for (const gouziId of MEMBERS) {
      expect(watcher.gouzi.read(GouziId(gouziId))).toMatchObject({ connection: 'online' })
    }
    watcher.close()

    const template = JSON.parse(orchestrationGraphGuidance.slice(orchestrationGraphGuidance.indexOf('{"version":1'))) as LogicalTaskGraphV1
    const selectedOperator = `gouzi.gouzi-a.${OPERATOR}`
    const selectedProject = join(supervisor.homeOf('gouzi-a'), 'selected-project')
    for (const name of readdirSync(selectedProject).filter(name => name.startsWith('executed-'))) rmSync(join(selectedProject, name))
    const otherBefore = commandIds('gouzi-b')
    const compilation = await client.compile({
      intent: { request: 'Let gouzi-a read the repository README.' },
      admission: { policy: 'auto', route: 'taskgraph', sourceSessionId: 'readme-template-e2e', rlm: 'disabled', continualHarness: 'off' },
      graph: { ...template, workspace, nodes: template.nodes.map(node => ({ ...node, operator: { preferredIds: [selectedOperator] } })) },
    })
    const started = await client.start({ commandId: `readme:${compilation.compilationId}`, compilationId: compilation.compilationId })
    const read = await eventually(
      () => client.inspect(String(started.runId)), value => value.state === 'completed' || value.state === 'failed', 120_000,
    )
    expect(read.state).toBe('completed')
    expect(read.nodes[0]?.operatorId).toBe(selectedOperator)
    const evidenceRef = read.nodes[0]?.evidenceRefs[0]
    expect(evidenceRef).toBeDefined()
    const evidence = await client.readArtifact(evidenceRef!) as OrchestrationExecutionEvidenceV1
    expect(evidence.output).toEqual([{ type: 'text', text: 'README.md:1: gouzi fixture\nFiles: README.md' }])
    expect(executions('gouzi-a').at(-1)?.[1]).toContain(supervisor.homeOf('gouzi-a'))
    expect(commandIds('gouzi-b')).toEqual(otherBefore)
    const inputLines = readFileSync(join(supervisor.homeOf('gouzi-a'), 'fixture-inputs.jsonl'), 'utf8').trim().split('\n')
    const input = inputLines.map(line => JSON.parse(line) as {
      commandId: string; workspace: string; systemPrompt: string; prompt: Array<{ type: string; text?: string }>
    }).find(value => value.commandId === evidence.executionId)
    expect(input).toBeDefined()
    const marker = 'Remote execution workspace:\n'
    const binding = JSON.parse(input!.systemPrompt.slice(input!.systemPrompt.lastIndexOf(marker) + marker.length).split('\n')[0]!) as {
      cwd: string; kind: string; projectId: string
    }
    expect(binding).toEqual({
      cwd: realpathSync(selectedProject), kind: 'gouzi-project',
      projectId: createHash('sha256').update(realpathSync(selectedProject)).digest('hex'),
    })
    const task = input!.prompt.map(block => block.text ?? '').join('\n')
    expect(task).toContain(`Sender workspace: ${realpathSync(workspace)}`)
    expect(task).toContain('Use the executor current working directory for filesystem operations.')
    const nativeDb = new DatabaseSync(join(supervisor.homeOf('gouzi-a'), 'resident-operators', 'state.sqlite'), { readOnly: true })
    let recorded: { workspace: string; prompt: unknown; systemPrompt: string }
    try {
      const events = nativeDb.prepare("SELECT data_json FROM resident_events WHERE type = 'turn.accepted'").all() as Array<{ data_json: string }>
      const data = events.map(row => JSON.parse(row.data_json) as {
        commandId: string; inputSnapshot: { workspace: string; prompt: unknown; systemPrompt: string }
      }).find(value => value.commandId === input!.commandId)
      expect(data).toBeDefined()
      recorded = data!.inputSnapshot
      expect(recorded).toMatchObject({ workspace: input!.workspace, prompt: input!.prompt, systemPrompt: input!.systemPrompt })
    } finally {
      nativeDb.close()
    }
    // This public transcript projects host-relative facts from the actual native request and private receipt.
    // Absolute scratch paths and generated run identities are checked above, rather than rewritten for replay.
    const transcript = {
      sender: 'TaskGraph sender workspace', receiver: 'member selected directory',
      registeredProjectMatchesBinding: binding.projectId === createHash('sha256').update(realpathSync(selectedProject)).digest('hex'),
      nativeCwdMatchesBinding: input!.workspace === binding.cwd,
      privateInputMatchesDriver: recorded!.systemPrompt === input!.systemPrompt,
      originalInputContextRetained: task.includes(`Sender workspace: ${realpathSync(workspace)}`),
      output: evidence.output,
    }
    await expect(`${JSON.stringify(transcript, null, 2)}\n`).toMatchFileSnapshot('./snapshots/remote-workspace-readme.json')
  }, 240_000)

  it('adopts a member through the Host route with a real worker process, runs a TaskGraph on it, and retires it', async () => {
    const mainRoot = join(mainHome, 'orchestrations')
    const hostContext = new Context()
    adoptedRoot = join(scratch, 'adopted')
    const inner = new LocalGouziHost(hostContext, HostConfig({
      membersRoot: adoptedRoot,
      ownerId: 'owner-e2e',
      activeLimit: 2,
      readyTimeoutMs: 120_000,
      stopTimeoutMs: 20_000,
      gitTimeoutMs: 10_000,
      hostsRoot: join(scratch, 'hosts'),
      ssh: SYSTEM_SSH,
      workerScript: join(PACKAGE_ROOT, 'src', 'gouzi-worker-bin.ts'),
      nodeArgs: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href],
    }))
    adoptedHost = inner
    const adoptionDriver = join(scratch, 'adoption-driver.mjs')
    writeFileSync(adoptionDriver, [
      `import { createResidentProductDriver as fixture } from ${JSON.stringify(pathToFileURL(FIXTURE_DRIVER).href)}`,
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      'export function createResidentProductDriver(options) {',
      '  const driver = fixture(options)',
      '  return { ...driver, async execute(request) {',
      "    const path = join(request.workspace, 'README.md')",
      "    const original = existsSync(path) ? readFileSync(path, 'utf8') : '<empty directory>'",
      '    const result = await driver.execute(request)',
      "    writeFileSync(join(request.workspace, 'adoption-result.txt'), original)",
      "    return { ...result, output: [{ type: 'text', text: original }] }",
      '  } }',
      '}', '',
    ].join('\n'))
    // The external Resident fixture reads and writes the cwd the real member passes to it.
    let prepareCalls = 0
    let provisionCalls = 0
    let startCalls = 0
    const provisioned: GouziProvisionInput[] = []
    class FixtureHost extends GouziHostService {
      readonly ownerId = inner.ownerId
      hosts() { return inner.hosts() }
      inspectHost(target: GouziSshTarget) { return inner.inspectHost(target) }
      addHost(input: Parameters<GouziHostService['addHost']>[0]) { return inner.addHost(input) }
      removeHost(hostId: string) { return inner.removeHost(hostId) }
      browse(hostId: string, path?: string) { return inner.browse(hostId, path) }
      resolveRepository(hostId: string, path: string) { return inner.resolveRepository(hostId, path) }
      prepareRepository(hostId: string, path: string) { prepareCalls += 1; return inner.prepareRepository(hostId, path) }
      async provision(input: GouziProvisionInput) {
        provisionCalls += 1
        provisioned.push(input)
        adoptedMemberIds.add(input.gouziId)
        await inner.provision(input)
        writeFileSync(join(adoptedRoot, input.gouziId, 'cordis.patch.yml'), [
          '- id: resident-operators', '  config:', '    driverModules:', `      - ${adoptionDriver}`, '',
        ].join('\n'))
      }
      start(hostId: string, gouziId: string) { startCalls += 1; return inner.start(hostId, gouziId) }
      stop(hostId: string, gouziId: string, options?: { reclaimResident?: boolean }) { return inner.stop(hostId, gouziId, options) }
    }

    const ctx = new Context()
    const routes: Array<{ handler: (request: never, response: never) => Promise<void> }> = []
    ctx.provide('webServer', { register: (route: (typeof routes)[number]) => { routes.push(route); return () => {} } } as never)
    new FixtureHost(ctx)
    await ctx.plugin(SessionStore).await()
    await ctx.plugin({ name: OrchestrationLocal.name, apply: OrchestrationLocal.apply }, OrchestrationLocal.Config({
      dshHome: mainHome, autoStart: false, headlessNodeExecutable: process.execPath,
    })).await()
    await ctx.plugin({ name: UiGouzi.name, inject: [...UiGouzi.inject], apply: UiGouzi.apply }, UiGouzi.Config({ grantDeadlineMs: 600_000 })).await()

    const send = async (method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; body: any }> => {
      const { PassThrough } = await import('node:stream')
      const request = new PassThrough()
      Object.assign(request, {
        url: UiGouzi.GOUZI_DASHBOARD_PATH, method, socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:3080', [UiGouzi.GOUZI_CONTROL_HEADER]: '1' },
      })
      request.end(body === undefined ? undefined : JSON.stringify(body))
      const chunks: Buffer[] = []
      let status = 200
      const response = {
        statusCode: 200, setHeader: () => {}, writeHead: (value: number) => { status = value },
        end(value?: Uint8Array) { if (value !== undefined) chunks.push(Buffer.from(value)); status = status === 200 ? this.statusCode : status },
      }
      await routes[0]!.handler(request as never, response as never)
      return { status, body: JSON.parse(Buffer.concat(chunks).toString()) as never }
    }

    const ordinary = join(scratch, 'ordinary-project')
    const empty = join(scratch, 'empty-project')
    const unborn = join(scratch, 'unborn-project')
    const noOrigin = join(scratch, 'git-without-origin')
    const dirty = join(scratch, 'dirty-project')
    const subdirectory = join(dirty, 'nested-project')
    for (const directory of [ordinary, empty, unborn, noOrigin, subdirectory]) mkdirSync(directory, { recursive: true })
    for (const directory of [ordinary, unborn, noOrigin, subdirectory]) writeFileSync(join(directory, 'README.md'), `original ${directory.split('/').at(-1)}\n`)
    git(unborn, 'init', '--initial-branch=main')
    for (const directory of [noOrigin, dirty]) {
      git(directory, 'init', '--initial-branch=main')
      git(directory, 'config', 'user.name', 'DSH Test')
      git(directory, 'config', 'user.email', 'dsh-test@example.invalid')
      git(directory, 'add', '.')
      git(directory, 'commit', '-m', 'original fixture')
    }
    writeFileSync(join(subdirectory, 'README.md'), 'dirty original file must be read in place\n')
    writeFileSync(join(subdirectory, 'untracked.txt'), 'untracked original file\n')
    const dirtyHead = git(dirty, 'rev-parse', 'HEAD')
    const dirtyStatus = git(dirty, 'status', '--porcelain')
    const noOriginHead = git(noOrigin, 'rev-parse', 'HEAD')
    const missing = join(scratch, 'missing-project')
    const file = join(scratch, 'project-file.txt')
    writeFileSync(file, 'not a directory\n')
    const valid = [
      { label: 'ordinary-nonempty', path: ordinary }, { label: 'ordinary-empty', path: empty },
      { label: 'git-unborn', path: unborn }, { label: 'git-without-origin', path: noOrigin },
      { label: 'dirty-repository-subdirectory', path: subdirectory },
    ]
    const candidates = [...valid.map(value => ({ ...value, usable: true })),
      { label: 'missing-directory', path: missing, usable: false }, { label: 'regular-file', path: file, usable: false }]
    const beforeFiles = valid.map(candidate => projectFiles(candidate.path))
    const readRegistry = () => {
      const store = new OrchestrationStore(mainRoot)
      try { return { hosts: store.gouzi.listHosts(), members: store.gouzi.list() } }
      finally { store.close() }
    }
    const registryBefore = readRegistry()
    const rosterBefore = await send('GET')
    const checked = await send('POST', { action: 'check-projects', hostId: 'local', projects: candidates.map(candidate => candidate.path) })
    expect(checked.status, JSON.stringify(checked.body)).toBe(200)
    const outcomes = checked.body.projects as Array<{ path: string; usable: boolean; message?: string }>
    expect(outcomes).toHaveLength(candidates.length)
    for (const [index, candidate] of candidates.entries()) {
      expect(outcomes[index]).toMatchObject({ path: candidate.path, usable: candidate.usable })
      if (!candidate.usable) expect(outcomes[index]!.message).toEqual(expect.any(String))
    }
    const unchanged = async () => {
      expect(readRegistry()).toEqual(registryBefore)
      expect(valid.map(candidate => projectFiles(candidate.path))).toEqual(beforeFiles)
      expect(existsSync(join(ordinary, '.git'))).toBe(false)
      expect(existsSync(join(empty, '.git'))).toBe(false)
      expect(prepareCalls).toBe(0)
      expect(provisionCalls).toBe(0)
      expect(startCalls).toBe(0)
      const roster = await send('GET')
      expect(roster.body.used).toBe(rosterBefore.body.used)
      expect(roster.body.members.map((value: { gouziId: string }) => value.gouziId)).toEqual(rosterBefore.body.members.map((value: { gouziId: string }) => value.gouziId))
      expect(existsSync(adoptedRoot)).toBe(false)
    }
    await unchanged()
    const readOnlyCheck = {
      projectsUnchanged: JSON.stringify(valid.map(candidate => projectFiles(candidate.path))) === JSON.stringify(beforeFiles),
      ordinaryGitCreated: existsSync(join(ordinary, '.git')),
      membersUnchanged: JSON.stringify(readRegistry().members) === JSON.stringify(registryBefore.members),
      prepareCalls, provisionCalls, startCalls,
    }
    const rejected: Array<{ fixture: string; error: string }> = []
    // Validate every selected path before initializing even the first valid project.
    for (const candidate of candidates.filter(value => !value.usable)) {
      const reply = await send('POST', { action: 'adopt', hostId: 'local', name: candidate.label, avatarId: 'corgi', role: 'development', projects: [ordinary, candidate.path] })
      expect(reply.status).toBeGreaterThanOrEqual(400)
      expect(reply.status).toBeLessThan(500)
      expect(reply.body).toMatchObject({ error: 'GOUZI_PROJECT_UNAVAILABLE', message: expect.any(String) })
      rejected.push({ fixture: candidate.label, error: reply.body.error as string })
      await unchanged()
    }
    expect(readFileSync(file, 'utf8')).toBe('not a directory\n')
    expect(existsSync(missing)).toBe(false)
    const client = new OrchestrationDaemonClient({ root: mainRoot, dshHome: mainHome, autoStart: false, connectTimeoutMs: 5_000 })
    const adoptedProjects: Array<{
      fixture: string; selectedDefaultPreserved: boolean; workerStarted: boolean; taskGraphState: string;
      nativeCwdMatchesSelected: boolean; originalRead: boolean; resultInSelectedDirectory: boolean; retired: boolean; slotReleased: boolean
    }> = []
    for (const [index, candidate] of valid.entries()) {
      const selected = index === 0 ? [candidate.path, empty] : [candidate.path]
      const original = existsSync(join(candidate.path, 'README.md')) ? readFileSync(join(candidate.path, 'README.md'), 'utf8') : '<empty directory>'
      const adopted = await send('POST', { action: 'adopt', name: candidate.label, avatarId: 'corgi', role: 'development', projects: selected })
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200)
      const gouziId = adopted.body.gouziId as string
      expect(adopted.body).toMatchObject({ membership: 'enabled', avatarId: 'corgi' })
      expect(adoptedMemberRuns(gouziId)).toBe(true)
      const workerStarted = adoptedMemberRuns(gouziId)
      expect(gouziId).toMatch(/^gouzi-[0-9a-f-]{36}$/u)
      expect(provisionCalls).toBe(index + 1)
      expect(startCalls).toBe(index + 1)
      const input = provisioned[index]!
      expect(input.projects.map(project => project.source)).toEqual(selected.map(path => realpathSync(path)))
      expect(input.defaultProjectId).toBe(input.projects[0]!.projectId)
      expect(input.projects[0]!.repository).toBeUndefined()
      const home = join(adoptedRoot, gouziId)
      const persisted = JSON.parse(readFileSync(join(home, 'orchestrations', 'cluster.json'), 'utf8')) as {
        members: Array<{ remoteExecution: { projects: GouziProvisionInput['projects']; defaultProjectId: string } }>
      }
      expect(persisted.members[0]!.remoteExecution).toMatchObject({ projects: input.projects, defaultProjectId: input.defaultProjectId })
      const roster = await eventually(() => send('GET'), reply => reply.body.members.some((value: { gouziId: string; state: string }) => value.gouziId === gouziId && value.state === 'resting'), 60_000)
      expect(roster.body.used).toBe(rosterBefore.body.used + 1)
      if (index === 0) {
        expect(existsSync(join(ordinary, '.git'))).toBe(true)
        expect(existsSync(join(empty, '.git'))).toBe(true)
      }
      expect(git(candidate.path, 'remote')).toBe('')
      if ([ordinary, empty, unborn].includes(candidate.path)) expect(() => git(candidate.path, 'rev-parse', '--verify', 'HEAD')).toThrow()
      if (candidate.path === noOrigin) expect(git(noOrigin, 'rev-parse', 'HEAD')).toBe(noOriginHead)
      if (candidate.path === subdirectory) {
        expect(existsSync(join(subdirectory, '.git'))).toBe(false)
        expect(git(dirty, 'rev-parse', 'HEAD')).toBe(dirtyHead)
        expect(git(dirty, 'status', '--porcelain')).toBe(dirtyStatus)
      }
      // An unrelated sender cwd cannot replace this member's persisted default project.
      const compilation = await client.compile({
        intent: { request: 'Read the original file and write its result in the adopted directory.' },
        admission: { policy: 'auto', route: 'taskgraph', sourceSessionId: `e2e-adopted-${index}`, rlm: 'disabled', continualHarness: 'off', optimization: 'economy' },
        graph: analysisGraph(join(scratch, 'source'), `gouzi.${gouziId}.${OPERATOR}`),
      })
      const started = await client.start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId })
      const finished = await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed' || value.state === 'failed', 120_000)
      expect(finished.state, JSON.stringify(finished)).toBe('completed')
      expect(finished.nodes[0]?.operatorId).toBe(`gouzi.${gouziId}.${OPERATOR}`)
      const evidenceRef = finished.nodes[0]?.evidenceRefs[0]
      expect(evidenceRef).toBeDefined()
      const evidence = await client.readArtifact(evidenceRef!) as OrchestrationExecutionEvidenceV1
      expect(evidence.output).toEqual([{ type: 'text', text: original }])
      const log = readFileSync(join(home, 'fixture-executions.log'), 'utf8').trim().split('\n')
      expect(log).toHaveLength(1)
      expect(log[0]!.split('\t')).toEqual([evidence.executionId, realpathSync(candidate.path)])
      expect(readFileSync(join(candidate.path, 'adoption-result.txt'), 'utf8')).toBe(original)
      if (original !== '<empty directory>') expect(readFileSync(join(candidate.path, 'README.md'), 'utf8')).toBe(original)
      expect(existsSync(join(scratch, 'source', 'adoption-result.txt'))).toBe(false)
      const received = JSON.parse(readFileSync(join(home, 'fixture-inputs.jsonl'), 'utf8').trim()) as { workspace: string }
      expect(received.workspace).toBe(realpathSync(candidate.path))
      const nativeDb = new DatabaseSync(join(home, 'resident-operators', 'state.sqlite'), { readOnly: true })
      try {
        const rows = nativeDb.prepare("SELECT data_json FROM resident_events WHERE type = 'turn.accepted'").all() as Array<{ data_json: string }>
        expect(rows).toHaveLength(1)
        expect(JSON.parse(rows[0]!.data_json)).toMatchObject({ inputSnapshot: { workspace: realpathSync(candidate.path) } })
      } finally { nativeDb.close() }
      expect(residentDaemonPid(home)).toBeDefined()
      const retired = await send('POST', { action: 'retire', gouziId })
      expect(retired.status, JSON.stringify(retired.body)).toBe(200)
      expect(adoptedMemberRuns(gouziId)).toBe(false)
      expect(residentDaemonPid(home)).toBeUndefined()
      const after = await send('GET')
      expect(after.body.used).toBe(rosterBefore.body.used)
      expect(after.body.members.map((value: { gouziId: string }) => value.gouziId)).not.toContain(gouziId)
      expect(existsSync(candidate.path)).toBe(true)
      expect(readFileSync(join(candidate.path, 'adoption-result.txt'), 'utf8')).toBe(original)
      adoptedProjects.push({
        fixture: candidate.label, selectedDefaultPreserved: input.defaultProjectId === input.projects[0]!.projectId,
        workerStarted, taskGraphState: finished.state, nativeCwdMatchesSelected: received.workspace === realpathSync(candidate.path),
        originalRead: evidence.output.length === 1 && evidence.output[0]?.type === 'text' && evidence.output[0].text === original,
        resultInSelectedDirectory: readFileSync(join(candidate.path, 'adoption-result.txt'), 'utf8') === original,
        retired: !adoptedMemberRuns(gouziId), slotReleased: after.body.used === rosterBefore.body.used,
      })
    }
    expect(git(noOrigin, 'rev-parse', 'HEAD')).toBe(noOriginHead)
    expect(git(dirty, 'rev-parse', 'HEAD')).toBe(dirtyHead)
    expect(readFileSync(join(subdirectory, 'untracked.txt'), 'utf8')).toBe('untracked original file\n')
    const transcript = {
      candidates: candidates.map((candidate, index) => ({ fixture: candidate.label, usable: outcomes[index]!.usable })),
      readOnlyCheck, rejected, adoptedProjects,
    }
    await expect(`${JSON.stringify(transcript, null, 2)}\n`).toMatchFileSnapshot('./snapshots/local-gouzi-project-validation.json')
    await ctx.fiber.dispose()
  }, 600_000)
})
