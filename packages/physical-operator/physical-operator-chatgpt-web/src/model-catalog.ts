/**
 * Browser-backed discovery and explicit application of visible ChatGPT model
 * controls. The page DOM is the only source of account availability.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/model-catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BrowserCapabilityV1, BrowserJsonValue, BrowserRunProgramV1 } from '@deepseek-ai/dsh-browser'

const MIN_OUTPUT_MAX_BYTES = 1_024
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_OPTION_LENGTH = 256
const MAX_OPTIONS = 64

/** Browser capabilities required to inspect the authenticated ChatGPT page. */
export const WEB_MODEL_CATALOG_CAPABILITIES: readonly BrowserCapabilityV1[] = Object.freeze([
  'authenticated-profile-reuse',
  'named-workspace',
  'page-evaluate',
])

/** One exact visible option from a native ChatGPT picker. */
export interface WebModelChoice {
  /** Opaque native option identifier when the page exposes one, otherwise its visible label. */
  readonly id: string
  /** Exact normalized text currently visible to the account in the picker. */
  readonly label: string
}

/** Explicit user-authorized ChatGPT controls to apply in the owned browser page. */
export interface WebModelPreferences {
  /** Exact advertised model identifier or label. */
  readonly model?: string
  /** Exact advertised opaque reasoning option identifier or label. */
  readonly effort?: string
}

/** The currently observable ChatGPT model controls for one owned browser page. */
export interface WebModelCatalog {
  /** Account-available visible model choices. */
  readonly models: readonly WebModelChoice[]
  /** Visible reasoning choices for the selected model, or empty when no reasoning menu exists. */
  readonly efforts: readonly WebModelChoice[]
  /** Verified selected model identifier when the page exposes enough state to prove it. */
  readonly selectedModel?: string
  /** Verified selected opaque reasoning option identifier when the page exposes enough state to prove it. */
  readonly selectedEffort?: string
  /** ISO timestamp captured after the page controls were observed. */
  readonly observedAt: string
}

/** Inputs for one bounded account-model discovery program. */
export interface DiscoverWebModelsOptions {
  /** Named browser workspace that owns the authenticated ChatGPT page. */
  readonly workspaceName: string
  /** ChatGPT URL whose origin defines the reusable owned page. */
  readonly url: string
  /** Delay between DOM checks while a native picker animates or mounts. */
  readonly pollIntervalMs: number
  /** Upper bound for one native picker interaction. */
  readonly timeoutMs: number
  /** Maximum UTF-8 JSON result size accepted from the browser Provider. */
  readonly outputMaxBytes: number
  /** Omit for read-only discovery; pass only after the user explicitly authorizes selection. */
  readonly selection?: WebModelPreferences
}

interface NormalizedDiscoverWebModelsOptions extends DiscoverWebModelsOptions {
  /** Root page opened only when no existing owned ChatGPT page can be selected. */
  readonly url: string
}

