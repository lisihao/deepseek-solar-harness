/** Build one injection-safe Ego Lite heredoc from a portable request. */

import { BrowserError, type BrowserRunPlanV1, type BrowserRunProgramV1 } from '@deepseek-ai/dsh-browser'

/** Prefix on the single machine-readable result or error line. */
export const EGO_LITE_FRAME_PREFIX = '__DSH_BROWSER_V1__:'

/** Upstream's out-of-band update line prefix. */
export const EGO_LITE_NOTICE_PREFIX = '[ego-browser:notice]'

/** Frozen upstream source used to derive the adapter. */
export const EGO_LITE_UPSTREAM = Object.freeze({
  tag: 'v1.2.5',
  commit: 'fd3aae7146cf6c9c52014a9752f411bf9978ae93',
})

/** Runtime values embedded beside one request. */
export interface EgoLiteSourceLimits {
  readonly operationTimeoutMs: number
}

const EGO_LITE_RUNNER = String.raw`
const __dshFramePrefix = "__DSH_BROWSER_V1__:";
let __dshHardStop = null;
let __dshWorkspace = null;
const __dshPages = new Map();

// Ego Lite v1.2.5 exposes the object facades below, while the currently
// distributed macOS 0.4.7.4 helper exposes the same capabilities as flat
// globals. Keep that upstream packaging difference inside the Provider so the
// ctx.browser contract and its Consumers remain provider-neutral.
const __dshUsesFacadeApi = globalThis.taskSpaces !== null
  && typeof globalThis.taskSpaces === "object"
  && typeof globalThis.taskSpaces.list === "function"
  && typeof globalThis.taskSpaces.useOrCreate === "function"
  && globalThis.browser !== null
  && typeof globalThis.browser === "object"
  && typeof globalThis.browser.openOrReuseTab === "function"
  && globalThis.page !== null
  && typeof globalThis.page === "object"
  && typeof globalThis.page.info === "function"
  && typeof globalThis.page.locator === "function";

const __dshTaskSpaces = __dshUsesFacadeApi ? globalThis.taskSpaces : {
  list: (...args) => listTaskSpaces(...args),
  useOrCreate: (...args) => useOrCreateTaskSpace(...args),
  waitForAgentControl: (...args) => waitForAgentControl(...args),
  handOff: async (...args) => (await handOffTaskSpace(...args)) ?? { done: true },
  takeOver: async (...args) => (await takeOverTaskSpace(...args)) ?? { done: true },
  complete: async (...args) => (await completeTaskSpace(...args)) ?? { done: true },
};

const __dshBrowser = __dshUsesFacadeApi ? globalThis.browser : {
  listTabs: (...args) => listTabs(...args),
  openOrReuseTab: (...args) => openOrReuseTab(...args),
  switchTab: (...args) => switchTab(...args),
  closeTab: (...args) => closeTab(...args),
};

function __dshLegacySeconds(milliseconds) {
  return Math.max(0, milliseconds / 1000);
}

const __dshPage = __dshUsesFacadeApi ? globalThis.page : {
  info: (...args) => pageInfo(...args),
  snapshot: (...args) => snapshotText(...args),
  screenshot: (options = {}) => captureScreenshot(undefined, {
    full: options.fullPage === true,
    raw: options.raw === true,
  }),
  evaluate: (...args) => js(...args),
  goto: (url, options = {}) => gotoAndWait(url, {
    timeout: __dshLegacySeconds(options.timeout ?? 30000),
    wait: options.waitUntil !== "commit",
  }),
  reload: () => cdp("Page.reload", { ignoreCache: false }),
  waitForTimeout: (milliseconds) => wait(__dshLegacySeconds(milliseconds)),
  waitForLoadState: async (state, options = {}) => {
    const timeout = __dshLegacySeconds(options.timeout ?? 30000);
    if (state === "networkidle") return waitForNetworkIdle({ timeout });
    if (state === "load") return waitForLoad({ timeout });
    if (state !== "domcontentloaded") throw new Error("Unsupported load state: " + state);
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() <= deadline) {
      const readyState = await js("document.readyState");
      if (readyState === "interactive" || readyState === "complete") return true;
      await wait(0.1);
    }
    return false;
  },
  waitForURL: async (predicate, options = {}) => {
    const deadline = Date.now() + (options.timeout ?? 30000);
    while (Date.now() <= deadline) {
      const info = await pageInfo();
      if (predicate(new URL(info.url))) return true;
      await wait(0.1);
    }
    return false;
  },
};

function __dshError(code, message, operationId) {
  const error = new Error(message);
  error.dsh_code = code;
  if (operationId !== undefined) error.operationId = operationId;
  if ((code === "BROWSER_USER_CONTROL" || code === "BROWSER_WORKSPACE_INACTIVE") && __dshHardStop === null) {
    __dshHardStop = error;
  }
  return error;
}

function __dshEgoCode(error) {
  if (!error || typeof error !== "object") return undefined;
  if (typeof error.error_code === "string") return error.error_code;
  if (typeof error.code === "string") return error.code;
  const message = typeof error.message === "string" ? error.message : "";
  if (/user control|user is controlling/i.test(message)) return "EGO_TASK_SPACE_USER_IN_CONTROL";
  if (/task space.*(?:inactive|not found|not selected|unavailable)/i.test(message)) return "EGO_TASK_SPACE_INACTIVE";
  return undefined;
}

function __dshIsHardStop(error) {
  const code = __dshEgoCode(error);
  return code === "EGO_TASK_SPACE_USER_IN_CONTROL" || code === "EGO_TASK_SPACE_INACTIVE";
}

async function __dshInvoke(operationId, call) {
  if (__dshHardStop !== null) throw __dshHardStop;
  try {
    return await call();
  } catch (error) {
    if (__dshIsHardStop(error) && __dshHardStop === null) __dshHardStop = error;
    if (operationId !== undefined && error && typeof error === "object" && error.operationId === undefined) {
      error.operationId = operationId;
    }
    throw error;
  }
}

function __dshWireError(error) {
  const object = error && typeof error === "object" ? error : {};
  return {
    message: typeof object.message === "string" ? object.message : String(error),
    error_code: __dshEgoCode(object),
    dsh_code: typeof object.dsh_code === "string" ? object.dsh_code : undefined,
    operationId: typeof object.operationId === "string" ? object.operationId : undefined,
  };
}

async function __dshEntrypoint(call) {
  try {
    const result = await call();
    if (__dshHardStop !== null) throw __dshHardStop;
    console.log(__dshFramePrefix + JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.error(__dshFramePrefix + JSON.stringify({ ok: false, error: __dshWireError(error) }));
    throw error;
  }
}

function __dshTaskId(task) {
  if (!task || typeof task.id !== "number" || !Number.isFinite(task.id)) {
    throw __dshError("BROWSER_PROTOCOL", "Ego Lite returned an invalid task-space id");
  }
  return task.id;
}

function __dshWorkspaceId(task) {
  return "ego-lite:" + String(__dshTaskId(task));
}

function __dshNativeWorkspaceId(id) {
  const match = /^ego-lite:(0|[1-9][0-9]*)$/.exec(id);
  if (match === null) {
    throw __dshError("BROWSER_WORKSPACE_INACTIVE", "Ego Lite workspace id is invalid or belongs to another Provider");
  }
  return Number(match[1]);
}

function __dshControl(task) {
  if (__dshUsesFacadeApi) return task.ownership === "agent" ? "agent" : "user";
  return task.ownership === "user" || task.ownership === "agentDelegatedToUser" ? "user" : "agent";
}

function __dshWorkspaceState() {
  if (__dshWorkspace === null) {
    throw __dshError("BROWSER_PROTOCOL", "Ego Lite did not select a workspace");
  }
  return {
    id: __dshWorkspace.id,
    name: __dshWorkspace.name,
    lifecycle: __dshWorkspace.lifecycle,
    control: __dshWorkspace.control,
  };
}

async function __dshSelectWorkspace(selector) {
  if (selector.kind === "current") {
    throw __dshError("BROWSER_UNSUPPORTED_OPERATION", "Ego Lite cannot identify the current task space through its public helper API");
  }
  let task;
  if (selector.kind === "existing") {
    const id = __dshNativeWorkspaceId(selector.id);
    task = await __dshInvoke(undefined, () => __dshTaskSpaces.useOrCreate(id));
  } else if (selector.kind === "named" && selector.createIfMissing) {
    task = await __dshInvoke(undefined, () => __dshTaskSpaces.useOrCreate(selector.name));
  } else if (selector.kind === "named") {
    const spaces = await __dshInvoke(undefined, () => __dshTaskSpaces.list());
    const found = spaces.find((entry) => entry.name === selector.name);
    if (found === undefined) {
      throw __dshError("BROWSER_WORKSPACE_INACTIVE", "Ego Lite task space was not found: " + selector.name);
    }
    task = await __dshInvoke(undefined, () => __dshTaskSpaces.useOrCreate(__dshTaskId(found)));
  } else {
    throw __dshError("BROWSER_PROTOCOL", "Invalid workspace selector");
  }
  __dshWorkspace = {
    id: __dshWorkspaceId(task),
    nativeId: __dshTaskId(task),
    name: typeof task.name === "string" ? task.name : undefined,
    lifecycle: "active",
    control: __dshControl(task),
  };
}

function __dshAssertWorkspaceActive(operation) {
  const state = __dshWorkspaceState();
  if (state.lifecycle !== "active") {
    throw __dshError("BROWSER_WORKSPACE_INACTIVE", "Ego Lite task space is inactive", operation.id);
  }
  const waitForControl = operation.kind === "wait" && operation.condition.kind === "control";
  if (state.control === "user" && operation.kind !== "takeover" && operation.kind !== "handoff" && !waitForControl) {
    throw __dshError("BROWSER_USER_CONTROL", "The user controls this Ego Lite task space", operation.id);
  }
}

function __dshTimeout(operation, limits) {
  return operation.timeoutMs === undefined ? limits.operationTimeoutMs : operation.timeoutMs;
}

function __dshLoadState(state) {
  if (state === "dom-content-loaded") return "domcontentloaded";
  if (state === "network-idle") return "networkidle";
  return "load";
}

function __dshLocator(spec) {
  if (!__dshUsesFacadeApi) return __dshLegacyLocator(spec);
  let locator;
  if (spec.kind === "css") locator = __dshPage.locator(spec.selector);
  else if (spec.kind === "role") {
    const options = {};
    if (spec.name !== undefined) options.name = spec.name;
    if (spec.exact !== undefined) options.exact = spec.exact;
    locator = __dshPage.getByRole(spec.role, options);
  }
  else if (spec.kind === "text") locator = __dshPage.getByText(spec.text, { exact: spec.exact });
  else if (spec.kind === "label") locator = __dshPage.getByLabel(spec.label, { exact: spec.exact });
  else if (spec.kind === "placeholder") locator = __dshPage.getByPlaceholder(spec.placeholder, { exact: spec.exact });
  else if (spec.kind === "test-id") locator = __dshPage.getByTestId(spec.testId);
  else throw __dshError("BROWSER_PROTOCOL", "Unknown browser locator kind");
  return spec.index === undefined ? locator : locator.nth(spec.index);
}

function __dshLegacyQueryExpression(spec, mode, extra) {
  return "(() => {"
    + "const spec=" + JSON.stringify(spec) + ";"
    + "const mode=" + JSON.stringify(mode) + ";"
    + "const extra=" + JSON.stringify(extra) + ";"
    + "const norm=(value)=>String(value??'').replace(/\\s+/g,' ').trim();"
    + "const matchesText=(actual,wanted,exact)=>exact?norm(actual)===norm(wanted):norm(actual).includes(norm(wanted));"
    + "const implicitRole=(el)=>{const tag=el.tagName.toLowerCase();const type=String(el.getAttribute('type')||'').toLowerCase();"
    + "if(tag==='button'||(tag==='input'&&['button','submit','reset','image'].includes(type)))return 'button';"
    + "if(tag==='a'&&el.hasAttribute('href'))return 'link';if(tag==='img')return 'img';"
    + "if(tag==='select')return el.multiple?'listbox':'combobox';if(tag==='textarea')return 'textbox';"
    + "if(tag==='input'){if(type==='checkbox')return 'checkbox';if(type==='radio')return 'radio';if(type==='range')return 'slider';return 'textbox';}"
    + "if(/^h[1-6]$/.test(tag))return 'heading';return '';};"
    + "const accessibleName=(el)=>{const labelled=el.getAttribute('aria-labelledby');"
    + "if(labelled){const text=labelled.split(/\\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ');if(norm(text))return norm(text);}"
    + "const labels=el.labels?Array.from(el.labels).map(label=>label.innerText||label.textContent||'').join(' '):'';"
    + "return norm(el.getAttribute('aria-label')||labels||el.getAttribute('alt')||el.getAttribute('title')||el.value||el.innerText||el.textContent);};"
    + "const all=Array.from(document.querySelectorAll('*'));let matches=[];"
    + "if(spec.kind==='css')matches=Array.from(document.querySelectorAll(spec.selector));"
    + "else if(spec.kind==='role')matches=all.filter(el=>(el.getAttribute('role')||implicitRole(el))===spec.role&&(spec.name===undefined||matchesText(accessibleName(el),spec.name,spec.exact===true)));"
    + "else if(spec.kind==='text'){matches=all.filter(el=>matchesText(el.innerText||el.textContent,spec.text,spec.exact===true));matches=matches.filter(el=>!Array.from(el.children).some(child=>matchesText(child.innerText||child.textContent,spec.text,spec.exact===true)));}"
    + "else if(spec.kind==='placeholder')matches=all.filter(el=>matchesText(el.getAttribute('placeholder'),spec.placeholder,spec.exact===true));"
    + "else if(spec.kind==='test-id')matches=all.filter(el=>el.getAttribute('data-testid')===spec.testId);"
    + "else if(spec.kind==='label'){matches=all.filter(el=>matchesText(el.getAttribute('aria-label'),spec.label,spec.exact===true));"
    + "for(const label of Array.from(document.querySelectorAll('label'))){if(!matchesText(label.innerText||label.textContent,spec.label,spec.exact===true))continue;const control=label.control||(label.htmlFor?document.getElementById(label.htmlFor):null)||label.querySelector('input,select,textarea,button');if(control&&!matches.includes(control))matches.push(control);}}"
    + "else throw new Error('Unknown browser locator kind');"
    + "if(spec.index!==undefined){const selected=matches[spec.index];matches=selected?[selected]:[];}"
    + "if(mode==='count')return matches.length;if(mode==='hidden'){if(matches.length===0)return true;return matches.every(el=>{const style=getComputedStyle(el);const rect=el.getBoundingClientRect();return style.display==='none'||style.visibility==='hidden'||style.opacity==='0'||rect.width===0||rect.height===0;});}"
    + "if(mode==='visible'){if(matches.length!==1)return false;const el=matches[0];const style=getComputedStyle(el);const rect=el.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&rect.width>0&&rect.height>0;}"
    + "if(matches.length!==1)throw new Error('Locator matched '+matches.length+' elements');const el=matches[0];"
    + "if(mode==='target'){el.setAttribute('data-dsh-browser-target',extra);return '[data-dsh-browser-target='+extra+']';}"
    + "if(mode==='text')return el.innerText??el.textContent??'';if(mode==='value')return 'value'in el?String(el.value):null;if(mode==='html')return el.innerHTML;"
    + "if(mode==='attribute')return el.getAttribute(extra);if(mode==='checked')return Boolean(el.checked);"
    + "if(mode==='set-checked'){el.checked=Boolean(extra);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}"
    + "if(mode==='select'){const values=new Set(extra);for(const option of Array.from(el.options||[]))option.selected=values.has(option.value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}"
    + "throw new Error('Unknown legacy locator mode');})()";
}

function __dshLegacyEvaluate(spec, mode, extra) {
  return __dshPage.evaluate(__dshLegacyQueryExpression(spec, mode, extra));
}

async function __dshWaitForLegacyTarget(spec, timeout) {
  const deadline = Date.now() + Math.max(0, timeout);
  while (Date.now() <= deadline) {
    const count = await __dshLegacyEvaluate(spec, "count");
    if (count === 1) return true;
    if (count > 1) throw new Error("Locator matched " + count + " elements");
    await __dshPage.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  return false;
}

async function __dshWithLegacyTarget(spec, call, timeout = 0) {
  if (!await __dshWaitForLegacyTarget(spec, timeout)) {
    throw __dshError("BROWSER_TIMEOUT", "Ego Lite locator wait timed out");
  }
  const token = "dsh" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const selector = await __dshLegacyEvaluate(spec, "target", token);
  try {
    return await call(selector);
  } finally {
    await __dshPage.evaluate("document.querySelector(" + JSON.stringify(selector) + ")?.removeAttribute('data-dsh-browser-target')");
  }
}

function __dshLegacyLocator(spec) {
  return {
    click: (options = {}) => __dshWithLegacyTarget(spec, selector => click(selector, options), options.timeout),
    fill: (value, options = {}) => __dshWithLegacyTarget(spec, selector => fillInput(selector, value, {
      clearFirst: true,
      timeout: __dshLegacySeconds(options.timeout ?? 0),
    }), options.timeout),
    clear: (options = {}) => __dshWithLegacyTarget(spec, selector => fillInput(selector, "", {
      clearFirst: true,
      timeout: __dshLegacySeconds(options.timeout ?? 0),
    }), options.timeout),
    press: (key, options = {}) => __dshWithLegacyTarget(spec, async selector => {
      await __dshPage.evaluate("document.querySelector(" + JSON.stringify(selector) + ")?.focus()");
      await pressKey(key);
    }, options.timeout),
    setChecked: (checked, options = {}) => __dshWithLegacyTarget(
      spec,
      () => __dshLegacyEvaluate(spec, "set-checked", checked),
      options.timeout,
    ),
    selectOption: (values, options = {}) => __dshWithLegacyTarget(
      spec,
      () => __dshLegacyEvaluate(spec, "select", values),
      options.timeout,
    ),
    innerText: () => __dshLegacyEvaluate(spec, "text"),
    inputValue: () => __dshLegacyEvaluate(spec, "value"),
    innerHTML: () => __dshLegacyEvaluate(spec, "html"),
    getAttribute: name => __dshLegacyEvaluate(spec, "attribute", name),
    count: () => __dshLegacyEvaluate(spec, "count"),
    isHidden: () => __dshLegacyEvaluate(spec, "hidden"),
    waitFor: async (options = {}) => {
      const deadline = Date.now() + (options.timeout ?? 30000);
      while (Date.now() <= deadline) {
        const count = await __dshLegacyEvaluate(spec, "count");
        const visible = count > 0 && await __dshLegacyEvaluate(spec, "visible");
        if ((options.state === "attached" && count > 0) || (options.state === "visible" && visible)) return true;
        await __dshPage.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
      }
      return false;
    },
  };
}

function __dshBindPage(key, targetId) {
  if (__dshPages.has(key)) {
    throw __dshError("BROWSER_PROTOCOL", "Browser page key is already bound: " + key);
  }
  __dshPages.set(key, targetId);
}

async function __dshSelectPage(key, operationId) {
  const targetId = __dshPages.get(key);
  if (targetId === undefined) {
    throw __dshError("BROWSER_PAGE_STALE", "Browser page key is not bound: " + key, operationId);
  }
  await __dshInvoke(operationId, () => __dshBrowser.switchTab(targetId));
  return targetId;
}

async function __dshPageResult(operation, key) {
  const info = await __dshInvoke(operation.id, () => __dshPage.info());
  if (!info || typeof info.url !== "string") {
    throw __dshError("BROWSER_PROTOCOL", "Ego Lite page info returned no URL", operation.id);
  }
  return {
    kind: "page",
    id: operation.id,
    operation: operation.kind,
    page: { page: key, url: info.url, title: typeof info.title === "string" ? info.title : undefined },
  };
}

async function __dshWaitForRequestedLoad(operation, limits) {
  const reached = await __dshInvoke(operation.id, () => __dshPage.waitForLoadState(__dshLoadState(operation.waitUntil), {
    timeout: __dshTimeout(operation, limits),
  }));
  if (!reached) throw __dshError("BROWSER_TIMEOUT", "Ego Lite did not reach the requested load state", operation.id);
}

async function __dshWaitForLocator(operation, limits) {
  const locator = __dshLocator(operation.condition.locator);
  const timeout = __dshTimeout(operation, limits);
  const state = operation.condition.state;
  if (state === "attached" || state === "visible") {
    const reached = await __dshInvoke(operation.id, () => locator.waitFor({ state, timeout }));
    if (!reached) throw __dshError("BROWSER_TIMEOUT", "Ego Lite locator wait timed out", operation.id);
    return;
  }
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const reached = state === "detached"
      ? (await __dshInvoke(operation.id, () => locator.count())) === 0
      : await __dshInvoke(operation.id, () => locator.isHidden());
    if (reached) return;
    await __dshPage.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw __dshError("BROWSER_TIMEOUT", "Ego Lite locator wait timed out", operation.id);
}

async function __dshWaitForControl(operation, limits) {
  const desired = operation.condition.control;
  if (desired === "agent") {
    await __dshInvoke(operation.id, () => __dshTaskSpaces.waitForAgentControl(__dshWorkspace.nativeId, {
      interval: 0.1,
      timeout: __dshTimeout(operation, limits) / 1000,
    }));
    __dshWorkspace.control = "agent";
    return;
  }
  const deadline = Date.now() + __dshTimeout(operation, limits);
  while (Date.now() <= deadline) {
    const spaces = await __dshInvoke(operation.id, () => __dshTaskSpaces.list());
    const current = spaces.find((entry) => __dshTaskId(entry) === __dshWorkspace.nativeId);
    if (current === undefined) {
      throw __dshError("BROWSER_WORKSPACE_INACTIVE", "Ego Lite task space became inactive", operation.id);
    }
    if (__dshControl(current) === "user") {
      __dshWorkspace.control = "user";
      return;
    }
    await __dshPage.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw __dshError("BROWSER_TIMEOUT", "Ego Lite control wait timed out", operation.id);
}

async function __dshRunOperation(operation, limits) {
  __dshAssertWorkspaceActive(operation);
  if (operation.kind === "open") {
    if (operation.reuse !== "exact-url") {
      throw __dshError("BROWSER_UNSUPPORTED_OPERATION", "Ego Lite v1.2.5 public helpers cannot guarantee opening a new tab without reuse", operation.id);
    }
    const tab = await __dshInvoke(operation.id, () => __dshBrowser.openOrReuseTab(operation.url, {
      match: "exact",
      wait: false,
    }));
    await __dshInvoke(operation.id, () => __dshBrowser.switchTab(tab.targetId));
    __dshBindPage(operation.page, tab.targetId);
    await __dshWaitForRequestedLoad(operation, limits);
    return __dshPageResult(operation, operation.page);
  }
  if (operation.kind === "select-page") {
    const tabs = await __dshInvoke(operation.id, () => __dshBrowser.listTabs({ includeChrome: false }));
    const found = tabs.find((tab) => operation.match.kind === "exact-url"
      ? tab.url === operation.match.url
      : tab.url.startsWith(operation.match.prefix));
    if (found === undefined) {
      throw __dshError("BROWSER_PAGE_STALE", "Ego Lite could not find a matching page", operation.id);
    }
    await __dshInvoke(operation.id, () => __dshBrowser.switchTab(found.targetId));
    __dshBindPage(operation.page, found.targetId);
    return __dshPageResult(operation, operation.page);
  }
  if (operation.kind === "close-page") {
    const targetId = await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshBrowser.closeTab(targetId));
    __dshPages.delete(operation.page);
    return { kind: "done", id: operation.id, operation: "close-page" };
  }
  if (operation.kind === "navigate") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshPage.goto(operation.url, {
      waitUntil: "commit",
      timeout: __dshTimeout(operation, limits),
    }));
    await __dshWaitForRequestedLoad(operation, limits);
    return __dshPageResult(operation, operation.page);
  }
  if (operation.kind === "reload") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshPage.reload({
      waitUntil: "commit",
      timeout: __dshTimeout(operation, limits),
    }));
    await __dshWaitForRequestedLoad(operation, limits);
    return __dshPageResult(operation, operation.page);
  }
  if (operation.kind === "pages") {
    throw __dshError("BROWSER_UNSUPPORTED_OPERATION", "Ego Lite target ids cannot be exported as portable Consumer-minted page keys", operation.id);
  }
  if (operation.kind === "page-info") {
    await __dshSelectPage(operation.page, operation.id);
    return __dshPageResult(operation, operation.page);
  }
  if (operation.kind === "snapshot") {
    await __dshSelectPage(operation.page, operation.id);
    const content = await __dshInvoke(operation.id, () => __dshPage.snapshot());
    return { kind: "snapshot", id: operation.id, content };
  }
  if (operation.kind === "screenshot") {
    await __dshSelectPage(operation.page, operation.id);
    const path = await __dshInvoke(operation.id, () => __dshPage.screenshot({ fullPage: operation.fullPage, raw: true }));
    const files = process.getBuiltinModule("node:fs/promises");
    let bytes;
    try {
      bytes = await files.readFile(path);
    } finally {
      await files.unlink(path);
    }
    return { kind: "screenshot", id: operation.id, mediaType: "image/png", base64: bytes.toString("base64") };
  }
  if (operation.kind === "click") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshLocator(operation.locator).click({ timeout: __dshTimeout(operation, limits) }));
    return { kind: "done", id: operation.id, operation: "click" };
  }
  if (operation.kind === "fill") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshLocator(operation.locator).fill(operation.value, { timeout: __dshTimeout(operation, limits) }));
    return { kind: "done", id: operation.id, operation: "fill" };
  }
  if (operation.kind === "clear") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshLocator(operation.locator).clear({ timeout: __dshTimeout(operation, limits) }));
    return { kind: "done", id: operation.id, operation: "clear" };
  }
  if (operation.kind === "press") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshLocator(operation.locator).press(operation.key, { timeout: __dshTimeout(operation, limits) }));
    return { kind: "done", id: operation.id, operation: "press" };
  }
  if (operation.kind === "check") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshLocator(operation.locator).setChecked(operation.checked, { timeout: __dshTimeout(operation, limits) }));
    return { kind: "done", id: operation.id, operation: "check" };
  }
  if (operation.kind === "select") {
    await __dshSelectPage(operation.page, operation.id);
    await __dshInvoke(operation.id, () => __dshLocator(operation.locator).selectOption(operation.values, { timeout: __dshTimeout(operation, limits) }));
    return { kind: "done", id: operation.id, operation: "select" };
  }
  if (operation.kind === "read") {
    await __dshSelectPage(operation.page, operation.id);
    const locator = __dshLocator(operation.locator);
    let value;
    if (operation.target.kind === "text") value = await __dshInvoke(operation.id, () => locator.innerText());
    else if (operation.target.kind === "value") value = await __dshInvoke(operation.id, () => locator.inputValue());
    else if (operation.target.kind === "html") value = await __dshInvoke(operation.id, () => locator.innerHTML());
    else value = await __dshInvoke(operation.id, () => locator.getAttribute(operation.target.name));
    return { kind: "read", id: operation.id, value };
  }
  if (operation.kind === "count") {
    await __dshSelectPage(operation.page, operation.id);
    const count = await __dshInvoke(operation.id, () => __dshLocator(operation.locator).count());
    return { kind: "count", id: operation.id, count };
  }
  if (operation.kind === "wait") {
    if (operation.condition.kind === "control") {
      await __dshWaitForControl(operation, limits);
    } else if (operation.condition.kind === "load") {
      await __dshSelectPage(operation.condition.page, operation.id);
      const reached = await __dshInvoke(operation.id, () => __dshPage.waitForLoadState(__dshLoadState(operation.condition.state), {
        timeout: __dshTimeout(operation, limits),
      }));
      if (!reached) throw __dshError("BROWSER_TIMEOUT", "Ego Lite load wait timed out", operation.id);
    } else if (operation.condition.kind === "url") {
      await __dshSelectPage(operation.condition.page, operation.id);
      const match = operation.condition.match;
      const reached = await __dshInvoke(operation.id, () => __dshPage.waitForURL((url) => match.kind === "exact-url"
        ? url.href === match.url
        : url.href.startsWith(match.prefix), {
        timeout: __dshTimeout(operation, limits),
        waitUntil: "commit",
      }));
      if (!reached) throw __dshError("BROWSER_TIMEOUT", "Ego Lite URL wait timed out", operation.id);
    } else {
      await __dshSelectPage(operation.condition.page, operation.id);
      await __dshWaitForLocator(operation, limits);
    }
    return { kind: "done", id: operation.id, operation: "wait" };
  }
  if (operation.kind === "handoff") {
    if (__dshWorkspace.control === "agent") {
      const handed = await __dshInvoke(operation.id, () => __dshTaskSpaces.handOff(__dshWorkspace.nativeId));
      if (!handed.done) throw __dshError("BROWSER_USER_CONTROL", "Ego Lite did not hand off the task space", operation.id);
    }
    __dshWorkspace.control = "user";
    return { kind: "control", id: operation.id, operation: "handoff", control: "user" };
  }
  if (operation.kind === "takeover") {
    await __dshInvoke(operation.id, () => __dshTaskSpaces.takeOver(__dshWorkspace.nativeId));
    __dshWorkspace.control = "agent";
    return { kind: "control", id: operation.id, operation: "takeover", control: "agent" };
  }
  if (operation.kind === "complete") {
    const completed = await __dshInvoke(operation.id, () => __dshTaskSpaces.complete(__dshWorkspace.nativeId, { keep: operation.keep }));
    if (!completed.done) throw __dshError("BROWSER_USER_CONTROL", "Ego Lite did not complete the task space", operation.id);
    __dshWorkspace.lifecycle = "completed";
    __dshWorkspace.control = operation.keep ? "user" : "agent";
    return { kind: "done", id: operation.id, operation: "complete" };
  }
  throw __dshError("BROWSER_UNSUPPORTED_OPERATION", "Unknown portable browser operation", operation.id);
}

async function __dshRunPlan(plan, limits) {
  await __dshSelectWorkspace(plan.workspace);
  const operations = [];
  for (const operation of plan.operations) operations.push(await __dshRunOperation(operation, limits));
  return { version: 1, workspace: __dshWorkspaceState(), operations };
}

function __dshTextOutput(value, maxCharacters) {
  if (typeof value !== "string") throw __dshError("BROWSER_PROTOCOL", "browser-js-v1 text output must be a string");
  const segments = Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value), (entry) => entry.segment);
  return {
    kind: "text",
    value: segments.slice(0, maxCharacters).join(""),
    truncated: segments.length > maxCharacters,
  };
}

function __dshAssertJsonValue(value) {
  const pending = [value];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (Array.isArray(current)) {
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...current);
      continue;
    }
    if (typeof current === "object") {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw __dshError("BROWSER_PROTOCOL", "browser-js-v1 returned non-JSON data");
      }
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...Object.values(current));
      continue;
    }
    throw __dshError("BROWSER_PROTOCOL", "browser-js-v1 returned non-JSON data");
  }
}

function __dshJsonOutput(value, maxBytes) {
  __dshAssertJsonValue(value);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw __dshError("BROWSER_PROTOCOL", "browser-js-v1 returned non-JSON data");
  }
  if (encoded === undefined) throw __dshError("BROWSER_PROTOCOL", "browser-js-v1 returned non-JSON data");
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw __dshError("BROWSER_OUTPUT_LIMIT", "browser-js-v1 JSON output exceeded its declared bound");
  }
  return { kind: "json", value };
}

async function __dshRunProgram(program, limits) {
  await __dshSelectWorkspace(program.workspace);
  const api = {
    run: (operation) => __dshRunOperation(operation, limits),
    evaluate: async (pageKey, functionExpression, argument) => {
      await __dshSelectPage(pageKey);
      if (argument !== undefined) __dshAssertJsonValue(argument);
      const encodedArgument = argument === undefined ? "undefined" : JSON.stringify(argument);
      const expression = "(" + functionExpression + ")(" + encodedArgument + ")";
      const result = await __dshInvoke(undefined, () => __dshPage.evaluate(expression));
      __dshAssertJsonValue(result);
      return result;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("browser", "\"use strict\";\n" + program.source);
  const value = await execute(api);
  if (__dshHardStop !== null) throw __dshHardStop;
  let output;
  if (program.output.kind === "none") output = { kind: "none" };
  else if (program.output.kind === "text") output = __dshTextOutput(value, program.output.maxCharacters);
  else output = __dshJsonOutput(value, program.output.maxBytes);
  return { version: 1, workspace: __dshWorkspaceState(), output };
}
`

