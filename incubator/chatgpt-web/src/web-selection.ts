/** Match only evidence read on the same target page; no browser/global aliases. */
export function matchesWebEffort(requested: string | undefined, observed: { readonly effortLabel?: string; readonly effortId?: string }): boolean {
  return requested === undefined || observed.effortLabel === requested || observed.effortId === requested
}