const MODEL_CATALOG_EVALUATOR = String.raw`async (input) => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { status: 'protocol-error' };
  const request = input;
  if (typeof request.pollIntervalMs !== 'number' || typeof request.timeoutMs !== 'number') {
    return { status: 'protocol-error' };
  }
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const inactive = (element) => {
    let current = element;
    while (current !== null) {
      if (current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return true;
      current = current.parentElement;
    }
    return false;
  };
  const visible = (element) => {
    if (element === null || inactive(element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const enabled = (element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const has = (element, names) => names.some((name) => element.hasAttribute(name));
  const lower = (value) => normalize(value).toLocaleLowerCase();
  const text = (element) => element === null ? '' : normalize(
    element.getAttribute('data-model-label')
      ?? element.getAttribute('data-effort-label')
      ?? element.textContent
      ?? element.getAttribute('aria-label')
      ?? element.getAttribute('title'),
  );
  const strictText = (value) => typeof value === 'string' && value.length > 0
    && value.length <= ${MAX_OPTION_LENGTH} && value.trim() === value ? value : undefined;
  const valueFrom = (element, names) => {
    if (element === null) return undefined;
    for (const name of names) {
      const value = normalize(element.getAttribute(name));
      if (value.length > 0 && value.length <= ${MAX_OPTION_LENGTH}) return value;
    }
    return undefined;
  };
  const modelSpecificNames = ['data-model-id', 'data-model', 'data-model-slug'];
  const effortSpecificNames = ['data-reasoning-effort', 'data-effort', 'data-thinking-effort', 'data-power'];
  const modelNames = [...modelSpecificNames, 'data-value', 'value'];
  const effortNames = [...effortSpecificNames, 'data-value', 'value'];
  const semanticNames = (kind) => kind === 'model' ? modelNames : effortNames;
  const otherSemanticNames = (kind) => kind === 'model' ? effortSpecificNames : modelSpecificNames;
  const genericRole = (element) => ['menuitemradio', 'option', 'menuitem'].includes(element.getAttribute('role'));
  const testIdMatches = (element, kind) => {
    const value = lower(element.getAttribute('data-testid'));
    return kind === 'model'
      ? /(?:model|intelligence)/.test(value)
      : /(?:reasoning|effort|thinking|power)/.test(value);
  };
  const optionInfo = (element, kind) => {
    const label = text(element);
    const id = valueFrom(element, semanticNames(kind));
    if (label.length === 0 || label.length > ${MAX_OPTION_LENGTH}) return { error: true };
    return { id: id ?? label, label };
  };
  const optionCandidates = (root, kind) => {
    const selector = kind === 'model'
      ? '[data-model-id],[data-model],[data-model-slug],[data-testid*="model"],[data-testid*="intelligence"],[role="menuitemradio"],[role="option"],[role="menuitem"],button'
      : '[data-reasoning-effort],[data-effort],[data-thinking-effort],[data-power],[data-testid*="reason"],[data-testid*="effort"],[data-testid*="thinking"],[data-testid*="power"],[role="menuitemradio"],[role="option"],[role="menuitem"],button';
    const candidates = [...root.querySelectorAll(selector)].filter((element) => visible(element) && enabled(element))
      .filter((element) => !has(element, otherSemanticNames(kind)))
      .filter((element) => has(element, semanticNames(kind)) || testIdMatches(element, kind) || genericRole(element));
    return candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
  };
  const optionsFrom = (root, kind) => {
    const choices = [];
    const nodes = [];
    const ids = new Set();
    for (const element of optionCandidates(root, kind)) {
      const option = optionInfo(element, kind);
      if (option.error || ids.has(option.id)) return { error: 'invalid' };
      ids.add(option.id);
      choices.push(option);
      nodes.push(element);
      if (choices.length > ${MAX_OPTIONS}) return { error: 'too-many' };
    }
    return { choices, nodes };
  };
  const unique = (elements) => [...new Set(elements)];
  const controls = (element) => normalize(element.getAttribute('aria-controls')).split(' ').filter(Boolean);
  const labelledBy = (element) => normalize(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
  const isAssociated = (trigger, root) => {
    const ids = [root.id, ...[...root.querySelectorAll('[id]')].map((element) => element.id)].filter(Boolean);
    return controls(trigger).some((id) => ids.includes(id))
      || trigger.id.length > 0 && labelledBy(root).includes(trigger.id);
  };
  const menuContainers = () => unique([
    ...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]'),
  ]).filter(visible);
  const activeModelViews = (root) => unique([
    ...(root.matches('[data-model-picker-view]') ? [root] : []),
    ...root.querySelectorAll('[data-model-picker-view]'),
  ]).filter(visible);
  const activeModelView = (root) => {
    const views = activeModelViews(root);
    return views.length === 1 ? views[0] : null;
  };
  const modelViewName = (view) => strictText(view?.getAttribute('data-model-picker-view'));
  const modelPickerRoot = (trigger) => {
    const roots = menuContainers().filter((root) => {
      const view = activeModelView(root);
      return view !== null || isAssociated(trigger, root) && optionsFrom(root, 'model').choices.length > 0;
    });
    return roots.length === 1 ? roots[0] : null;
  };
  const legacyPickerRoot = (kind, trigger) => {
    const roots = menuContainers().filter((root) => isAssociated(trigger, root) && optionsFrom(root, kind).choices.length > 0);
    return roots.length === 1 ? roots[0] : null;
  };
  const triggerFor = (kind, excluded) => {
    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter((element) => visible(element) && enabled(element) && element !== excluded)
      .filter((element) => {
        const description = lower([
          element.getAttribute('data-testid'), element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent,
        ].join(' '));
        return kind === 'model'
          ? /(?:model|intelligence|模型)/.test(description)
          : /(?:reasoning|effort|thinking|think|power|推理|思考)/.test(description);
      });
    // Sidebar chat and project titles can contain the same words, and clicking
    // one navigates, so only a unique menu-opening control outside navigation
    // is a picker.
    const pickers = candidates.filter((element) => element.hasAttribute('aria-haspopup') && element.closest('nav,aside') === null);
    return pickers.length === 1 ? pickers[0] : null;
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, request.pollIntervalMs));
  const waitFor = async (read) => {
    const deadline = Date.now() + request.timeoutMs;
    while (Date.now() <= deadline) {
      const value = read();
      if (value !== null && value !== undefined) return value;
      await pause();
    }
    return null;
  };
  const menuEntries = [];
  const open = async (rootFor, trigger) => {
    if (trigger === null) return undefined;
    const existing = rootFor(trigger);
    if (existing !== null) {
      const entry = { root: existing, trigger, owned: false, closed: false, initialView: undefined, viewChanged: false, rootFor };
      menuEntries.push(entry);
      return entry;
    }
    trigger.click();
    const root = await waitFor(() => rootFor(trigger));
    if (root === null) return undefined;
    const entry = { root, trigger, owned: true, closed: false, initialView: undefined, viewChanged: false, rootFor };
    menuEntries.push(entry);
    return entry;
  };
  const ensureOpen = async (menu) => {
    if (menu.root.isConnected && visible(menu.root)) return true;
    menu.trigger.click();
    const root = await waitFor(() => menu.rootFor(menu.trigger));
    if (root === null) return false;
    menu.root = root;
    menu.owned = true;
    menu.closed = false;
    return true;
  };
  const activeViewFor = (menu) => {
    const view = activeModelView(menu.root);
    const name = modelViewName(view);
    return view === null || name === undefined ? undefined : { view, name };
  };
  const viewToggle = (menu) => {
    const current = activeViewFor(menu);
    if (current === undefined) return null;
    const candidates = [...current.view.querySelectorAll('[data-model-picker-view-toggle="true"][role="menuitem"]')]
      .filter((element) => visible(element) && enabled(element));
    return candidates.length === 1 ? candidates[0] : null;
  };
  const switchView = async (menu, expected) => {
    const current = activeViewFor(menu);
    if (current === undefined) return false;
    if (menu.initialView === undefined) menu.initialView = current.name;
    if (current.name === expected) return true;
    const toggle = viewToggle(menu);
    if (toggle === null) return false;
    toggle.click();
    const changed = await waitFor(() => activeViewFor(menu)?.name === expected ? true : null);
    if (changed === true) menu.viewChanged = true;
    return changed === true;
  };
  const restoreView = async (menu) => {
    if (menu.initialView === undefined || !menu.viewChanged) return true;
    if (!await ensureOpen(menu)) return false;
    const restored = await switchView(menu, menu.initialView);
    if (restored) menu.viewChanged = false;
    return restored;
  };
  const close = async (menu) => {
    if (menu === undefined || menu.closed) return true;
    // Restoring the initial view is best effort: current ChatGPT pickers have
    // no control back from the advanced view, and closing is what matters.
    await restoreView(menu);
    if (!menu.owned || !menu.root.isConnected || !visible(menu.root)) {
      menu.closed = true;
      return true;
    }
    menu.root.focus?.();
    menu.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    let closed = await waitFor(() => !menu.root.isConnected || !visible(menu.root) ? true : null);
    if (closed === null && menu.trigger.getAttribute('aria-expanded') === 'true') {
      menu.trigger.click();
      closed = await waitFor(() => !menu.root.isConnected || !visible(menu.root) ? true : null);
    }
    menu.closed = closed === true;
    return menu.closed;
  };
  const selectedFrom = (choices, nodes, trigger) => {
    const checked = choices.filter((_choice, index) => {
      const node = nodes[index];
      return node.getAttribute('aria-checked') === 'true'
        || node.getAttribute('aria-selected') === 'true'
        || node.getAttribute('data-state') === 'checked';
    });
    if (checked.length === 1) return checked[0].id;
    const values = [
      valueFrom(trigger, modelNames), valueFrom(trigger, effortNames), text(trigger),
    ].filter((value) => value !== undefined);
    const matches = choices.filter((choice) => values.some((value) => value === choice.id || value === choice.label));
    return matches.length === 1 ? matches[0].id : undefined;
  };
  const exact = (choices, requested) => {
    const matches = choices.filter((choice) => choice.id === requested || choice.label === requested);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const choose = async (requested, choices, nodes, trigger) => {
    const choice = exact(choices, requested);
    if (choice === undefined) return undefined;
    const index = choices.indexOf(choice);
    nodes[index].click();
    const selected = await waitFor(() => selectedFrom(choices, nodes, trigger) === choice.id ? choice.id : null);
    return selected === choice.id ? choice : undefined;
  };
  const modelLabel = (row) => {
    const direct = [...row.children].filter((element) => element.tagName === 'SPAN').map(text).find(Boolean);
    const nested = [...row.querySelectorAll('span')].map(text).find(Boolean);
    const label = direct ?? nested ?? text(row);
    return label.length > 0 && label.length <= ${MAX_OPTION_LENGTH} ? label : undefined;
  };
  const liveModels = async (menu) => {
    if (!await ensureOpen(menu) || !await switchView(menu, 'advanced')) return { error: 'unavailable' };
    const view = activeViewFor(menu)?.view;
    if (view === undefined) return { error: 'unavailable' };
    const rows = [...view.querySelectorAll('[role="menuitemradio"]')]
      .filter((element) => visible(element) && enabled(element)
        && element.getAttribute('data-model-picker-view-toggle') !== 'true');
    const choices = [];
    const nodes = [];
    const ids = new Set();
    for (const row of rows) {
      const label = modelLabel(row);
      const id = valueFrom(row, modelNames) ?? label;
      if (label === undefined || id === undefined || ids.has(id)) return { error: 'invalid' };
      ids.add(id);
      choices.push({ id, label });
      nodes.push(row);
      if (choices.length > ${MAX_OPTIONS}) return { error: 'too-many' };
    }
    if (choices.length === 0) return { error: 'unavailable' };
    const checked = choices.filter((_choice, index) => nodes[index].getAttribute('aria-checked') === 'true');
    if (checked.length > 1) return { error: 'invalid' };
    return { choices, nodes, selected: checked[0]?.id };
  };
  const chooseLiveModel = async (menu, requested) => {
    let read = await liveModels(menu);
    if (read.error !== undefined) return undefined;
    const choice = exact(read.choices, requested);
    if (choice === undefined) return undefined;
    if (read.selected === choice.id) return choice;
    read.nodes[read.choices.indexOf(choice)].click();
    const beforeClose = await waitFor(() => {
      if (!visible(menu.root)) return null;
      const view = activeViewFor(menu);
      if (view?.name !== 'advanced') return null;
      const rows = [...view.view.querySelectorAll('[role="menuitemradio"]')].filter((element) => visible(element));
      return rows.some((row) => (valueFrom(row, modelNames) ?? modelLabel(row)) === choice.id
        && row.getAttribute('aria-checked') === 'true') ? true : null;
    });
    if (beforeClose === true) return choice;
    read = await liveModels(menu);
    return read.error === undefined && read.selected === choice.id ? choice : undefined;
  };
  const own = (value, name) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, name) ? value[name] : undefined;
  const reactSliderData = (owner) => {
    const keys = Object.keys(owner).filter((name) => name.startsWith('__reactProps$'));
    if (keys.length !== 1) return undefined;
    const first = own(owner, keys[0]);
    const second = own(first, 'children');
    const third = own(second, 'props');
    const fourth = own(third, 'children');
    const props = own(fourth, 'props');
    const options = own(props, 'options');
    const selectedOptionId = own(props, 'selectedOptionId');
    if (!Array.isArray(options) || options.length === 0 || options.length > ${MAX_OPTIONS} || strictText(selectedOptionId) === undefined) return undefined;
    const seen = new Set();
    const raw = [];
    for (const option of options) {
      const id = strictText(own(option, 'id'));
      const label = strictText(own(option, 'label'));
      const isLocked = own(option, 'isLocked');
      const isMax = own(option, 'isMax');
      const requiresExplicitSelection = own(option, 'requiresExplicitSelection');
      if (id === undefined || label === undefined || typeof isLocked !== 'boolean' || typeof isMax !== 'boolean'
        || typeof requiresExplicitSelection !== 'boolean' || seen.has(id)) return undefined;
      seen.add(id);
      raw.push({ id, label, isLocked });
    }
    return { raw, selectedOptionId };
  };
  const ariaIndex = (element, name) => {
    const value = element.getAttribute(name);
    return value === null || !/^(?:0|[1-9][0-9]*)$/.test(value) ? undefined : Number(value);
  };
  const liveReasoning = (root) => {
    const owners = [...root.querySelectorAll('[data-reasoning-slider="true"][role="menuitem"]')]
      .filter((element) => visible(element) && enabled(element));
    if (owners.length === 0) return { kind: 'absent' };
    if (owners.length !== 1) return { kind: 'invalid' };
    const owner = owners[0];
    const keys = normalize(owner.getAttribute('aria-keyshortcuts')).split(' ').filter(Boolean);
    const sliders = [...owner.querySelectorAll('[role="slider"]')];
    if (!keys.includes('ArrowLeft') || !keys.includes('ArrowRight') || sliders.length !== 1) return { kind: 'invalid' };
    const metadata = reactSliderData(owner);
    const minimum = ariaIndex(sliders[0], 'aria-valuemin');
    const maximum = ariaIndex(sliders[0], 'aria-valuemax');
    const now = ariaIndex(sliders[0], 'aria-valuenow');
    if (metadata === undefined || minimum !== 0 || maximum !== metadata.raw.length - 1 || now === undefined
      || now < minimum || now > maximum || metadata.raw[now]?.id !== metadata.selectedOptionId
      || metadata.raw[now]?.isLocked) return { kind: 'invalid' };
    const choices = metadata.raw.filter((option) => !option.isLocked).map(({ id, label }) => ({ id, label }));
    if (choices.length === 0) return { kind: 'invalid' };
    return { kind: 'ok', owner, raw: metadata.raw, choices, selected: metadata.selectedOptionId, now };
  };
  const chooseLiveEffort = async (menu, requested) => {
    let state = liveReasoning(menu.root);
    if (state.kind !== 'ok') return undefined;
    const choice = exact(state.choices, requested);
    if (choice === undefined) return undefined;
    const target = state.raw.findIndex((option) => option.id === choice.id);
    if (target < 0) return undefined;
    while (state.now !== target) {
      const direction = target > state.now ? 1 : -1;
      const expected = state.now + direction;
      if (state.raw[expected]?.isLocked) return undefined;
      const key = direction > 0 ? 'ArrowRight' : 'ArrowLeft';
      state.owner.focus?.();
      state.owner.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
      const after = await waitFor(() => {
        const next = liveReasoning(menu.root);
        return next.kind === 'ok' && next.now === expected && next.selected === state.raw[expected].id ? next : null;
      });
      if (after === null) return undefined;
      state = after;
    }
    return state.selected === choice.id ? choice : undefined;
  };
  const loginRequired = () => [...document.querySelectorAll('button,a')].filter(visible).some((element) =>
    /^(?:log in|sign in|登录)$/i.test(text(element)),
  );
  let outcome = { status: 'protocol-error' };
  try {
    if (loginRequired()) {
      outcome = { status: 'auth-required' };
    } else {
      const modelTrigger = triggerFor('model');
      const modelMenu = await open(modelPickerRoot, modelTrigger);
      if (modelMenu === undefined) {
        outcome = { status: 'model-picker-unavailable' };
      } else {
        const livePicker = activeModelView(modelMenu.root) !== null;
        let modelRead = livePicker ? await liveModels(modelMenu) : optionsFrom(modelMenu.root, 'model');
        if (modelRead.error !== undefined || modelRead.choices.length === 0) {
          outcome = { status: 'model-options-unavailable' };
        } else {
          let selectedModel = livePicker ? modelRead.selected : selectedFrom(modelRead.choices, modelRead.nodes, modelTrigger);
          if (request.selection?.model !== undefined) {
            const selected = livePicker
              ? await chooseLiveModel(modelMenu, request.selection.model)
              : await choose(request.selection.model, modelRead.choices, modelRead.nodes, modelTrigger);
            if (selected === undefined) {
              outcome = { status: 'model-selection-unavailable' };
            } else {
              selectedModel = selected.id;
              if (livePicker) modelRead = await liveModels(modelMenu);
            }
          }
          if (outcome.status === 'protocol-error') {
            if (livePicker) await restoreView(modelMenu);
            const liveControl = outcome.status === 'protocol-error' && livePicker ? liveReasoning(modelMenu.root) : { kind: 'absent' };
            if (outcome.status === 'protocol-error' && liveControl.kind === 'invalid') {
              outcome = { status: 'reasoning-options-unavailable' };
            } else if (outcome.status === 'protocol-error' && liveControl.kind === 'ok') {
              let selectedEffort = liveControl.selected;
              if (request.selection?.effort !== undefined) {
                const selected = await chooseLiveEffort(modelMenu, request.selection.effort);
                if (selected === undefined) outcome = { status: 'effort-selection-unavailable' };
                else selectedEffort = selected.id;
              }
              if (outcome.status === 'protocol-error') {
                const verified = liveReasoning(modelMenu.root);
                if (verified.kind !== 'ok') outcome = { status: 'reasoning-options-unavailable' };
                else outcome = {
                  status: 'ok', models: modelRead.choices, efforts: verified.choices,
                  ...(selectedModel === undefined ? {} : { selectedModel }),
                  selectedEffort: verified.selected, observedAt: new Date().toISOString(),
                };
              }
            } else if (outcome.status === 'protocol-error') {
              if (!await close(modelMenu)) {
                outcome = { status: 'menu-close-failed' };
              } else {
                const effortMenu = await open((trigger) => legacyPickerRoot('effort', trigger), triggerFor('effort', modelTrigger));
                if (effortMenu === undefined) {
                  if (request.selection?.effort !== undefined) outcome = { status: 'effort-selection-unavailable' };
                  else outcome = {
                    status: 'ok', models: modelRead.choices, efforts: [],
                    ...(selectedModel === undefined ? {} : { selectedModel }), observedAt: new Date().toISOString(),
                  };
                } else {
                  const effortRead = optionsFrom(effortMenu.root, 'effort');
                  if (effortRead.error !== undefined || effortRead.choices.length === 0) {
                    outcome = { status: 'reasoning-options-unavailable' };
                  } else {
                    let selectedEffort = selectedFrom(effortRead.choices, effortRead.nodes, effortMenu.trigger);
                    if (request.selection?.effort !== undefined) {
                      const selected = await choose(request.selection.effort, effortRead.choices, effortRead.nodes, effortMenu.trigger);
                      if (selected === undefined) outcome = { status: 'effort-selection-unavailable' };
                      else selectedEffort = selected.id;
                    }
                    if (outcome.status === 'protocol-error') {
                      outcome = {
                        status: 'ok', models: modelRead.choices, efforts: effortRead.choices,
                        ...(selectedModel === undefined ? {} : { selectedModel }),
                        ...(selectedEffort === undefined ? {} : { selectedEffort }), observedAt: new Date().toISOString(),
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } finally {
    let closed = true;
    for (const menu of [...menuEntries].reverse()) closed = await close(menu) && closed;
    if (!closed) outcome = { status: 'menu-close-failed' };
  }
  return outcome;
}`

