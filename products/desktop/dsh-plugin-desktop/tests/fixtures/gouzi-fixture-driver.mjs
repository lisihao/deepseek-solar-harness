// Keyless Resident product driver for the Gouzi end-to-end test: one turn writes one file into the workspace the
// member materialized and appends one line to a counter in the member home. It calls no model.
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OPERATOR_ID = 'gouzi-fixture'

// The daemon passes `<member home>/resident-operators/providers/<index>` as the state root.
export function createResidentProductDriver({ stateRoot }) {
  const memberHome = resolve(stateRoot, '..', '..', '..')
  return {
    operatorId: OPERATOR_ID,
    qualify() {
      return Promise.resolve({
        operatorId: OPERATOR_ID,
        product: OPERATOR_ID,
        displayName: 'Gouzi fixture',
        description: 'Keyless fixture that writes one file per turn.',
        tags: ['coding'],
        maxConcurrency: 2,
        injectionBoundaries: ['pre-dispatch', 'next-turn'],
        available: true,
        authentication: 'native-subscription',
        productVersion: 'fixture',
        protocolHash: 'fixture',
        models: [{
          model: 'fixture', displayName: 'Fixture', description: 'No model', supportedEfforts: ['medium'],
          defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: false,
        }],
      })
    },
    execute(request) {
      const nativeSessionId = `native-${request.commandId}`
      request.onRunning(nativeSessionId)
      const safe = String(request.commandId).replace(/[^a-zA-Z0-9]+/gu, '-')
      const reading = JSON.stringify(request.prompt).includes('Read README.md and summarize its contents.')
      const output = reading
        ? `README.md:1: ${readFileSync(join(request.workspace, 'README.md'), 'utf8')}Files: ${readdirSync(request.workspace).filter(name => name !== '.git').sort().join(', ')}`
        : `wrote ${safe}`
      if (!reading) writeFileSync(join(request.workspace, `executed-${safe}.txt`), `${request.commandId}\n`)
      // One line per executed turn: the command id and the workspace the member materialized for it.
      appendFileSync(join(memberHome, 'fixture-executions.log'), `${request.commandId}\t${request.workspace}\n`)
      return Promise.resolve({
        output: [{ type: 'text', text: output }],
        stopReason: 'completed',
        nativeSessionId,
      })
    },
  }
}
