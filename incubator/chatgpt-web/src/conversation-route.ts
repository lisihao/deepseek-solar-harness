/** Observed optimistic ChatGPT route finalization, never a general redirect allowance. */
export function canFinalizeChatGptRoute(previous: string, current: string): boolean {
  try {
    const before = new URL(previous)
    const after = new URL(current)
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    return before.protocol === 'https:' && after.protocol === 'https:'
      && before.hostname === 'chatgpt.com' && after.origin === before.origin
      && before.username === '' && before.password === '' && after.username === '' && after.password === ''
      && before.search === '' && before.hash === '' && after.search === '' && after.hash === ''
      && new RegExp('^/c/local-chatgpt:' + uuid + '$', 'i').test(decodeURIComponent(before.pathname))
      && new RegExp('^/c/' + uuid + '$', 'i').test(after.pathname)
  } catch {
    return false
  }
}
