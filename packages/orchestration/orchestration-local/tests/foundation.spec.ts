import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CapabilityCapsuleRef } from '@deepseek-ai/dsh-capability-capsule'
import { OrchestrationError, type LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import { canonicalSha256 } from '../src/canonical.ts'
import { graphCertificate, nodesConflict, validateGraph } from '../src/graph.ts'
import { GitWorktreeManager } from '../src/git-worktrees.ts'
import { BasicContextCompiler, DirectIntentCompiler, LocalCapabilityCapsuleService } from '../src/providers.ts'
import { OrchestrationStore } from '../src/store.ts'

const roots: string[] = []
const run = promisify(execFile)
afterEach(async () => {
  for (const root of roots.splice(0)) await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
})

async function temporary(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-orchestration-'))
  roots.push(value)
  return value
}

function graph(workspace: string): LogicalTaskGraphV1 {
  const effects = { read: [], write: [], execute: [], network: [], cost: [], risk: [] }
  return {
    version: 1,
    title: 'foundation graph',
    workspace,
    maxParallel: 2,
    risk: 'low',
    nodes: [{
      id: 'A', dependsOn: [], requiredForCompletion: true, title: 'A', task: 'do A', role: 'implementation',
      capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'degrade' },
      effectBudget: effects, readScopes: ['src'], writeScopes: ['src/a'], approvedSecretRefs: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
    }, {
      id: 'B', dependsOn: ['A'], requiredForCompletion: true, title: 'B', task: 'do B', role: 'review',
      capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'degrade' },
      effectBudget: effects, readScopes: ['src/a'], writeScopes: ['src/b'], approvedSecretRefs: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
    }],
  }
}

