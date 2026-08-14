/** Sidebar entries and full-page iframe panels for configured Web applications. */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconBrowseOutline16, IconCloseOutline16, IconLinkOutline16, IconRefreshOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WebpageInstanceView } from '../contract.ts'
import type { createWebpageModulesStore } from './store.ts'
import css from './RemoteModuleEntry.module.css'

/** Browser-owned callback used to refresh the Host-published roster. */
export interface WebpageModulesInjected {
  load: () => Promise<void>
}

/** Slot runtime plus one operator-configured page instance. */
export type WebpageEntryProps = PropsRuntime<'sidebar.footer.action'> & WebpageInstanceView

/** Slot runtime, package store, and its configuration controller. */
export type WebpageModulesSidebarProps = PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createWebpageModulesStore>> & WebpageModulesInjected

interface WebpagePanelProps extends WebpageInstanceView {
  onClose: () => void
}

function WebpagePanel({ id, label, targetUrl, embedUrl, onClose }: WebpagePanelProps) {
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const [frameRevision, setFrameRevision] = useState(0)
  useEffect(() => {
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <section className={css.panel} role="dialog" aria-modal="true" aria-label={label}>
        <header className={css.header}>
          <div className={css.identity}>
            <span className={css.moduleIcon} aria-hidden="true"><IconBrowseOutline16 size={18} /></span>
            <div className={css.titles}>
              <strong>{label}</strong>
              <span title={targetUrl}>{targetUrl}</span>
            </div>
          </div>
          <div className={css.actions}>
            <Tooltip label="在新窗口打开">
              <a className={css.iconButton} aria-label={`在新窗口打开 ${label}`} href={embedUrl} target="_blank" rel="noreferrer">
                <IconLinkOutline16 size={16} />
              </a>
            </Tooltip>
            <Tooltip label="重新加载网页">
              <button type="button" className={css.iconButton} aria-label={`重新加载 ${label}`} onClick={() => { setFrameRevision(value => value + 1) }}>
                <IconRefreshOutline16 size={16} />
              </button>
            </Tooltip>
            <Tooltip label="关闭模块">
              <button ref={closeButton} type="button" className={css.iconButton} aria-label={`关闭 ${label}`} onClick={onClose}>
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </header>
        <iframe
          key={`${id}:${String(frameRevision)}`}
          className={css.webFrame}
          data-testid={`remote-webpage-frame-${id}`}
          title={`${label} 网页`}
          src={embedUrl}
          allow="clipboard-read; clipboard-write; fullscreen"
          referrerPolicy="no-referrer"
          allowFullScreen
        />
      </section>
    </div>
  )
}

/** Render one configured page button and its actual target application. */
export function WebpageEntry({ wide, ...instance }: WebpageEntryProps) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  return (
    <>
      <Tooltip label={instance.label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={instance.label}
          onClick={() => { setOpen(true) }}
        >
          <IconBrowseOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.triggerLabel}>{instance.label}</span>}
        </button>
      </Tooltip>
      {open && <WebpagePanel {...instance} onClose={close} />}
    </>
  )
}

/** Render every configured instance vertically inside one sidebar occupant. */
export function WebpageModulesSidebar({ load, useStore, ...runtime }: WebpageModulesSidebarProps) {
  const state = useStore(snapshot => snapshot)
  useEffect(() => { if (state.phase === 'idle') void load() }, [load, state.phase])
  if (state.phase === 'error' && state.instances.length === 0) {
    return (
      <button type="button" className={clsx(css.configError, !runtime.wide && css.rail)} onClick={() => { void load() }}>
        <IconRefreshOutline16 size={16} />
        {runtime.wide && <span>重新加载网页插件</span>}
      </button>
    )
  }
  return (
    <div className={clsx(css.entryStack, !runtime.wide && css.railStack)} data-testid="remote-webpages-sidebar-stack">
      {state.instances.map(instance => <WebpageEntry key={instance.id} {...runtime} {...instance} />)}
    </div>
  )
}
