import { describe, expect, it } from 'vitest'
import { PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'
import { RlmDispatchSettlementTracker } from '../src/rlm-dispatch-settlement.ts'

describe('attempt dispatch settlement evidence', () => {
  it('retains every API request round after worker dispatch and local resources finish', async () => {
    const tracker = new RlmDispatchSettlementTracker()
    const command = tracker.beginCommand(PhysicalOperatorExecutionId('api-command'))
    const first = command.beginRequest()
    first.sent()
    first.terminalResponse()
    const second = command.beginRequest()
    second.sent()
    command.finishDispatch()
    command.releaseResources()
    tracker.closeAdmission()
    expect(tracker.snapshot()).toMatchObject({ requestCount: 2, pendingRequests: 1, settled: false })
    second.unknown()
    expect(tracker.snapshot()).toMatchObject({ unknownRequests: 1, settled: false })
    second.terminalResponse()
    await tracker.whenSettled
    expect(tracker.snapshot()).toMatchObject({ requestCount: 2, unknownRequests: 0, settled: true })
  })

  it('keeps a pre-reserved late acceptance owned after closing admission', async () => {
    const tracker = new RlmDispatchSettlementTracker()
    const command = tracker.beginCommand(PhysicalOperatorExecutionId('resident-command'))
    const request = command.beginRequest()
    tracker.closeAdmission()
    expect(tracker.snapshot()).toMatchObject({ dispatchingCommands: 1, pendingRequests: 1, settled: false })
    request.sent()
    command.finishDispatch()
    request.terminalResponse()
    expect(tracker.snapshot()).toMatchObject({ unreleasedCommands: 1, settled: false })
    command.releaseResources()
    await tracker.whenSettled
    expect(tracker.snapshot().settled).toBe(true)
  })

  it('does not settle an unknown request merely because resources have closed', () => {
    const tracker = new RlmDispatchSettlementTracker()
    const command = tracker.beginCommand(PhysicalOperatorExecutionId('uncertain-command'))
    const request = command.beginRequest()
    request.sent()
    request.unknown()
    command.finishDispatch()
    command.releaseResources()
    tracker.closeAdmission()
    expect(tracker.snapshot()).toMatchObject({ pendingRequests: 0, unreleasedCommands: 0, unknownRequests: 1, settled: false })
  })

  it('rejects new commands and request rounds after closing but accepts existing terminal evidence', async () => {
    const tracker = new RlmDispatchSettlementTracker()
    const command = tracker.beginCommand(PhysicalOperatorExecutionId('current-command'))
    const request = command.beginRequest()
    request.sent()
    tracker.closeAdmission()
    expect(() => tracker.beginCommand(PhysicalOperatorExecutionId('late-command'))).toThrow('admission is closed')
    expect(() => command.beginRequest()).toThrow('admission is closed')
    request.terminalResponse()
    command.finishDispatch()
    command.releaseResources()
    await tracker.whenSettled
  })

  it('distinguishes proved non-dispatch from a request already sent to a provider', async () => {
    const tracker = new RlmDispatchSettlementTracker()
    const command = tracker.beginCommand(PhysicalOperatorExecutionId('not-sent-command'))
    command.beginRequest().notSent()
    const sent = command.beginRequest()
    sent.sent()
    expect(() =>{  sent.notSent() }).toThrow('contradicts')
    sent.terminalResponse()
    command.finishDispatch()
    command.releaseResources()
    tracker.closeAdmission()
    await tracker.whenSettled
  })

  it('can settle a known post-response tool failure without interpreting it as request uncertainty', async () => {
    const tracker = new RlmDispatchSettlementTracker()
    const command = tracker.beginCommand(PhysicalOperatorExecutionId('tool-failure-command'))
    const request = command.beginRequest()
    request.sent()
    request.terminalResponse()
    command.finishDispatch()
    command.releaseResources()
    expect(tracker.snapshot().settled).toBe(false)
    tracker.closeAdmission()
    await tracker.whenSettled
    expect(tracker.snapshot()).toMatchObject({ unknownRequests: 0, settled: true })
  })

  it('does not replace an existing command recorder or reopen a finished command', () => {
    const tracker = new RlmDispatchSettlementTracker()
    const id = PhysicalOperatorExecutionId('fixed-command')
    const command = tracker.beginCommand(id)
    expect(() => tracker.beginCommand(id)).toThrow('already has settlement evidence')
    command.finishDispatch()
    expect(() => command.beginRequest()).toThrow('admission is closed')
  })

  it('cannot publish resource release while the same command may still create a request', () => {
    const tracker = new RlmDispatchSettlementTracker()
    const command = tracker.beginCommand(PhysicalOperatorExecutionId('dispatching-command'))
    expect(() =>{  command.releaseResources() }).toThrow('dispatch has not finished')
    expect(tracker.snapshot().unreleasedCommands).toBe(1)
  })

  it('distinguishes one completed command from another pending command', async () => {
    const tracker = new RlmDispatchSettlementTracker()
    const complete = tracker.beginCommand(PhysicalOperatorExecutionId('complete'))
    const concurrent = tracker.beginCommand(PhysicalOperatorExecutionId('concurrent'))
    const first = complete.beginRequest()
    first.sent()
    first.terminalResponse()
    complete.finishDispatch()
    complete.releaseResources()
    const second = concurrent.beginRequest()
    second.sent()
    expect(complete.snapshot()).toMatchObject({ settled: true, pendingRequests: 0, unknownRequests: 0 })
    expect(concurrent.snapshot()).toMatchObject({ settled: false, pendingRequests: 1 })
    expect(tracker.snapshot()).toMatchObject({ settled: false, pendingRequests: 1 })
    second.unknown()
    concurrent.finishDispatch()
    concurrent.releaseResources()
    tracker.closeAdmission()
    expect(complete.snapshot().settled).toBe(true)
    expect(concurrent.snapshot()).toMatchObject({ settled: false, unknownRequests: 1 })
    second.terminalResponse()
    await tracker.whenSettled
  })
})
