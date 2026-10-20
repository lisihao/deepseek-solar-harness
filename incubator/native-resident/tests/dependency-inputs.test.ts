import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { ResidentEngine } from '../src/core/engine.js'
import { ResidentError, type NativeDriver, type TaskGraph, type TaskNode } from '../src/contracts.js'

const engines: ResidentEngine[] = []
const temporaryDirectories: string[] = []
const dependencyInputStart = '--- BEGIN RESIDENT DEPENDENCY INPUTS (JSON) ---'
const dependencyInputEnd = '--- END RESIDENT DEPENDENCY INPUTS ---'

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((engine) => engine.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ResidentEngine dependency inputs', () => {
  it('passes complete named predecessor outputs to the dependent native request', async () => {
    const databasePath = await temporaryDatabasePath()
    const firstOutput = 'first output\nwith a newline'
    const secondOutput = 'second output'
    let dependentPrompt: string | undefined
    const engine = await openEngine(databasePath, {
      async execute(request) {
        if (request.prompt === 'first') return { output: firstOutput }
        if (request.prompt === 'second') return { output: secondOutput }
        dependentPrompt = request.prompt
        return { output: 'review complete' }
      },
    })

    await engine.submit({
      commandId: 'dependency-input-submit',
      graph: graph('dependency-input', [
        node('first', 'first'),
        node('second', 'second'),
        node('review', 'review original prompt', { dependsOn: ['first', 'second'], inputFrom: ['second', 'first'] }),
      ]),
    })

    await eventually(async () => expect((await engine.inspect('dependency-input')).status).toBe('completed'))
    expect(dependentPrompt).toBe(
      `review original prompt\n\n${dependencyInputStart}\n${JSON.stringify({
        formatVersion: 1,
        predecessors: [
          { nodeId: 'second', output: secondOutput },
          { nodeId: 'first', output: firstOutput },
        ],
      })}\n${dependencyInputEnd}`,
    )
  })

  it('does not add predecessor output when inputFrom is omitted', async () => {
    const databasePath = await temporaryDatabasePath()
    let dependentPrompt: string | undefined
    const engine = await openEngine(databasePath, {
      async execute(request) {
        if (request.prompt === 'source') return { output: 'source output' }
        dependentPrompt = request.prompt
        return { output: 'done' }
      },
    })

    await engine.submit({
      commandId: 'dependency-input-omitted-submit',
      graph: graph('dependency-input-omitted', [
        node('source', 'source'),
        node('target', 'target original prompt', { dependsOn: ['source'] }),
      ]),
    })

    await eventually(async () => expect((await engine.inspect('dependency-input-omitted')).status).toBe('completed'))
    expect(dependentPrompt).toBe('target original prompt')
  })

  it('rejects malformed, duplicate, and non-predecessor inputFrom values', async () => {
    const databasePath = await temporaryDatabasePath()
    const engine = await openEngine(databasePath, { async execute() { return { output: 'unexpected' } } })

    await expect(engine.submit({
      commandId: 'dependency-input-malformed',
      graph: {
        ...graph('dependency-input-malformed', [node('source', 'source')]),
        nodes: [
          node('source', 'source'),
          { ...node('target', 'target', { dependsOn: ['source'] }), inputFrom: 'source' },
        ],
      } as unknown as TaskGraph,
    })).rejects.toMatchObject({ code: 'GRAPH_INVALID' })

    await expect(engine.submit({
      commandId: 'dependency-input-duplicate',
      graph: graph('dependency-input-duplicate', [
        node('source', 'source'),
        node('target', 'target', { dependsOn: ['source'], inputFrom: ['source', 'source'] }),
      ]),
    })).rejects.toMatchObject({ code: 'GRAPH_INVALID' })

    await expect(engine.submit({
      commandId: 'dependency-input-non-predecessor',
      graph: graph('dependency-input-non-predecessor', [
        node('first', 'first'),
        node('second', 'second'),
        node('target', 'target', { dependsOn: ['second'], inputFrom: ['first'] }),
      ]),
    })).rejects.toMatchObject({ code: 'GRAPH_INVALID' })
  })

  it('fails a dependent node by name when complete predecessor input exceeds the existing prompt limit', async () => {
    const databasePath = await temporaryDatabasePath()
    const executedPrompts: string[] = []
    const engine = await openEngine(databasePath, {
      async execute(request) {
        executedPrompts.push(request.prompt)
        return { output: 'source output' }
      },
    })

    await engine.submit({
      commandId: 'dependency-input-limit',
      graph: graph('dependency-input-limit', [
        node('source', 'source'),
        node('target', 'x'.repeat(1_000_000), { dependsOn: ['source'], inputFrom: ['source'] }),
      ]),
    })

    await eventually(async () => expect((await engine.inspect('dependency-input-limit')).status).toBe('failed'))
    const snapshot = await engine.inspect('dependency-input-limit')
    expect(snapshot.nodes).toMatchObject([
      { id: 'source', status: 'succeeded' },
      { id: 'target', status: 'failed', error: { code: 'DEPENDENCY_INPUT_TOO_LARGE' } },
    ])
    expect(executedPrompts).toEqual(['source'])
  })

  it('persists rendered dependency input before an unknown native effect and does not replay it after restart', async () => {
    const databasePath = await temporaryDatabasePath()
    const sourceOutput = 'durable source output'
    const receivedPrompts: string[] = []
    const engine = await openEngine(databasePath, {
      async execute(request) {
        if (request.prompt === 'source') return { output: sourceOutput }
        receivedPrompts.push(request.prompt)
        throw new ResidentError('COMMAND_INDETERMINATE', 'native outcome is unknown')
      },
    })

    await engine.submit({
      commandId: 'dependency-input-unknown',
      graph: graph('dependency-input-unknown', [
        node('source', 'source'),
        node('target', 'target original prompt', {
          dependsOn: ['source'],
          inputFrom: ['source'],
          retry: { maxAttempts: 2, delayMs: 0, codes: ['COMMAND_INDETERMINATE'] },
        }),
      ]),
    })

    await eventually(async () => expect((await engine.inspect('dependency-input-unknown')).status).toBe('indeterminate'))
    const expectedPrompt = renderedPrompt('target original prompt', [{ nodeId: 'source', output: sourceOutput }])
    expect(receivedPrompts).toEqual([expectedPrompt])
    await engine.close()

    const database = new DatabaseSync(databasePath)
    const persisted = database.prepare(
      "SELECT node_json FROM nodes WHERE graph_id = 'dependency-input-unknown' AND node_id = 'target'",
    ).get() as { node_json: string } | undefined
    database.close()
    expect(JSON.parse(persisted?.node_json ?? '{}')).toMatchObject({ prompt: expectedPrompt })

    let replayCalls = 0
    const reopened = await openEngine(databasePath, {
      async execute() {
        replayCalls += 1
        return { output: 'must not replay' }
      },
    })
    expect((await reopened.inspect('dependency-input-unknown')).status).toBe('indeterminate')
    expect(replayCalls).toBe(0)
  })

  it('does not replay a crash-recovered dependency input automatically', async () => {
    const databasePath = await temporaryDatabasePath()
    const receivedPrompts: string[] = []
    const first = await openEngine(databasePath, {
      async execute(request) {
        if (request.prompt === 'source') return { output: 'source output' }
        receivedPrompts.push(request.prompt)
        return { output: 'target output' }
      },
    })

    await first.submit({
      commandId: 'dependency-input-crash',
      graph: graph('dependency-input-crash', [
        node('source', 'source'),
        node('target', 'target original prompt', { dependsOn: ['source'], inputFrom: ['source'] }),
      ]),
    })
    await eventually(async () => expect((await first.inspect('dependency-input-crash')).status).toBe('completed'))
    const expectedPrompt = renderedPrompt('target original prompt', [{ nodeId: 'source', output: 'source output' }])
    expect(receivedPrompts).toEqual([expectedPrompt])
    await first.close()

    const crashed = new DatabaseSync(databasePath)
    crashed.exec(`
      UPDATE graphs SET status = 'running', cancel_requested = 0 WHERE id = 'dependency-input-crash';
      UPDATE nodes
        SET status = 'running', output = NULL, error_code = NULL, error_message = NULL,
            wait_reason = NULL
        WHERE graph_id = 'dependency-input-crash' AND node_id = 'target';
      UPDATE attempts SET status = 'running', settled_at = NULL
        WHERE graph_id = 'dependency-input-crash' AND node_id = 'target' AND attempt = 1;
    `)
    crashed.close()

    let replayCalls = 0
    const reopened = await openEngine(databasePath, {
      async execute() {
        replayCalls += 1
        return { output: 'must not replay' }
      },
    })
    const snapshot = await reopened.inspect('dependency-input-crash')
    expect(snapshot.status).toBe('indeterminate')
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'target', status: 'indeterminate', attempt: 1 }),
    ]))
    expect(replayCalls).toBe(0)
  })
})

async function openEngine(databasePath: string, driver: NativeDriver): Promise<ResidentEngine> {
  const engine = new ResidentEngine(databasePath, { codex: driver }, { tickMs: 5 })
  engines.push(engine)
  await engine.open()
  return engine
}

function graph(id: string, nodes: readonly TaskNode[]): TaskGraph {
  return {
    formatVersion: 1,
    id,
    label: id,
    cwd: process.cwd(),
    maxParallel: 2,
    nodes,
  }
}

function node(id: string, prompt: string, extra: Partial<TaskNode> = {}): TaskNode {
  return { id, executor: 'codex', prompt, ...extra }
}

function renderedPrompt(prompt: string, predecessors: readonly { readonly nodeId: string; readonly output: string }[]): string {
  return `${prompt}\n\n${dependencyInputStart}\n${JSON.stringify({ formatVersion: 1, predecessors })}\n${dependencyInputEnd}`
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'native-resident-dependency-inputs-'))
  temporaryDirectories.push(directory)
  return join(directory, 'resident.sqlite')
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }
  throw lastError
}