/**
 * Return the browser evaluator used for exact, visible ChatGPT model and
 * reasoning selections.
 * @returns browser-js-v1 evaluator source that runs against the current page.
 */
export function buildWebModelCatalogEvaluatorSource(): string {
  return MODEL_CATALOG_EVALUATOR
}

/**
 * Build a trusted browser-js-v1 program that selects an existing owned ChatGPT
 * page, or opens the root page only when no such page exists.
 * @param options - bounded discovery inputs and optional explicit user selection.
 * @returns a provider-neutral browser program with no composer or conversation operations.
 */
export function buildWebModelCatalogProgram(options: DiscoverWebModelsOptions): BrowserRunProgramV1 {
  const request = normalizeOptions(options)
  return {
    version: 1,
    language: 'browser-js-v1',
    workspace: { kind: 'named', name: request.workspaceName, createIfMissing: true },
    requiredCapabilities: WEB_MODEL_CATALOG_CAPABILITIES,
    output: { kind: 'json', maxBytes: request.outputMaxBytes },
    source: String.raw`const request = ${JSON.stringify(request)};
const page = 'chatgpt-web-model-catalog';
const prefix = new URL(request.url).origin + '/';
try {
  await browser.run({
    id: 'chatgpt-model-catalog-select-existing', kind: 'select-page', page,
    match: { kind: 'url-prefix', prefix },
  });
} catch (error) {
  if (error === null || typeof error !== 'object' || error.code !== 'BROWSER_PAGE_STALE') throw error;
  await browser.run({
    id: 'chatgpt-model-catalog-open-root', kind: 'open', page, url: request.url,
    reuse: 'exact-url', waitUntil: 'dom-content-loaded',
  });
}
return await browser.evaluate(page, ${JSON.stringify(MODEL_CATALOG_EVALUATOR)}, request);`,
  }
}