describe('immutable compilation foundations', () => {
  it('produces repeatable Intent and Context hashes with lineage and degradation', async () => {
    const ctx = new Context()
    await ctx.plugin(DirectIntentCompiler)
    await ctx.plugin(BasicContextCompiler)
    const request = { request: 'Implement the verified graph.', sourceRefs: ['source:b', 'source:a'] }
    const first = await ctx.intentCompiler.compile(request)
    const second = await ctx.intentCompiler.compile(structuredClone(request))
    expect(first.provenance).toEqual(second.provenance)
    expect(first.sourceRefs).toEqual(['source:a', 'source:b'])
    const packet = await ctx.contextCompiler.compile({
      runId: 'run', nodeId: 'A', objective: first.objective, workspace: '/tmp', task: 'use TOKEN=secret-value safely',
      sourceRefs: [
        { ref: 'sha256:upstream', kind: 'artifact', required: true },
        { ref: 'unavailable:knowledge', kind: 'knowledge', required: false },
      ],
      sourceMaterials: [{ ref: 'sha256:upstream', text: 'TOKEN=upstream-secret', truncated: false }],
      readScopes: [], writeScopes: [], acceptance: [], capsuleInstructions: [],
      policy: { maxTokens: 2_048, allowedSourceKinds: ['artifact', 'knowledge'], unavailableSource: 'degrade' },
    })
    expect(packet.lineage).toEqual(['sha256:upstream'])
    expect(packet.degradedSources).toEqual(['unavailable:knowledge'])
    expect(packet.task).toContain('[REDACTED]')
    expect(packet.sourceMaterials[0]?.text).toContain('[REDACTED]')
    expect(packet.redactions).toContain('source:sha256:upstream')
    expect(packet.packetSha256).toBe(canonicalSha256({ ...packet, packetSha256: undefined }))
    await ctx.root.fiber.dispose()
  })

  it('validates DAGs and rejects cycles while detecting hierarchical write conflicts', async () => {
    const workspace = await temporary()
    const valid = graph(workspace)
    expect(validateGraph(valid)).toEqual(['A', 'B'])
    expect(graphCertificate(valid).certificateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(nodesConflict(valid.nodes[0]!, { ...valid.nodes[1]!, readScopes: [], writeScopes: ['src/a/nested'] })).toBe(true)
    const cyclic = { ...valid, nodes: valid.nodes.map(node => node.id === 'A' ? { ...node, dependsOn: ['B'] } : node) }
    expect(() => validateGraph(cyclic)).toThrow(expect.objectContaining<Partial<OrchestrationError>>({ code: 'GRAPH_CYCLE' }))
  })

  it('requires a completion-critical downstream verifier for strict mutating graphs', async () => {
    const workspace = await temporary()
    const fixture = graph(workspace)
    const strict: LogicalTaskGraphV1 = {
      ...fixture,
      qualityPolicy: { independentVerification: 'required' },
      nodes: fixture.nodes.map(node => node.id === 'B'
        ? { ...node, phase: 'verification' as const, writeScopes: [] }
        : node),
    }
    expect(validateGraph(strict)).toEqual(['A', 'B'])
    expect(() => validateGraph({
      ...strict,
      nodes: strict.nodes.map(node => node.id === 'B' ? { ...node, phase: 'execution' as const } : node),
    })).toThrow(/verification node/)
  })

  it('isolates parallel workers in branches and integrates each branch idempotently', async () => {
    const root = await temporary()
    const repository = join(root, 'repository')
    await mkdir(repository)
    await run('git', ['-C', repository, 'init', '-b', 'main'])
    await writeFile(join(repository, 'README.md'), 'base\n')
    await run('git', ['-C', repository, 'add', 'README.md'])
    await run('git', [
      '-C', repository,
      '-c', 'user.name=DSH Test',
      '-c', 'user.email=dsh-test@local',
      'commit', '-m', 'base',
    ])
    const baseSha = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim()
    const manager = new GitWorktreeManager(join(root, 'worktrees'))
    await manager.verifyRepository(repository, baseSha)
    const [first, second] = await Promise.all([
      manager.prepare(repository, 'run-fixture', 'first', 1),
      manager.prepare(repository, 'run-fixture', 'second', 1),
    ])
    expect(first.path).not.toBe(second.path)
    expect(first.branch).not.toBe(second.branch)
    await Promise.all([
      writeFile(join(first.path, 'first.txt'), 'first\n'),
      writeFile(join(second.path, 'second.txt'), 'second\n'),
    ])
    const [firstIntegration, secondIntegration] = await Promise.all([
      manager.integrate(repository, first, 'fixture:first:1'),
      manager.integrate(repository, second, 'fixture:second:1'),
    ])
    expect(firstIntegration?.commits).toHaveLength(1)
    expect(secondIntegration?.commits).toHaveLength(1)
    await expect(readFile(join(repository, 'first.txt'), 'utf8')).resolves.toMatch(/^first\r?\n$/u)
    await expect(readFile(join(repository, 'second.txt'), 'utf8')).resolves.toMatch(/^second\r?\n$/u)
    const head = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim()
    await expect(manager.integrate(repository, first, 'fixture:first:1')).resolves.toMatchObject({ integratedHead: head })
    expect((await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(head)
  }, 30_000)

  it('fails closed when a capsule expands network authority', async () => {
    const root = await temporary()
    const capsuleRoot = join(root, 'capsules')
    await mkdir(capsuleRoot)
    const manifest = {
      version: 1 as const,
      id: 'network-reader', capsuleVersion: '1.0.0', kind: 'instruction' as const, digest: '',
      provenance: { publisher: 'test', sourceRef: 'fixture' },
      applicability: ['test'], capabilityTags: ['read.web'], inputs: [], outputs: [], preconditions: [], postconditions: [], invariants: [],
      consumes: [], produces: [], requires: [], compatible: [], incompatible: [],
      effects: { read: [], write: [], execute: [], network: ['internet'], cost: [], risk: [] },
      bindings: { instructions: ['Read it.'], skills: [], toolsAllow: [], toolsDeny: [], mcpServers: [], resourceRefs: [], dataRefs: [], secretRefs: [], guardRefs: [] },
      verification: [], operatorCompatibility: ['codex'],
    }
    const sealed = { ...manifest, digest: canonicalSha256(manifest) }
    await writeFile(join(capsuleRoot, 'network.json'), JSON.stringify(sealed))
    const ctx = new Context()
    await ctx.plugin(class extends LocalCapabilityCapsuleService {
      constructor(value: Context) { super(value, capsuleRoot) }
    })
    const snapshot = await ctx.capabilityCapsules.snapshot({})
    expect(snapshot.refs.some(ref => String(ref).startsWith('network-reader@'))).toBe(true)
    const networkRef = snapshot.refs.find(ref => String(ref).startsWith('network-reader@'))
    expect(networkRef).toBeDefined()
    await expect(ctx.capabilityCapsules.get(CapabilityCapsuleRef(String(networkRef)))).resolves.toMatchObject({ id: 'network-reader' })
    const plan = await ctx.capabilityCapsules.resolve({
      runId: 'run', nodeId: 'A', attempt: 1, generation: 1,
      requirements: [{ capability: 'read.web', required: true }], capabilityBudget: ['read.web'],
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      readScopes: [], writeScopes: [], approvedSecretRefs: [], operatorInjectionKinds: ['instruction'],
    })
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_AUTHORITY_EXCEEDED' }))
    await ctx.root.fiber.dispose()
  })

  it('stores content-addressed artifacts and forward-only entity tables', async () => {
    const root = await temporary()
    const store = new OrchestrationStore(root)
    const first = store.putArtifact({ b: 2, a: 1 })
    const second = store.putArtifact({ a: 1, b: 2 })
    expect(first).toBe(second)
    expect(store.readArtifact(first)).toEqual({ a: 1, b: 2 })
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(value => value.name)
    expect(tables).toEqual(expect.arrayContaining([
      'runs', 'attempts', 'orchestration_events', 'compilation_artifacts', 'capability_bindings',
      'context_packets', 'node_execution_plans', 'capability_updates', 'command_receipts',
      'autonomous_states', 'cluster_election',
    ]))
    store.close()
  }, 30_000)

  it('adds durable command receipts when opening a schema-one store', async () => {
    const root = await temporary()
    const database = new DatabaseSync(join(root, 'state.sqlite'))
    database.exec('PRAGMA user_version = 1;')
    database.close()

    const store = new OrchestrationStore(root)
    expect(Number(store.db.prepare('PRAGMA user_version').get()?.user_version)).toBe(4)
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_receipts'").get())
      .toBeDefined()
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'autonomous_states'").get())
      .toBeDefined()
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cluster_election'").get())
      .toBeDefined()
    store.close()
  })

  it('requires explicit execute authority for Autonomous shell gates', async () => {
    const root = await temporary()
    const fixture = graph(root)
    const node = fixture.nodes[0]!
    expect(() => validateGraph({
      ...fixture,
      nodes: [{
        ...node,
        rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 1, maxTurns: 2 },
        autonomous: { mode: 'enabled', gates: { commands: ['pnpm test'] } },
      }],
    })).toThrow('autonomous-gate execute effect')
    expect(validateGraph({
      ...fixture,
      nodes: [{
        ...node,
        effectBudget: { ...node.effectBudget, execute: ['autonomous-gate'] },
        rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 1, maxTurns: 2 },
        autonomous: { mode: 'enabled', gates: { commands: ['pnpm test'] } },
      }],
    })).toEqual(['A'])
  })

  it('strictly validates task-specific Autonomous end-condition references', async () => {
    const workspace = await temporary()
    const fixture = graph(workspace)
    const node = fixture.nodes[0]!
    const base = {
      ...node,
      rlm: { mode: 'enabled' as const, maxDepth: 1, maxChildren: 1, maxTurns: 2 },
      autonomous: {
        mode: 'enabled' as const,
        endCondition: {
          version: 1 as const,
          operator: 'all' as const,
          checks: [{ id: 'done-check', kind: 'acceptance' as const, ref: 'done' }],
        },
      },
    }
    expect(validateGraph({ ...fixture, nodes: [base] })).toEqual(['A'])
    expect(() => validateGraph({
      ...fixture,
      nodes: [{
        ...base,
        autonomous: { ...base.autonomous, endCondition: { ...base.autonomous.endCondition, checks: [{ ...base.autonomous.endCondition.checks[0]!, ref: 'missing' }] } },
      }],
    })).toThrow(/does not name a node acceptance requirement/u)
    expect(() => validateGraph({
      ...fixture,
      nodes: [{
        ...base,
        autonomous: { ...base.autonomous, endCondition: { ...base.autonomous.endCondition, checks: [
          ...base.autonomous.endCondition.checks,
          { id: 'done-check', kind: 'evaluator' as const, ref: 'review' },
        ] } },
      }],
    })).toThrow(/duplicated/u)
  })
})
