/**
 * Session event types written by the removed ChatGPT Web tool-coordination
 * mode. Nothing writes them any more. The persistence read path refuses a log
 * that contains an unknown required event type, so these declarations keep
 * Session logs from DSH Desktop 3.17.1 through 3.20.x readable.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/receipt-events
 */

import type { WebModelPreferences } from './model-catalog.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Pre-send identity for one command. It proves only that DSH began a
     * browser attempt; it never proves that ChatGPT accepted the prompt.
     */
    'chatgpt-web/intent': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      workspaceName: string
      promptSha256: string
      targetUrl: string
      connectorName: string
      baselineUserMessageIds: string[]
      profile?: WebModelPreferences
    }
    /**
     * A website observation proved the exact native user message created for
     * one command in its owned lane.
     */
    'chatgpt-web/accepted': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      workspaceName: string
      conversationId: string
      conversationUrl: string
      userMessageId: string
      connectorName: string
      requestIds: string[]
    }
    /**
     * A strong terminal signal or exact final action produced one completed
     * assistant result for the accepted native user message.
     */
    'chatgpt-web/completed': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      conversationId: string
      conversationUrl: string
      userMessageId: string
      assistantMessageId: string
      response: string
      responseSha256: string
      truncated: boolean
      model: string
      effort?: string
      requestIds: string[]
    }
    /**
     * A known local refusal before the send click. It prevents a duplicate
     * command from silently re-evaluating a changed browser draft or connector.
     */
    'chatgpt-web/rejected': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      code: string
    }
    /**
     * A send click returned before a native user-message identity was observed.
     * The candidate page is retained solely for a no-send recovery inspection.
     */
    'chatgpt-web/submission-pending': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      candidateUrl: string
      baselineUserMessageIds: string[]
    }
    /** Exact user-turn observation reached a stopped or failed provider outcome. */
    'chatgpt-web/terminal': {
      commandId: string
      parentId: string
      laneId: string
      laneKey: string
      outcome: 'stopped' | 'failed'
    }
  }
}