/**
 * Discover the native model controls in the user's authenticated ChatGPT page.
 * Omitting `selection` performs a read-only scan apart from opening and closing
 * its own pickers.
 * @param ctx - Context exposing the provider-neutral browser service.
 * @param options - browser bounds and optional explicit user-authorized selection.
 * @param signal - cancellation of the owned browser operation.
 * @returns the verified visible model catalog.
 */
export async function discoverWebModels(ctx: Context, options: DiscoverWebModelsOptions, signal?: AbortSignal): Promise<WebModelCatalog> {
  const program = buildWebModelCatalogProgram(options)
  const result = await ctx.browser.runProgram(program, signal)
  if (result.output.kind !== 'json') {
    throw new Error('ChatGPT Web model discovery returned an unexpected browser output type')
  }
  return catalogFromOutput(result.output.value)
}

/**
 * Apply an explicitly user-authorized visible model or reasoning choice and
 * return the post-selection catalog proved by the same page interaction.
 * @param ctx - Context exposing the provider-neutral browser service.
 * @param options - bounded browser inputs and at least one exact advertised choice.
 * @param signal - cancellation of the owned browser operation.
 * @returns the model catalog after the browser verifies the requested selection.
 */
export function applyWebModelPreferences(
  ctx: Context,
  options: DiscoverWebModelsOptions & { readonly selection: WebModelPreferences },
  signal?: AbortSignal,
): Promise<WebModelCatalog> {
  if (options.selection.model === undefined && options.selection.effort === undefined) {
    throw new Error('ChatGPT Web model application requires an explicitly selected model or reasoning effort')
  }
  return discoverWebModels(ctx, options, signal)
}

