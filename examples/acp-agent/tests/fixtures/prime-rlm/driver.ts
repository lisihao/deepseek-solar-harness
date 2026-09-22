#!/usr/bin/env node
/** Emit a keyless RLM transcript through the production app boot and YAML Loader. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import {
  RLM_TYPESCRIPT_REPL_TOOL_SCHEMA,
  RlmCommandId,
  RlmRuntimeSessionId,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'

const configPath = process.argv[2]
if (configPath === undefined || process.env.DSH_HOME === undefined) {
  throw new Error('prime-rlm fixture requires a config path and an isolated DSH_HOME')
}
const ctx = await boot('prime-rlm-keyless-example', resolveConfigPath(configPath, undefined))
try {
  const runtime = ctx.get('rlmRuntime')
  if (runtime === undefined) throw new Error('Loader did not mount rlmRuntime')
  const dispatches: Parameters<RlmRuntimeHostBindings['dispatchChild']>[0][] = []
  const skillBindings: NonNullable<Parameters<NonNullable<RlmRuntimeHostBindings['hostRequest']>>[0]['sealedSkill']>[] = []
  const bindings: RlmRuntimeHostBindings = {
    async dispatchChild(request) {
      dispatches.push(request)
      return {
        nativeSessionId: 'keyless-child-session',
        nativeTurnId: 'keyless-child-turn',
        result: Promise.resolve({ status: 'settled', output: [{ type: 'text', text: 'keyless child settled' }] }),
        interrupt: async () => {},
      }
    },
    async hostRequest(request) {
      if (request.method !== 'skills.call' || request.sealedSkill === undefined) {
        throw new Error(`unexpected RLM Host request: ${request.method}`)
      }
      skillBindings.push(request.sealedSkill)
      return {
        entryId: request.sealedSkill.entryId,
        entryVersion: request.sealedSkill.entryVersion,
        digest: request.sealedSkill.digest,
        result: 'sealed skill result',
      }
    },
  }
  const parent = {
    operatorId: 'codex',
    model: 'gpt-5.6-sol',
    profile: { model: 'gpt-5.6-sol', effort: 'high' as const },
  }
  const skill = {
    alias: 'summarize-evidence',
    title: 'Summarize evidence',
    callable: 'summarizeEvidence',
    available: true,
    binding: {
      entryId: 'summarize-evidence',
      entryVersion: 4,
      digest: 'sealed-entry-digest',
      moduleId: 'trusted-skill-provider',
      callable: 'summarizeEvidence',
    },
  }
  const sessionId = RlmRuntimeSessionId('prime-loader-root')
  await runtime.create({
    sessionId,
    commandId: RlmCommandId('prime-loader-create'),
    executionId: 'prime-loader-execution',
    workspace: process.cwd(),
    task: 'Produce one keyless strict RLM child.',
    model: parent,
    childModelPolicy: 'parent-inherit',
    limits: { maxDepth: 2, maxChildren: 2, maxTurns: 4, maxCellMs: 2_000, maxOutputBytes: 16 * 1024 },
    executionOptions: {
      version: 1,
      tools: [RLM_TYPESCRIPT_REPL_TOOL_SCHEMA],
      skills: [skill],
      retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['TIMEOUT'], initialDelayMs: 25, maxDelayMs: 25, jitterRatio: 0 },
      capabilityContext: { runtimeContextRef: 'snapshot:prime-loader' },
    },
  }, bindings)

  const cell = await runtime.executeCell({
    sessionId,
    commandId: RlmCommandId('prime-loader-cell'),
    code: [
      'const [child] = await Promise.all([rlm("prove inheritance", { name: "strict-child" })]);',
      'const skillsCatalog = await skills.list();',
      'const skillResult = await skills.call("summarize-evidence", { text: "bounded evidence" });',
      '({',
      '  child: { operatorId: child.model.operatorId, model: child.model.model, profile: child.model.profile, modelOrigin: child.modelOrigin },',
      '  skillsCatalog,',
      '  skillResult,',
      '})',
    ].join('\n'),
  })

  if (cell.value === undefined) throw new Error('RLM cell produced no output')
  process.stdout.write(`${JSON.stringify({
    output: cell.value,
    dispatches: dispatches.map(({ name, model, modelOrigin, executionOptions }) => ({
      name, model, modelOrigin, executionOptions,
    })),
    skillBindings,
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
