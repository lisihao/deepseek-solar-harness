/** External webpage fixture; the production operator executes its real browser program. */
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserProviderId, BrowserWorkspaceId,
  type BrowserJsonValue, type BrowserOperationV1, type BrowserProvider,
  type BrowserRunProgramResultV1, type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'

export const inject = ['browser']

/** Mount a deterministic external page with delayed editor initialization. */
export function apply(ctx: Context): void {
  const provider: BrowserProvider = {
    descriptor: {
      id: BrowserProviderId('snapshot-browser'), layers: ['browser-js-v1'],
      capabilities: ['authenticated-profile-reuse', 'named-workspace', 'page-evaluate'],
    },
    available: () => true,
    async runProgram(program: BrowserRunProgramV1): Promise<BrowserRunProgramResultV1> {
      const dom = new JSDOM('<form><textarea id="prompt-textarea"></textarea><button id="composer-submit-button">Send</button></form>', {
        url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true,
      })
      const { document } = dom.window
      dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
        x: 0, y: 0, width: 100, height: 20, top: 0, right: 100, bottom: 20, left: 0,
        toJSON: () => ({}),
      })
      Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
        get(this: HTMLElement) { return this.textContent },
        set(this: HTMLElement, value: string) { this.textContent = value },
      })
      let inspections = 0
      let submitted = false
      const browser = {
        async run(operation: BrowserOperationV1): Promise<unknown> {
          if (operation.kind === 'open' || operation.kind === 'navigate') return {}
          if (operation.kind !== 'fill' && operation.kind !== 'click') throw new Error('unexpected browser operation')
          if (operation.locator.kind !== 'css') throw new Error('fixture requires a CSS locator')
          const target = document.querySelector<HTMLElement>(operation.locator.selector)
          if (target === null) throw new Error('operator targeted a missing element')
          if (operation.kind === 'fill') {
            if (!target.matches('.ProseMirror[contenteditable="true"]')) throw new Error('operator filled the uninitialized textarea')
            target.innerText = operation.value
            const send = document.createElement('button')
            send.type = 'submit'
            send.setAttribute('aria-label', 'Send message')
            target.closest('form')!.append(send)
          } else {
            if (target.getAttribute('aria-label') !== 'Send message') throw new Error('operator submitted the placeholder form')
            submitted = true
            dom.reconfigure({ url: 'https://chatgpt.com/c/keyless-composer' })
            document.body.innerHTML = '<section><div><div data-content-search-unit-key="fixture:0:user"><div data-user-message-bubble="true">Fixture task</div></div><div data-content-search-unit-key="fixture:2:assistant"><h4>ChatGPT said:</h4><div data-markdown-text-style="assistant-message"><p>Composer ready; request accepted.</p></div></div></div><div><button aria-label="Copy">Copy</button></div></section>'
          }
          return {}
        },
        async evaluate(_page: string, expression: string, argument?: BrowserJsonValue): Promise<BrowserJsonValue> {
          inspections++
          if (inspections === 2 && !submitted) document.body.innerHTML = '<form><div class="ProseMirror" contenteditable="true" role="textbox"></div></form>'
          return await new Script(`(${expression})(${JSON.stringify(argument)})`).runInContext(dom.getInternalVMContext()) as BrowserJsonValue
        },
      }
      try {
        const execute = new Script(`(async (browser) => {${program.source}})`).runInNewContext({ setTimeout, TextEncoder, Intl }) as (api: typeof browser) => Promise<BrowserJsonValue>
        const value = await execute(browser)
        return {
          version: 1,
          workspace: { id: BrowserWorkspaceId('keyless-composer'), lifecycle: 'active', control: 'agent' },
          output: { kind: 'json', value },
        }
      } finally {
        dom.window.close()
      }
    },
  }
  ctx.browser.registerProvider(provider)
}
