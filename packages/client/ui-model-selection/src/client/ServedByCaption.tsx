/**
 * The model and effort that served one assistant reply, as a muted caption in the reply's action strip. The reply
 * records route, model and effort; the directory turns them into the names the menu shows. A model the directory does
 * not list is left out rather than shown by an internal id.
 */
import type { ServedByProps } from './slots.ts'
import { describeSelection, joinLabel } from './labels.ts'
import css from './ServedByCaption.module.css'

/**
 * One reply's caption.
 * @param props - the reply's served configuration and the session directory hook.
 * @returns the caption, or null when the reply recorded no configuration or the model has no display name.
 */
export function ServedByCaption({ served, useDirectory, t }: ServedByProps) {
  const groups = useDirectory(state => state.groups)
  const failures = useDirectory(state => state.failures)
  if (served === undefined) return null
  const label = describeSelection({ groups, failures }, {
    provider: served.provider,
    model: served.model,
    ...served.reasoningEffort === undefined ? {} : { reasoningEffort: served.reasoningEffort },
  })
  if (!label.named) return null
  return <span className={css.caption} title={t('served.title', { name: joinLabel(label) })}>{joinLabel(label)}</span>
}
