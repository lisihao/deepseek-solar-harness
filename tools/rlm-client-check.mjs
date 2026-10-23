import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, runInContext } from 'node:vm'

// Exercise the shipped browser entry without Node's ambient module/require.
// This matches the published DSH client format, rather than importing CJS in Node.
export async function checkRlmClient(path) {
  const entries = []
  const context = createContext({ window: { __ModuleLoader__: { load: entry => entries.push(entry) } } })
  runInContext(await readFile(path, 'utf8'), context, { filename: path, timeout: 1_000 })
  assert.equal(entries.length, 1, 'client must register exactly one DSH entry')
  const entry = entries[0]
  assert.equal(entry.id, '@lisihao/dsh-solar-rlm')
  const imports = []
  const plugin = entry.factory(name => {
    imports.push(name)
    assert.equal(name, 'react', 'browser must share host React')
    return {}
  })
  assert.deepEqual(imports, ['react'])
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'remote', 'connection'])
  const slots = []
  const disposers = []
  let mounts = 0
  let unmounts = 0
  plugin.apply({
    effect(setup) { disposers.push(setup()) },
    remote: { async $mount(descriptor) {
      assert.equal(descriptor.package, entry.id)
      mounts++
      return async () => { unmounts++ }
    } },
    get(name) { assert.equal(name, 'remote.solarRlmControl'); return {} },
    slots: {
      inject(name, setup) { disposers.push(setup()); return () => {} },
      register(descriptor, view) {
        assert.equal(descriptor.id, 'solar-rlm')
        assert.equal(descriptor.label(), 'RLM 算子')
        assert.equal(typeof view, 'function')
        slots.push(descriptor.name)
        return () => { slots.splice(slots.indexOf(descriptor.name), 1) }
      },
    },
  })
  await Promise.resolve()
  assert.equal(mounts, 1)
  assert.deepEqual(slots, ['settings.section'])
  for (const dispose of disposers.reverse()) dispose?.()
  await Promise.resolve()
  assert.equal(unmounts, 1)
  assert.deepEqual(slots, [])
}