/** Validate caller-owned browser inputs before generating executable source. */
function normalizeOptions(options: DiscoverWebModelsOptions): NormalizedDiscoverWebModelsOptions {
  const workspaceName = requiredText('workspaceName', options.workspaceName)
  const parsedUrl = new URL(requiredText('url', options.url))
  if (parsedUrl.protocol !== 'https:' || (parsedUrl.hostname !== 'chatgpt.com' && !parsedUrl.hostname.endsWith('.chatgpt.com'))) {
    throw new Error('ChatGPT Web model discovery requires an HTTPS chatgpt.com URL')
  }
  const selection = normalizeSelection(options.selection)
  return {
    workspaceName,
    url: new URL('/', parsedUrl).href,
    pollIntervalMs: positiveInteger('pollIntervalMs', options.pollIntervalMs),
    timeoutMs: positiveInteger('timeoutMs', options.timeoutMs),
    outputMaxBytes: minimumInteger('outputMaxBytes', options.outputMaxBytes, MIN_OUTPUT_MAX_BYTES),
    ...selection === undefined ? {} : { selection },
  }
}

/** Validate the caller's explicit selection signal without inventing a default. */
function normalizeSelection(selection: WebModelPreferences | undefined): WebModelPreferences | undefined {
  if (selection === undefined) return undefined
  const model = optionalText('selection.model', selection.model)
  const effort = optionalText('selection.effort', selection.effort)
  return model === undefined && effort === undefined ? undefined : {
    ...model === undefined ? {} : { model },
    ...effort === undefined ? {} : { effort },
  }
}

