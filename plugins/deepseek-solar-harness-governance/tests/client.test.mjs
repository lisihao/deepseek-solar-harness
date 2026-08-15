import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

function findByTestId(node, testId) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.props?.['data-testid'] === testId) return node
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findByTestId(child, testId)
    if (found !== null) return found
  }
  return null
}

test('built browser plugin registers a visible governance Trace sidebar entry', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let client
  const styles = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useCallback(callback) { return callback },
    useEffect() {},
    useRef(value) { return { current: value } },
    useState(value) { return [value, () => {}] },
  }
  const primitives = {
    IconCloseOutline16: () => null,
    IconCodeOutline16: () => null,
    IconRefreshOutline16: () => null,
    Tooltip: ({ children }) => children,
  }
  const sandbox = {
    URL,
    document: {
      querySelector() { return null },
      createElement() { return { dataset: {} } },
      head: { appendChild(style) { styles.push(style) } },
    },
    window: {
      __ModuleLoader__: {
        load(definition) {
          assert.equal(definition.id, '@lisihao/dsh-code-harness-governance')
          client = definition.factory(id => id === 'react' ? React : primitives)
        },
      },
    },
  }
  vm.runInNewContext(code, sandbox)
  assert.deepEqual([...client.inject], ['slots'])
  let registration
  const ctx = {
    slots: {
      inject(name, callback) { assert.equal(name, 'sidebar.footer.action'); callback() },
      register(options, component) { registration = { options, component }; return () => {} },
    },
  }
  client.apply(ctx)
  assert.equal(registration.options.id, 'code-harness-governance-trace')
  const tree = registration.component({ wide: true, useSessions: selector => selector({ current: 'session-1' }) })
  const entry = findByTestId(tree, 'governance-trace-entry')
  assert.ok(entry)
  assert.equal(entry.props['aria-label'], '治理 Trace')
  assert.equal(styles[0].dataset.plugin, '@lisihao/dsh-code-harness-governance')
  assert.match(styles[0].textContent, /\[data-slot='sidebar\.footer\.action'\]\s*\{[^}]*flex-direction:\s*column/iu)
  assert.match(styles[0].textContent, /\.dsh-governance-overlay\s*\{[^}]*align-items:\s*center/iu)
  assert.match(styles[0].textContent, /\.dsh-governance-panel\s*\{[^}]*max-width:\s*720px/iu)
})
