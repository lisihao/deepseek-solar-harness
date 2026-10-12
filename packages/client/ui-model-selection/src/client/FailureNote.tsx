/**
 * Quiet notice for model sources that did not load. The menu shows one muted line with the count; the reasons and
 * the retry action appear only when the user asks for them, so a signed-out provider does not crowd the model list.
 */
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModelSelect.module.css'

/** One source that failed and why. */
export interface FailedSource {
  /** Display name of the provider or catalog. */
  readonly name: string
  /** The failure text the source reported. */
  readonly message: string
}

/**
 * Render nothing without failures; otherwise a summary that expands to each source's reason and a retry. Until the
 * user toggles it, it follows `expandedByDefault`, which the model pane sets while no model is available, because the
 * reasons are then the only thing to act on; the user's own toggle wins from then on.
 * @param props - the failed sources, the default expansion, the retry action, and the translator.
 * @returns the notice, or null when nothing failed.
 */
export function FailureNote(
  { items, expandedByDefault = false, onRetry, t }:
  { items: readonly FailedSource[]; expandedByDefault?: boolean; onRetry: () => void; t: TranslateNS<'model'> },
) {
  const [chosen, setChosen] = useState<boolean | null>(null)
  if (items.length === 0) return null
  const open = chosen ?? expandedByDefault
  return (
    <div className={css.failureNote}>
      <button
        type="button"
        className={css.failureToggle}
        aria-expanded={open}
        onClick={() => { setChosen(!open) }}
      >
        <span>{t('failure.summary', { count: String(items.length) })}</span>
        <span className={css.failureAction}>{open ? t('failure.hide') : t('failure.show')}</span>
      </button>
      {open && (
        <div className={css.failureDetail}>
          {items.map(item => <div key={item.name}>{t('failure.item', { name: item.name, message: item.message })}</div>)}
          <button type="button" className={css.retry} onClick={onRetry}>{t('retry')}</button>
        </div>
      )}
    </div>
  )
}
