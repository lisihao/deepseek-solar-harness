/**
 * Plugin-contributed rules that keep sessions out of the workspace browser's lists. The browser knows no session
 * kind; a plugin that owns its own conversation space registers a rule and lists those sessions itself.
 */

import { createContext } from 'react'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionHidden } from './tree.ts'

/** What a plugin sees of the registry. */
export interface SessionListFilters {
  /**
   * Keep every session matching `predicate` out of the browser's grouped list, flat list, and search results. The
   * session stays in its Workspace and can still be opened; only its row is withheld.
   * @param predicate - true for a session that must not be listed.
   * @returns a disposer that restores the rows.
   */
  hide(predicate: SessionHidden): () => void
}

/** Registry behind {@link SessionListFilters}; the browser reads {@link SessionListFilterRegistry.source}. */
export class SessionListFilterRegistry implements SessionListFilters {
  private predicates: readonly SessionHidden[] = []
  private combined: SessionHidden | undefined
  private readonly listeners = new Set<() => void>()

  /** The combined rule, or `undefined` while nothing is hidden; its identity changes only when a rule is added or removed. */
  readonly source: HostObservable<SessionHidden | undefined> = {
    getSnapshot: () => this.combined,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  hide(predicate: SessionHidden): () => void {
    this.predicates = [...this.predicates, predicate]
    this.publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      const at = this.predicates.indexOf(predicate)
      this.predicates = this.predicates.filter((_, index) => index !== at)
      this.publish()
    }
  }

  private publish(): void {
    const predicates = this.predicates
    this.combined = predicates.length === 0 ? undefined : session => predicates.some(predicate => predicate(session))
    for (const listener of [...this.listeners]) listener()
  }
}

/** The combined rule for the browser's descendants, so each list derives its rows from the same decision. */
export const HiddenSessionsContext = createContext<SessionHidden | undefined>(undefined)
