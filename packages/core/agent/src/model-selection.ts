/**
 * Agent-scoped model selection shared by runtime entry points.
 * @module @deepseek-ai/dsh-agent/model-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from './runtime-types.ts'

/** Complete provider, model, and optional reasoning effort selected for one live Agent. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

interface InstalledModelSelection {
  readonly ref: ModelSelectionRef
  captured: boolean
}

const installedSelections = new WeakMap<Context, InstalledModelSelection>()

/** Selection read by a consumer that needs the request step's chosen model. */
export interface ModelSelectionSnapshot {
  /** Whether this Agent scope installed a mutable selection. */
  installed: boolean
  /** Captured selection for this step, or the Agent options when no selection is installed. */
  selection: ModelSelection | undefined
}

/**
 * Read an Agent's captured model selection without exposing a concurrent next-step change.
 *
 * An installed selection becomes visible only after prompt assembly captures it. Entry
 * points without that installation retain their complete `Agent.options` route.
 *
 * @param agent - Agent whose scoped selection belongs to the consuming request.
 * @returns Captured selection and whether it came from an installed scope.
 */
export function readModelSelection(agent: Agent): ModelSelectionSnapshot {
  const installed = installedSelections.get(agent.ctx)
  if (installed !== undefined) {
    return { installed: true, selection: installed.captured ? installed.ref.assembled : undefined }
  }
  const { provider, model } = agent.options
  return {
    installed: false,
    selection: provider === undefined || model === undefined ? undefined : { provider, model },
  }
}

/**
 * Couple one mutable selection to Agent-scoped prompt assembly and request routing.
 * Prompt assembly snapshots the selected model before delegating, then applies
 * its provider/model pair and effort to request config so a
 * concurrent switch takes effect on a later step instead of splitting the two
 * surfaces. An absent selected effort clears any inherited effort, restoring
 * the selected model's provider/default behavior.
 *
 * @param agentCtx - The selected Agent's scoped context.
 * @param selection - Mutable selection owned by the calling entry point.
 * @returns Disposer for both scoped waterfall listeners and the selection lookup.
 */
export function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const installed: InstalledModelSelection = { ref: selection, captured: false }
  const disposeLookup = agentCtx.effect(() => {
    installedSelections.set(agentCtx, installed)
    return () => {
      if (installedSelections.get(agentCtx) === installed) installedSelections.delete(agentCtx)
    }
  }, 'agent.installModelSelection()')
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    if (installedSelections.get(agentCtx) === installed) installed.captured = false
    const assembled = await next()
    if (installedSelections.get(agentCtx) === installed) {
      selection.assembled = selected
      installed.captured = true
    }
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
      }
    },
  )
  return () => {
    disposeAssembly()
    disposeRequest()
    void disposeLookup()
  }
}
