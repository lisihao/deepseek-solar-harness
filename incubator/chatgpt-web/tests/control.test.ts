import { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import { WebControl } from '../src/control.js'
import type { WebController } from '../src/controller.js'
const id = '7d40e2ee-891a-4a44-8dbe-07b2e8781cde'
function setup() {
  let resolve!: (value: never) => void
  const pending = new Promise<never>(done => { resolve = done })
  const controller = { list: vi.fn(async () => []), start: vi.fn(() => pending), observe: vi.fn(), cancel: vi.fn() }
  const service = new WebControl(new Context(), controller as unknown as WebController, { modelLabel: 'GPT-6' })
  return { service, controller, resolve }
}
test('loading/refreshed status never launches browser/model work', async () => {
  const {service, controller} = setup()
  expect(await service.status()).toEqual({ runs: [], activeIds: [], errors: [] })
  expect(controller.start).not.toHaveBeenCalled()
  expect(controller.observe).not.toHaveBeenCalled()
})
test('invalid or extra inputs reject before launch; identical pending request is not launched twice', async () => {
  const {service, controller} = setup()
  await expect(service.launch({id,request:{prompt:'hi'},retry:true} as never)).rejects.toThrow()
  const input={id,request:{prompt:'hi'}}
  await service.launch(input); await service.launch(input)
  expect(controller.start).toHaveBeenCalledExactlyOnceWith(id,{prompt:'hi',modelLabel:'GPT-6'})
  await expect(service.launch({id,request:{prompt:'different'}})).rejects.toThrow('WEB_COMMAND_CONFLICT')
  expect((await service.status()).activeIds).toEqual([id])
})
test('non-owner Remote callers cannot query or submit', async () => {
  const {service,controller}=setup()
  const receiver=Object.create(service) as WebControl
  Object.defineProperty(receiver,'ctx',{value:{invocation:{peer:{principal:{kind:'untrusted-test-peer'}}}}})
  await expect(receiver.status()).rejects.toThrow('LOCAL_OWNER_REQUIRED')
  await expect(receiver.launch({id,request:{prompt:'hi'}})).rejects.toThrow('LOCAL_OWNER_REQUIRED')
  await expect(receiver.observe({id})).rejects.toThrow('LOCAL_OWNER_REQUIRED')
  await expect(receiver.cancel({id})).rejects.toThrow('LOCAL_OWNER_REQUIRED')
  expect(controller.start).not.toHaveBeenCalled()
})
