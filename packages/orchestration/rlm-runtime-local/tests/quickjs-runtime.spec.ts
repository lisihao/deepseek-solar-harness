import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RlmCommandId, RlmRuntimeSessionId, type RlmChildSpawnPolicyV1, type RlmRuntimeHostBindings } from '@deepseek-ai/dsh-rlm-runtime'
import { expect, it } from 'vitest'
import { LocalRlmRuntime, type Config } from '../src/index.ts'

it.each(['none', 'root-only', 'recursive'] as const)('applies %s at the actual QuickJS Host entry and keeps the cumulative cap', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quickjs-policy-'))
  const config: Config = { root, kernel: { kind: 'quickjs-wasm', memoryLimitBytes: 33554432, maxStackBytes: 262144,
    maxInterruptChecks: 10000, maxBridgeBytes: 1048576, maxLogBytes: 8192, maxCellSourceBytes: 65536,
    maxHostCalls: 16, maxPendingHostCalls: 4, jobBatchSize: 8 } }
  const ctx = new Context()
  const service = new LocalRlmRuntime(ctx, config)
  const dispatches: string[] = []
  const bindings: RlmRuntimeHostBindings = { dispatchChild: async (request) => {
    dispatches.push(String(request.commandId))
    await service.bindHost(request.childSessionId, bindings)
    return { nativeSessionId: String(request.childSessionId), nativeTurnId: String(request.commandId),
      result: Promise.resolve({ status: 'settled', stopReason: 'completed', output: [{ type: 'text', text: 'synthetic' }] }),
      interrupt: () => Promise.resolve() }
  } }
  const sessionId = RlmRuntimeSessionId('quickjs-root')
  const childSpawnPolicy: RlmChildSpawnPolicyV1 = { version: 1, mode, maxTotalChildren: mode === 'none' ? 0 : 2 }
  try {
    await service.create({ sessionId, commandId: RlmCommandId('create'), executionId: 'fake-policy', workspace: root,
      task: 'synthetic only', model: { operatorId: 'fixture-only', model: 'scripted-fake' }, context: {}, childSpawnPolicy,
      limits: { maxDepth: 2, maxChildren: 2, maxTurns: 8, maxCellMs: 5000, maxOutputBytes: 8192 } }, bindings)
    const call = (id: typeof sessionId, command: string) => service.executeCell({ sessionId: id, commandId: RlmCommandId(command), code: 'await rlm("synthetic child")' })
    if (mode === 'none') {
      await expect(call(sessionId, 'none')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
      expect(dispatches).toHaveLength(0)
    } else {
      await call(sessionId, 'root-child')
      const child = (await service.listChildren(sessionId))[0]!
      if (mode === 'root-only') {
        await expect(call(child.sessionId, 'denied-grandchild')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
        expect(dispatches).toHaveLength(1)
      } else {
        await call(child.sessionId, 'allowed-grandchild')
        await expect(call(sessionId, 'denied-third')).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
        expect(dispatches).toHaveLength(2)
      }
    }
  } finally { await ctx.root.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
