import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PersistentTypeScriptKernel,
  type KernelHooks,
} from '../src/kernel.ts'

function hooks(): KernelHooks {
  const notUsed = (): never => { throw new Error('host hook is not used') }
  return {
    spawn: notUsed,
    listChildren: notUsed,
    deleteChild: notUsed,
    sendMessage: notUsed,
    broadcastMessage: notUsed,
    listAgents: notUsed,
    readMessages: notUsed,
    harness: notUsed,
    skill: notUsed,
    setGoal: notUsed,
    getGoal: notUsed,
    completeGoal: notUsed,
    createHeartbeat: notUsed,
    listHeartbeats: notUsed,
    updateHeartbeat: notUsed,
    deleteHeartbeat: notUsed,
    compactStatus: notUsed,
    compactRun: notUsed,
  }
}

describe('PersistentTypeScriptKernel namespace snapshots', () => {
  it('recovers TypeScript declarations, imports, destructuring, and multi-bindings', async () => {
    const first = new PersistentTypeScriptKernel({}, hooks(), [])
    const snapshot = await first.execute([
      'import { basename as baseName, sep as pathSeparator } from "node:path";',
      'function add(left: number, right: number): number { return left + right }',
      'class Box { readonly value: number; constructor(value: number) { this.value = value } }',
      'const [firstValue, secondValue] = [2, 3], { answer: answerValue } = { answer: 40 };',
      'let leftValue = 4, rightValue = 5;',
      'const multiplier = 3, multiply = (value: number) => value * multiplier;',
      'void 0',
    ].join('\n'), 2_000)
    expect(snapshot.degradedVariables).toEqual([])
    expect(snapshot.variables.find(variable => variable.name === 'baseName')).toHaveProperty('source')
    expect(snapshot.variables.find(variable => variable.name === 'pathSeparator')).toHaveProperty('source')
    first.dispose()

    const recovered = new PersistentTypeScriptKernel({}, hooks(), snapshot.variables)
    await expect(recovered.execute([
      '({',
      '  path: baseName("/tmp/recovered.txt"),',
      '  pathSeparator,',
      '  sum: add(firstValue, secondValue) + leftValue + rightValue,',
      '  box: new Box(answerValue).value,',
      '  product: multiply(4),',
      '})',
    ].join('\n'), 2_000)).resolves.toMatchObject({
      value: { path: 'recovered.txt', pathSeparator: sep, sum: 14, box: 40, product: 12 },
    })
    recovered.dispose()
  })

  it('degrades a factory closure without discarding a current value snapshot', async () => {
    const first = new PersistentTypeScriptKernel({}, hooks(), [])
    const snapshot = await first.execute([
      'let stable = 40;',
      'const makeClosure = () => { let hidden = 0; return () => ++hidden };',
      'const privateClosure = makeClosure();',
      'function reassignedDeclaration() { return 1 }',
      'reassignedDeclaration = makeClosure();',
      'stable += 2;',
      'void 0',
    ].join('\n'), 2_000)
    expect(snapshot.variables.find(variable => variable.name === 'privateClosure')?.error).toBeTruthy()
    expect(snapshot.variables.find(variable => variable.name === 'reassignedDeclaration')?.error).toBeTruthy()
    first.dispose()

    const recovered = new PersistentTypeScriptKernel({}, hooks(), snapshot.variables)
    await expect(recovered.execute('({ stable, privateClosure: typeof privateClosure, reassignedDeclaration: typeof reassignedDeclaration })', 2_000))
      .resolves.toMatchObject({
        value: { stable: 42, privateClosure: 'undefined', reassignedDeclaration: 'undefined' },
      })
    recovered.dispose()
  })

  it('degrades one over-cap variable without discarding another variable', async () => {
    const first = new PersistentTypeScriptKernel({}, hooks(), [], { maxBytes: 128, maxVariableBytes: 32 })
    const snapshot = await first.execute([
      'let stable = "ok";',
      `let oversized = ${JSON.stringify('x'.repeat(64))};`,
      'void 0',
    ].join('\n'), 2_000)
    expect(snapshot.variables.find(variable => variable.name === 'stable')).toHaveProperty('valueBase64')
    expect(snapshot.variables.find(variable => variable.name === 'oversized')?.error)
      .toBe('exceeds per-variable snapshot size cap')
    first.dispose()

    const recovered = new PersistentTypeScriptKernel({}, hooks(), snapshot.variables, {
      maxBytes: 128,
      maxVariableBytes: 32,
    })
    await expect(recovered.execute('({ stable, oversized: typeof oversized })', 2_000))
      .resolves.toMatchObject({ value: { stable: 'ok', oversized: 'undefined' } })
    recovered.dispose()
  })

  it('applies the per-variable cap to declaration-source snapshots', async () => {
    const kernel = new PersistentTypeScriptKernel({}, hooks(), [], {
      maxBytes: 512,
      maxVariableBytes: 96,
    })
    const snapshot = await kernel.execute([
      'const stable = 7;',
      `function oversizedSource() { /* ${'x'.repeat(160)} */ return stable }`,
      'void 0',
    ].join('\n'), 2_000)
    expect(snapshot.variables.find(variable => variable.name === 'stable')).toHaveProperty('valueBase64')
    expect(snapshot.variables.find(variable => variable.name === 'oversizedSource')?.error)
      .toBe('exceeds per-variable snapshot size cap')
    expect(snapshot.variables.find(variable => variable.name === 'oversizedSource')?.source).toBeUndefined()
    kernel.dispose()
  })

  it('applies the aggregate cap after charging the programmable context', async () => {
    const kernel = new PersistentTypeScriptKernel({ seed: 'x' }, hooks(), [], {
      maxBytes: 28,
      maxVariableBytes: 20,
    })
    const snapshot = await kernel.execute([
      'let firstPayload = "12345678";',
      'let secondPayload = "abcdefgh";',
      'void 0',
    ].join('\n'), 2_000)
    expect(snapshot.variables.filter(variable => variable.error === undefined)).toHaveLength(1)
    expect(snapshot.variables.filter(variable => variable.error === 'exceeds aggregate snapshot size cap')).toHaveLength(1)
    kernel.dispose()
  })
})