/**
 * Reject plan members that Ego Lite cannot translate without weakening
 * their public semantics.
 * @param plan - typed plan to inspect before any process starts.
 */
export function assertEgoLitePlanSupported(plan: BrowserRunPlanV1): void {
  if (plan.workspace.kind === 'current') {
    throw new BrowserError(
      'Ego Lite cannot identify the current task space through its public helper API',
      'BROWSER_UNSUPPORTED_OPERATION',
    )
  }
  for (const operation of plan.operations) {
    if (operation.kind === 'open' && operation.reuse === 'never') {
      throw new BrowserError(
        'Ego Lite cannot guarantee opening a new tab without reuse',
        'BROWSER_UNSUPPORTED_OPERATION',
        { operationId: operation.id },
      )
    }
    if (operation.kind === 'pages') {
      throw new BrowserError(
        'Ego Lite target ids cannot be exported as portable Consumer-minted page keys',
        'BROWSER_UNSUPPORTED_OPERATION',
        { operationId: operation.id },
      )
    }
  }
}

/**
 * Build the complete JavaScript program sent as one Ego Lite stdin payload.
 * JSON string literals isolate all typed values from the generated program.
 * @param plan - portable plan interpreted inside the Ego Lite process.
 * @param limits - Provider-owned execution defaults.
 * @returns one complete JavaScript program for stdin.
 */
export function buildEgoLitePlanSource(
  plan: BrowserRunPlanV1,
  limits: EgoLiteSourceLimits,
): string {
  assertEgoLitePlanSupported(plan)
  return `${EGO_LITE_RUNNER}\nawait __dshEntrypoint(() => __dshRunPlan(${serialized(plan)}, ${serialized(limits)}));\n`
}

/**
 * Build one trusted-plugin `browser-js-v1` program. Ego Lite executes the
 * resulting heredoc in Node; this adapter preserves that executable surface
 * and does not claim to sandbox the source.
 * @param program - trusted plugin source plus workspace and output contract.
 * @param limits - Provider-owned execution defaults.
 * @returns one complete JavaScript program for stdin.
 */
export function buildEgoLiteProgramSource(
  program: BrowserRunProgramV1,
  limits: EgoLiteSourceLimits,
): string {
  if (program.workspace.kind === 'current') {
    throw new BrowserError(
      'Ego Lite cannot identify the current task space through its public helper API',
      'BROWSER_UNSUPPORTED_OPERATION',
    )
  }
  return `${EGO_LITE_RUNNER}\nawait __dshEntrypoint(() => __dshRunProgram(${serialized(program)}, ${serialized(limits)}));\n`
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}
