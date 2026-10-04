/** Project chooser for an SSH host: browse its folders and tick the Git repositories the member may use. */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import type { GouziFolderListing } from '../contracts.ts'
import { callGouzi, type BrowserRequest } from './api.ts'
import { messageOf } from './HostStep.tsx'
import css from './GouziPanel.module.css'

/** Browse `hostId` from its login directory; `selected` holds absolute paths on that host. */
export function RemoteFolderPicker({ request, hostId, selected, onChange }: {
  request: BrowserRequest
  hostId: string
  selected: readonly string[]
  onChange: (paths: readonly string[]) => void
}) {
  const [listing, setListing] = useState<GouziFolderListing>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const open = useCallback(async (path?: string): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      setListing(await callGouzi<GouziFolderListing>(request, { action: 'browse', hostId, ...path === undefined ? {} : { path } }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [request, hostId])
  useEffect(() => { void open() }, [open])
  const toggle = (path: string): void => {
    onChange(selected.includes(path) ? selected.filter(item => item !== path) : [...selected, path])
  }
  return (
    <div className={css.field}>
      <span>在这台机器上选择项目（要是 Git 仓库）</span>
      {listing !== undefined && (
        <div className={css.pathBar}>
          <button type="button" className={css.link} disabled={loading || listing.parent === undefined} onClick={() => { void open(listing.parent) }}>上一级</button>
          <code title={listing.path}>{listing.path}</code>
        </div>
      )}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {listing !== undefined && listing.entries.length === 0 && <p className={css.hint}>这里没有子文件夹。</p>}
      <ul className={css.projectList}>
        {listing?.entries.map(entry => (
          <li key={entry.path} className={clsx(css.folderRow, selected.includes(entry.path) && css.chosen)}>
            {entry.git
              ? <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selected.includes(entry.path)} onChange={() => { toggle(entry.path) }} />
              : <span className={css.folderSpacer} aria-hidden="true" />}
            <button type="button" className={css.link} disabled={loading} onClick={() => { void open(entry.path) }}>{entry.name}</button>
            {entry.git && <span className={css.gitBadge}>Git</span>}
          </li>
        ))}
      </ul>
      {selected.length > 0 && (
        <ul className={css.projectList} aria-label="已选择的项目">
          {selected.map(path => (
            <li key={path} className={css.folderRow}>
              <span title={path}>{path}</span>
              <button type="button" className={css.link} onClick={() => { toggle(path) }}>移除</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
