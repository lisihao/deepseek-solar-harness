// Keyless native backend for the real Gouzi process composition. Reading turns resolve their file through the
// receiver workspace in the model input; other turns write one fixture file. It calls no model.
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
      appendFileSync(join(memberHome, 'fixture-inputs.jsonl'), `${JSON.stringify({
        commandId: request.commandId, workspace: request.workspace, prompt: request.prompt,
        systemPrompt: request.systemPrompt,
      })}\n`)
      let readWorkspace = request.workspace
      if (reading) {
        const marker = 'Remote execution workspace:\n'
        const start = request.systemPrompt?.lastIndexOf(marker) ?? -1
        if (start < 0) throw new Error('README reader has no receiver workspace in its model input')
        const binding = JSON.parse(request.systemPrompt.slice(start + marker.length).split('\n')[0])
        if (binding.cwd !== request.workspace) throw new Error('model workspace differs from execution workspace')
        readWorkspace = binding.cwd
      }
      const output = reading
        ? `README.md:1: ${readFileSync(join(readWorkspace, 'README.md'), 'utf8')}Files: ${readdirSync(readWorkspace).filter(name => name !== '.git').sort().join(', ')}`
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