/** Require a bounded, non-empty string from caller-owned configuration. */
function requiredText(name: string, value: unknown): string {
  const text = optionalText(name, value)
  if (text === undefined) throw new Error(`ChatGPT Web ${name} must be a non-empty trimmed string`)
  return text
}

/** Validate an optional exact picker value. */
function optionalText(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > MAX_OPTION_LENGTH) {
    throw new Error(`ChatGPT Web ${name} must be a non-empty trimmed string no longer than ${MAX_OPTION_LENGTH} characters`)
  }
  return value
}

/** Require one positive browser wait bound. */
function positiveInteger(name: string, value: unknown): number {
  return minimumInteger(name, value, 1)
}

/** Require one bounded integer with a caller-specific lower limit. */
function minimumInteger(name: string, value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`ChatGPT Web ${name} must be an integer between ${minimum} and ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

/** Convert the provider's bounded JSON result into a typed, fail-closed catalog. */
function catalogFromOutput(value: BrowserJsonValue): WebModelCatalog {
  const record = recordOf(value)
  switch (record.status) {
    case 'ok': return parseCatalog(record)
    case 'auth-required':
      throw new Error('ChatGPT Web requires a logged-in browser session; sign in in the owned workspace and retry')
    case 'model-picker-unavailable':
      throw new Error('ChatGPT Web did not expose one unique visible model picker; open its ChatGPT composer and retry')
    case 'model-options-unavailable':
      throw new Error('ChatGPT Web opened the model picker but could not read unambiguous visible model choices')
    case 'model-selection-unavailable':
      throw new Error('ChatGPT Web could not verify the explicitly requested model; refresh and choose an exact advertised model')
    case 'reasoning-options-unavailable':
      throw new Error('ChatGPT Web opened the reasoning picker but could not read unambiguous visible reasoning choices')
    case 'effort-selection-unavailable':
      throw new Error('ChatGPT Web could not verify the explicitly requested reasoning effort; refresh and choose an exact advertised effort')
    case 'menu-close-failed':
      throw new Error('ChatGPT Web could not close the picker it opened; close the native picker in the owned workspace and retry')
    default:
      throw new Error('ChatGPT Web returned an invalid model catalog result')
  }
}

/** Parse the one accepted browser result and retain only exact observed picker values. */
function parseCatalog(record: Readonly<Record<string, BrowserJsonValue>>): WebModelCatalog {
  const models = choicesFrom('models', record.models)
  const efforts = choicesFrom('efforts', record.efforts)
  const selectedModel = selectedFrom('selectedModel', record.selectedModel, models)
  const selectedEffort = selectedFrom('selectedEffort', record.selectedEffort, efforts)
  if (typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error('ChatGPT Web returned an invalid model catalog observation time')
  }
  return Object.freeze({
    models: Object.freeze(models),
    efforts: Object.freeze(efforts),
    ...selectedModel === undefined ? {} : { selectedModel },
    ...selectedEffort === undefined ? {} : { selectedEffort },
    observedAt: record.observedAt,
  })
}

/** Validate one picker array without accepting malformed or duplicate choices. */
function choicesFrom(name: string, value: BrowserJsonValue | undefined): WebModelChoice[] {
  if (!isJsonArray(value) || value.length > MAX_OPTIONS) {
    throw new Error(`ChatGPT Web returned invalid ${name}`)
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    const record = recordOf(entry)
    const id = requiredOutputText(`${name}.id`, record.id)
    const label = requiredOutputText(`${name}.label`, record.label)
    if (seen.has(id)) throw new Error(`ChatGPT Web returned duplicate ${name} choice "${id}"`)
    seen.add(id)
    return Object.freeze({ id, label })
  })
}

/** Require an optional selected id to be one current visible option. */
function selectedFrom(name: string, value: BrowserJsonValue | undefined, choices: readonly WebModelChoice[]): string | undefined {
  if (value === undefined) return undefined
  const selected = requiredOutputText(name, value)
  if (!choices.some(choice => choice.id === selected)) {
    throw new Error(`ChatGPT Web returned ${name} outside its visible choices`)
  }
  return selected
}

/** Narrow the typed browser value to its JSON-array variant. */
function isJsonArray(value: BrowserJsonValue | undefined): value is readonly BrowserJsonValue[] {
  return Array.isArray(value)
}

/** Read a plain JSON object without allowing arrays or prototype-derived values. */
function recordOf(value: BrowserJsonValue): Readonly<Record<string, BrowserJsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ChatGPT Web returned an invalid model catalog result')
  }
  return value as Readonly<Record<string, BrowserJsonValue>>
}

/** Validate a bounded exact text value returned by the browser program. */
function requiredOutputText(name: string, value: BrowserJsonValue | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > MAX_OPTION_LENGTH) {
    throw new Error(`ChatGPT Web returned invalid ${name}`)
  }
  return value
}
