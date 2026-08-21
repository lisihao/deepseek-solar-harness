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

test('built browser plugin registers governance Trace as a per-session view tab', async () => {
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
    IconRefreshOutline16: () => null,
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
      inject(name, callback) { assert.equal(name, 'conversation.view'); callback() },
      register(options, component) { registration = { options, component }; return () => {} },
    },
  }
  client.apply(ctx)
  assert.equal(registration.options.id, 'code-harness-governance-trace')
  assert.equal(registration.options.order, 15)
  assert.equal(registration.options.label, '治理 Trace')
  const tree = registration.component({ sessionId: 'session-1' })
  const view = findByTestId(tree, 'governance-trace-view')
  assert.ok(view)
  assert.equal(styles[0].dataset.plugin, '@lisihao/dsh-code-harness-governance')
  assert.doesNotMatch(styles[0].textContent, /sidebar\.footer\.action|dsh-governance-overlay/iu)
  assert.match(styles[0].textContent, /\.dsh-governance-view\s*\{[^}]*height:\s*100%/iu)
  assert.match(styles[0].textContent, /\.dsh-governance-panel\s*\{[^}]*max-width:\s*720px/iu)
})

test('trace source distinguishes rejected and invalidated work from unmanaged sessions', async () => {
  const source = await readFile(new URL('../src/client.cjs', import.meta.url), 'utf8')
  assert.match(source, /case 'rejected': return '验收拒绝'/u)
  assert.match(source, /case 'invalidated': return '证明失效'/u)
  assert.match(source, /case 'candidate': return '待验收'/u)
  assert.match(source, /治理事件/u)
  assert.match(source, /encodeURIComponent\(sessionId\)/u)
  assert.doesNotMatch(source, /useSessions|currentSession/u)
  assert.match(source, /外部 Codex 任务与 GitHub Actions 不会自动写入/u)
})
