/**
 * Short browser-js-v1 programs for the coordinated ChatGPT Web lane.
 *
 * The programs deliberately return only one current-turn observation per call.
 * Durable receipt ownership and retry policy live in `web-session.ts`.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/web-session-browser
 */

import type { BrowserRunProgramV1 } from '@deepseek-ai/dsh-browser'
import { buildWebModelCatalogEvaluatorSource, type WebModelPreferences } from './model-catalog.ts'

/** Browser capabilities used by every coordinated lane program. */
export const COORDINATED_WEB_SESSION_CAPABILITIES = Object.freeze([
  'authenticated-profile-reuse',
  'named-workspace',
  'page-evaluate',
] as const)

/** Input shared by every browser program in one coordinated lane. */
export interface CoordinatedWebProgramRequest {
  /** Per-lane named workspace selected by the provider. */
  readonly workspaceName: string
  /** Exact ChatGPT page URL that the program may open or reuse. */
  readonly url: string
  /** Bounded JSON result size enforced by the browser provider. */
  readonly outputMaxBytes: number
}

/** Input for a one-shot submission program. */
export interface CoordinatedWebSubmitProgramRequest extends CoordinatedWebProgramRequest {
  /** Fully rendered text sent through the website composer. */
  readonly prompt: string
  /** Visible MCP app name that must already be attached to the composer. */
  readonly connectorName: string
  /** Whether the target must be a blank root conversation. */
  readonly freshLane: boolean
  /**
   * Native user-message ids observed before the durable pre-send intent was
   * recorded. A later proof accepts only an id absent from this set.
   */
  readonly baselineUserMessageIds: readonly string[]
  /** Explicit model and reasoning choices verified before this command's intent. */
  readonly profile?: WebModelPreferences
  /** Upper bound for the same-page native picker verification. */
  readonly modelSelectionTimeoutMs: number
  /** Delay used by the bounded native picker verifier. */
  readonly pollIntervalMs: number
  /** Maximum same-page observation time after the send click. */
  readonly submissionTimeoutMs: number
  /** Previously completed owned turn that must still be visible for a follow-up. */
  readonly previousTurn?: {
    readonly conversationUrl: string
    readonly userMessageId: string
    readonly assistantMessageId?: string
  }
}

/** Input for the non-mutating pre-send inspection that records a baseline. */
export type CoordinatedWebPrepareProgramRequest = CoordinatedWebSubmitProgramRequest

/**
 * Input for repeated no-send proof attempts after an uncertain click.
 * Its inherited URL must be the exact `/c/<id>` page captured by the send
 * program; a root page is deliberately not rebound to another conversation.
 */
export interface CoordinatedWebSubmissionProofProgramRequest extends CoordinatedWebProgramRequest {
  /** Fully rendered text that the pending browser click was expected to create. */
  readonly prompt: string
  /** Native user-message ids known to precede that click. */
  readonly baselineUserMessageIds: readonly string[]
}

/** Input for a short exact-turn polling program. */
export interface CoordinatedWebPollProgramRequest extends CoordinatedWebProgramRequest {
  /** Native id of the user message whose state the caller owns. */
  readonly userMessageId: string
}

/** Input for a non-mutating ambiguity inspection program. */
export interface CoordinatedWebInspectProgramRequest extends CoordinatedWebProgramRequest {
  /** Exact URL previously selected for the lane before an uncertain send. */
  readonly expectedUrl: string
}

const DOM_HELPERS = String.raw`
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalizeNewlines = (value) => String(value ?? '').replace(/\r\n?/g, '\n');
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const outermost = (elements) => {
    const unique = [...new Set(elements)];
    return unique.filter((element) => !unique.some((other) => other !== element && other.contains(element)));
  };
  const messageRole = (element) => {
    const direct = element.getAttribute('data-message-author-role');
    if (direct === 'user' || direct === 'assistant') return direct;
    const key = String(element.getAttribute('data-content-search-unit-key') ?? '');
    if (key.endsWith(':user')) return 'user';
    if (key.endsWith(':assistant')) return 'assistant';
    return undefined;
  };
  const messageId = (element) => {
    const direct = element.getAttribute('data-message-id');
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const nested = element.querySelector('[data-message-id]');
    const nestedId = nested?.getAttribute('data-message-id');
    if (typeof nestedId === 'string' && nestedId.length > 0) return nestedId;
    const key = element.getAttribute('data-content-search-unit-key');
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  };
  const messageNodes = () => outermost([
    ...document.querySelectorAll('[data-message-author-role]'),
    ...document.querySelectorAll('[data-content-search-unit-key]'),
  ]).flatMap((element) => {
    const role = messageRole(element);
    const id = messageId(element);
    if ((role !== 'user' && role !== 'assistant') || id === undefined) return [];
    if (role === 'user' && element.querySelector('[data-user-message-bubble="true"]') === null
      && element.getAttribute('data-message-author-role') !== 'user') return [];
    if (role === 'assistant' && element.querySelector('[data-markdown-text-style="assistant-message"], .markdown') === null
      && element.getAttribute('data-message-author-role') !== 'assistant') return [];
    return [{ element, role, id }];
  });
  const composer = () => {
    const candidates = [...document.querySelectorAll('div.ProseMirror[contenteditable="true"]')].filter(visible);
    return candidates.length === 1 ? candidates[0] : null;
  };
  const nodeText = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node;
    if (element.tagName === 'BR') return element.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
    return [...element.childNodes].map(nodeText).join('');
  };
  const composerText = (element) => {
    if (element === null) return '';
    const blocks = [...element.children];
    return normalizeNewlines(blocks.length === 0
      ? [...element.childNodes].map(nodeText).join('')
      : blocks.map(nodeText).join('\n'));
  };
  const attachmentCount = (element) => {
    if (element === null) return 0;
    const form = element.closest('form');
    if (form === null) return 0;
    const files = [...form.querySelectorAll('input[type="file"]')]
      .filter((input) => input.files !== null && input.files.length > 0).length;
    const attached = [...form.querySelectorAll('[data-file-id],[data-attachment-id],[role="progressbar"]')]
      .filter(visible).length;
    return files + attached;
  };
  const sendButton = (editor) => {
    if (editor === null) return null;
    const form = editor.closest('form');
    if (form === null) return null;
    const names = new Set(['send', 'send message', 'send prompt', '发送', '发送消息']);
    const candidates = [...form.querySelectorAll('button')].filter((element) => {
      if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true'
        || element.type !== 'submit') return false;
      const name = normalize(element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent)
        .toLocaleLowerCase();
      return element.id === 'composer-submit-button'
        || element.getAttribute('data-testid') === 'send-button'
        || names.has(name);
    });
    return candidates.length === 1 ? candidates[0] : null;
  };
  const connectorAttached = (editor, connectorName) => {
    if (editor === null || typeof connectorName !== 'string' || connectorName.length === 0) return false;
    const form = editor.closest('form');
    if (form === null) return false;
    const expected = normalize(connectorName).toLocaleLowerCase();
    const candidates = [...form.querySelectorAll('[data-connector-name],[data-mcp-server-name],[data-testid],[aria-label],[title]')];
    return candidates.some((element) => {
      const exact = [
        element.getAttribute('data-connector-name'),
        element.getAttribute('data-mcp-server-name'),
      ].some((value) => normalize(value).toLocaleLowerCase() === expected);
      if (exact) return true;
      const testId = normalize(element.getAttribute('data-testid')).toLocaleLowerCase();
      // A generic app-picker button can name the connector without attaching
      // it. Only a composer-local attachment-like control is an alternate
      // proof when the native data name is absent.
      const isAttachedConnector = /(?:mcp|connector|app).*(?:chip|pill|attached|attachment)/.test(testId);
      if (!isAttachedConnector) return false;
      return [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
        .some((value) => normalize(value).toLocaleLowerCase() === expected);
    });
  };
  const conversation = () => {
    const current = new URL(location.href);
    const match = /^\/c\/([^/?#]+)/.exec(current.pathname);
    return {
      url: current.href,
      id: match?.[1],
      page: match === null ? current.pathname === '/' ? 'root' : 'other' : 'conversation',
    };
  };
  const currentUserText = (node) => {
    const bubble = node.querySelector('[data-user-message-bubble="true"]');
    return normalizeNewlines(bubble?.textContent ?? node.textContent ?? '');
  };
  const assistantText = (node) => {
    const content = node.querySelector('[data-markdown-text-style="assistant-message"]')
      ?? node.querySelector('.markdown')
      ?? node;
    return content.textContent ?? '';
  };
  const generating = () => [...document.querySelectorAll('button,[role="button"]')].some((element) => {
    if (!visible(element)) return false;
    const label = normalize(element.getAttribute('aria-label') ?? element.textContent).toLocaleLowerCase();
    return /^(stop generating|stop streaming|停止生成)$/.test(label);
  });
  const finalAction = (assistant, assistants) => {
    let ancestor = assistant.parentElement;
    while (ancestor !== null && ancestor !== document.body && ancestor.tagName !== 'MAIN') {
      if (assistants.filter((entry) => ancestor.contains(entry.element)).length > 1) return false;
      const found = [...ancestor.querySelectorAll('button')].some((button) => {
        const label = normalize(button.getAttribute('aria-label') ?? button.getAttribute('title')).toLocaleLowerCase();
        return button.getAttribute('data-testid') === 'copy-turn-action-button'
          || label === 'copy' || label === 'copy response' || label === '复制' || label === '复制回复';
      });
      if (found) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  };
  const boundedReactMetadata = (node, expectedMessageId, turnMessageIds) => {
    const state = {
      requestIds: [], endTurn: false, finishedSuccessfully: false, stopped: false, failed: false,
      model: undefined, effort: undefined,
    };
    const requestIds = new Set();
    const seen = new Set();
    const nestedKeys = new Set(['message', 'metadata', 'metadata_overrides', 'metadataOverrides', 'finish_details', 'finishDetails', 'parts']);
    let budget = 96;
    const readString = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
    const objectMessageId = (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      for (const key of ['id', 'message_id', 'messageId']) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const id = descriptor !== undefined && 'value' in descriptor ? readString(descriptor.value) : undefined;
        if (id !== undefined) return id;
      }
      return undefined;
    };
    const visit = (value, depth, directNode) => {
      if (budget <= 0 || depth > 4 || value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 16)) visit(item, depth + 1, false);
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return;
      const exactObject = objectMessageId(value) === expectedMessageId;
      const trusted = directNode || exactObject;
      for (const key of Object.getOwnPropertyNames(value).slice(0, 32)) {
        if (budget <= 0) return;
        budget -= 1;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) continue;
        const item = descriptor.value;
        if (trusted && (key === 'request_id' || key === 'requestId')) {
          const id = readString(item);
          if (id !== undefined) requestIds.add(id);
          continue;
        }
        if (trusted && (key === 'request_ids' || key === 'requestIds')) {
          if (Array.isArray(item)) {
            for (const candidate of item.slice(0, 16)) {
              const id = readString(candidate);
              if (id !== undefined) requestIds.add(id);
            }
          }
          continue;
        }
        if (trusted && (key === 'end_turn' || key === 'endTurn')) {
          state.endTurn ||= item === true || item === 'end_turn';
          continue;
        }
        if (trusted && (key === 'finished_successfully' || key === 'finishedSuccessfully')) {
          state.finishedSuccessfully ||= item === true;
          continue;
        }
        if (trusted && (key === 'status' || key === 'state')) {
          const status = readString(item)?.toLocaleLowerCase();
          state.stopped ||= status === 'stopped' || status === 'cancelled' || status === 'interrupted';
          state.failed ||= status === 'error' || status === 'failed';
          continue;
        }
        if (trusted && (key === 'model_slug' || key === 'modelSlug' || key === 'model')) {
          state.model ??= readString(item);
          continue;
        }
        if (trusted && (key === 'reasoning_effort' || key === 'reasoningEffort' || key === 'effort')) {
          state.effort ??= readString(item);
          continue;
        }
        if (!nestedKeys.has(key)) continue;
        // An unlabelled direct DOM prop may carry its own metadata, but a
        // nested message data must identify the exact native DOM message first.
        visit(item, depth + 1, trusted && key !== 'message');
      }
    };
    const isCurrentTurnBoundary = (candidate) => {
      const members = messageNodes().filter((entry) => candidate.contains(entry.element));
      return members.some((entry) => entry.id === expectedMessageId)
        && members.every((entry) => turnMessageIds.has(entry.id));
    };
    for (let cursor = node, climbed = 0; cursor !== null && climbed < 4; cursor = cursor.parentElement, climbed += 1) {
      if (cursor !== node && !isCurrentTurnBoundary(cursor)) break;
      for (const key of Object.getOwnPropertyNames(cursor)) {
        // React props are intentionally the sole implementation detail read here.
        // Fibers and whole-conversation props can reach unrelated account or turn data.
        if (!key.startsWith('__reactProps$')) continue;
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
        if (descriptor !== undefined && 'value' in descriptor) visit(descriptor.value, 0, cursor === node);
      }
    }
    state.requestIds = [...requestIds].sort();
    return state;
  };
  const truncateUtf8 = (text, maxBytes) => {
    const encoder = new TextEncoder();
    if (encoder.encode(text).byteLength <= maxBytes) return { text, truncated: false };
    let end = text.length;
    while (end > 0 && encoder.encode(text.slice(0, end)).byteLength > maxBytes) end -= 1;
    return { text: text.slice(0, end), truncated: true };
  };
  const observeExactUser = (userMessageId, outputMaxBytes) => {
    const messages = messageNodes();
    const users = messages.filter((entry) => entry.role === 'user');
    const assistants = messages.filter((entry) => entry.role === 'assistant');
    const matches = users.filter((entry) => entry.id === userMessageId);
    const current = conversation();
    if (matches.length !== 1 || current.id === undefined) {
      return { identity: 'unproven', conversationUrl: current.url, generating: generating(), terminal: 'indeterminate', requestIds: [], model: 'unknown' };
    }
    const user = matches[0];
    const index = messages.indexOf(user);
    const next = messages[index + 1];
    if (next !== undefined && next.role !== 'assistant') {
      return { identity: 'unproven', conversationUrl: current.url, generating: generating(), terminal: 'indeterminate', requestIds: [], model: 'unknown' };
    }
    const turnMessageIds = new Set(next === undefined ? [user.id] : [user.id, next.id]);
    const userMetadata = boundedReactMetadata(user.element, user.id, turnMessageIds);
    if (next === undefined) {
      return {
        identity: 'exact', conversationId: current.id, conversationUrl: current.url, userMessageId: user.id,
        generating: generating(), terminal: userMetadata.stopped ? 'stopped' : userMetadata.failed ? 'failed' : 'running',
        requestIds: userMetadata.requestIds, model: 'unknown',
      };
    }
    const metadata = boundedReactMetadata(next.element, next.id, turnMessageIds);
    const response = truncateUtf8(assistantText(next.element), Math.max(256, outputMaxBytes - 2048));
    const isGenerating = generating();
    const terminal = metadata.failed ? 'failed'
      : metadata.stopped || userMetadata.stopped ? 'stopped'
        : metadata.endTurn && metadata.finishedSuccessfully ? 'completed'
          : !isGenerating && response.text.length > 0 && finalAction(next.element, assistants) ? 'completed'
            : 'running';
    return {
      identity: 'exact', conversationId: current.id, conversationUrl: current.url, userMessageId: user.id,
      assistantMessageId: next.id, requestIds: userMetadata.requestIds, response: response.text,
      truncated: response.truncated, model: metadata.model ?? 'unknown',
      ...(metadata.effort === undefined ? {} : { effort: metadata.effort }), generating: isGenerating, terminal,
    };
  };
`

const APPLY_PROFILE = String.raw`
const applyProfile = async () => {
  if (request.profile === undefined) return { status: 'ok' };
  if (request.profile === null || typeof request.profile !== 'object' || Array.isArray(request.profile)) {
    return { status: 'model-selection-unavailable' };
  }
  const selection = await browser.evaluate(page, ${JSON.stringify(buildWebModelCatalogEvaluatorSource())}, {
    selection: request.profile,
    pollIntervalMs: request.pollIntervalMs,
    timeoutMs: request.modelSelectionTimeoutMs,
  });
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection) || selection.status !== 'ok') {
    return { status: 'model-selection-unavailable' };
  }
  const proves = (requested, selected, choices) => {
    if (typeof requested !== 'string' || typeof selected !== 'string') return typeof requested !== 'string';
    if (selected === requested) return true;
    return Array.isArray(choices) && choices.some((choice) => choice !== null
      && typeof choice === 'object' && !Array.isArray(choice)
      && (choice.id === requested || choice.label === requested)
      && (choice.id === selected || choice.label === selected));
  };
  if (!proves(request.profile.model, selection.selectedModel, selection.models)) {
    return { status: 'model-selection-unavailable' };
  }
  if (!proves(request.profile.effort, selection.selectedEffort, selection.efforts)) {
    return { status: 'model-selection-unavailable' };
  }
  return { status: 'ok' };
};
`

const EXACT_CONVERSATION_URL = String.raw`
const isExactConversationUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const candidate = new URL(value);
    return candidate.protocol === 'https:' && candidate.hostname === 'chatgpt.com'
      && candidate.port === '' && candidate.username === '' && candidate.password === ''
      && candidate.search === '' && candidate.hash === '' && /^\/c\/[^/?#]+$/.test(candidate.pathname);
  } catch {
    return false;
  }
};
`

const PREPARE_SUBMIT = String.raw`(input) => {
  ${DOM_HELPERS}
  const phase = 'prepare';
  if (input === null || typeof input !== 'object') return { status: 'protocol-error', phase };
  const current = conversation();
  const editor = composer();
  const messages = messageNodes();
  const users = messages.filter((entry) => entry.role === 'user');
  const assistants = messages.filter((entry) => entry.role === 'assistant');
  const userIds = users.map((entry) => entry.id);
  const draft = composerText(editor);
  const attachments = attachmentCount(editor);
  if (editor === null) return { status: 'input-unavailable', phase };
  if (new Set(userIds).size !== userIds.length) return { status: 'identity-unproven', phase };
  if (draft.length > 0 || attachments > 0) return { status: 'draft-present', phase, inputCharacters: draft.length, attachmentCount: attachments };
  if (!connectorAttached(editor, input.connectorName)) return { status: 'connector-required', phase };
  if (generating()) return { status: 'lane-active', phase };
  if (input.freshLane === true) {
    if (current.page !== 'root' || users.length !== 0 || assistants.length !== 0) return { status: 'lane-unowned', phase };
  } else {
    if (typeof input.previousUserMessageId !== 'string' || current.url !== input.expectedUrl) return { status: 'identity-unproven', phase };
    const previous = observeExactUser(input.previousUserMessageId, input.outputMaxBytes);
    if (previous.identity !== 'exact' || previous.terminal !== 'completed') return { status: previous.terminal === 'running' ? 'lane-active' : 'identity-unproven', phase };
    if (typeof input.previousAssistantMessageId === 'string' && previous.assistantMessageId !== input.previousAssistantMessageId) {
      return { status: 'identity-unproven', phase };
    }
  }
  if (input.baselineUserMessageIds !== undefined) {
    if (!Array.isArray(input.baselineUserMessageIds)
      || !input.baselineUserMessageIds.every((value) => typeof value === 'string')) return { status: 'protocol-error', phase };
    const baseline = [...new Set(input.baselineUserMessageIds)];
    if (baseline.length !== input.baselineUserMessageIds.length || baseline.length !== userIds.length
      || baseline.some((id) => !userIds.includes(id))) return { status: 'identity-unproven', phase };
  }
  editor.setAttribute('data-dsh-chatgpt-web-session-input', 'true');
  return { status: 'ready', phase, beforeUserIds: userIds };
}`

const VERIFY_FILLED = String.raw`(input) => {
  ${DOM_HELPERS}
  const phase = 'verify';
  if (input === null || typeof input !== 'object' || typeof input.prompt !== 'string' || !Array.isArray(input.beforeUserIds)) {
    return { status: 'protocol-error', phase };
  }
  const editor = composer();
  if (editor === null) return { status: 'input-unavailable', phase };
  const draft = composerText(editor);
  const attachments = attachmentCount(editor);
  if (draft !== normalizeNewlines(input.prompt) || attachments > 0) return { status: 'submission-failed', phase };
  const currentUserIds = messageNodes().filter((entry) => entry.role === 'user').map((entry) => entry.id);
  const baseline = [...new Set(input.beforeUserIds.filter((value) => typeof value === 'string'))];
  if (baseline.length !== input.beforeUserIds.length || baseline.length !== currentUserIds.length
    || baseline.some((id) => !currentUserIds.includes(id))) return { status: 'identity-unproven', phase };
  if (!connectorAttached(editor, input.connectorName)) return { status: 'connector-required', phase };
  const send = sendButton(editor);
  if (send === null || generating()) return { status: 'submission-failed', phase };
  send.setAttribute('data-dsh-chatgpt-web-session-send', 'true');
  return { status: 'ready', phase };
}`

const FIND_SUBMITTED_USER = String.raw`(input) => {
  ${DOM_HELPERS}
  const phase = 'after-submit';
  if (input === null || typeof input !== 'object' || typeof input.prompt !== 'string' || !Array.isArray(input.beforeUserIds)) {
    return { status: 'protocol-error', phase };
  }
  const before = new Set(input.beforeUserIds.filter((value) => typeof value === 'string'));
  const matches = messageNodes().filter((entry) => entry.role === 'user'
    && !before.has(entry.id) && currentUserText(entry.element) === normalizeNewlines(input.prompt));
  if (matches.length === 0) return { status: 'submission-pending', phase, candidateUrl: conversation().url };
  if (matches.length !== 1) return { status: 'identity-unproven', phase };
  const observation = observeExactUser(matches[0].id, input.outputMaxBytes);
  return observation.identity === 'exact'
    ? { status: 'accepted', phase, observation }
    : { status: 'identity-unproven', phase };
}`

const POLL_EXACT_USER = String.raw`(input) => {
  ${DOM_HELPERS}
  const phase = 'poll';
  if (input === null || typeof input !== 'object' || typeof input.userMessageId !== 'string') {
    return { status: 'protocol-error', phase };
  }
  return { status: 'observation', phase, observation: observeExactUser(input.userMessageId, input.outputMaxBytes) };
}`

const PROVE_SUBMITTED_USER = String.raw`(input) => {
  ${DOM_HELPERS}
  const phase = 'submission-proof';
  if (input === null || typeof input !== 'object' || typeof input.prompt !== 'string'
    || typeof input.expectedUrl !== 'string' || !Array.isArray(input.beforeUserIds)) {
    return { status: 'protocol-error', phase };
  }
  if (conversation().url !== input.expectedUrl) return { status: 'identity-unproven', phase };
  const before = new Set(input.beforeUserIds.filter((value) => typeof value === 'string'));
  const matches = messageNodes().filter((entry) => entry.role === 'user'
    && !before.has(entry.id) && currentUserText(entry.element) === normalizeNewlines(input.prompt));
  if (matches.length === 0) return { status: 'submission-pending', phase, candidateUrl: conversation().url };
  if (matches.length !== 1) return { status: 'identity-unproven', phase };
  const observation = observeExactUser(matches[0].id, input.outputMaxBytes);
  return observation.identity === 'exact'
    ? { status: 'accepted', phase, observation }
    : { status: 'identity-unproven', phase };
}`

const INSPECT_UNPROVEN = String.raw`(input) => {
  ${DOM_HELPERS}
  const phase = 'inspect-unproven';
  if (input === null || typeof input !== 'object' || typeof input.expectedUrl !== 'string') {
    return { status: 'protocol-error', phase };
  }
  const current = conversation();
  return {
    status: current.url === input.expectedUrl ? 'inspected' : 'identity-unproven', phase,
    conversationUrl: current.url, generating: generating(),
  };
}`

/**
 * Build one non-mutating pre-send program that validates a lane and captures
 * the native user-message baseline persisted before any click.
 * @param request - fixed browser, connector, prompt, and lane identity inputs.
 * @returns a browser-js-v1 program with no composer mutation.
 */
export function buildCoordinatedWebPrepareProgram(request: CoordinatedWebPrepareProgramRequest): BrowserRunProgramV1 {
  const encoded = JSON.stringify(request)
  return {
    version: 1,
    language: 'browser-js-v1',
    workspace: { kind: 'named', name: request.workspaceName, createIfMissing: true },
    requiredCapabilities: COORDINATED_WEB_SESSION_CAPABILITIES,
    output: { kind: 'json', maxBytes: request.outputMaxBytes },
    source: String.raw`const request = ${encoded};
const page = 'chatgpt-web-session';
await browser.run({ id: 'chatgpt-web-session-open', kind: 'open', page, url: request.url, reuse: 'exact-url', waitUntil: 'dom-content-loaded' });
${APPLY_PROFILE}
const profile = await applyProfile();
if (profile.status !== 'ok') return profile;
return await browser.evaluate(page, ${JSON.stringify(PREPARE_SUBMIT)}, {
  connectorName: request.connectorName,
  freshLane: request.freshLane,
  expectedUrl: request.url,
  previousUserMessageId: request.previousTurn?.userMessageId,
  previousAssistantMessageId: request.previousTurn?.assistantMessageId,
  outputMaxBytes: request.outputMaxBytes,
});`,
  }
}

/**
 * Build one short program that fills and clicks once after rechecking the
 * durable pre-send native-user baseline.
 * @param request - fixed browser, connector, prompt, and lane identity inputs.
 * @returns a single browser-js-v1 program with bounded same-page post-click observation.
 */
export function buildCoordinatedWebSubmitProgram(request: CoordinatedWebSubmitProgramRequest): BrowserRunProgramV1 {
  const encoded = JSON.stringify(request)
  return {
    version: 1,
    language: 'browser-js-v1',
    workspace: { kind: 'named', name: request.workspaceName, createIfMissing: true },
    requiredCapabilities: COORDINATED_WEB_SESSION_CAPABILITIES,
    output: { kind: 'json', maxBytes: request.outputMaxBytes },
    source: String.raw`const request = ${encoded};
const page = 'chatgpt-web-session';
await browser.run({ id: 'chatgpt-web-session-open', kind: 'open', page, url: request.url, reuse: 'exact-url', waitUntil: 'dom-content-loaded' });
${APPLY_PROFILE}
const profile = await applyProfile();
if (profile.status !== 'ok') return profile;
const prepared = await browser.evaluate(page, ${JSON.stringify(PREPARE_SUBMIT)}, {
  connectorName: request.connectorName,
  freshLane: request.freshLane,
  expectedUrl: request.url,
  previousUserMessageId: request.previousTurn?.userMessageId,
  previousAssistantMessageId: request.previousTurn?.assistantMessageId,
  baselineUserMessageIds: request.baselineUserMessageIds,
  outputMaxBytes: request.outputMaxBytes,
});
if (prepared.status !== 'ready') return prepared;
await browser.run({ id: 'chatgpt-web-session-fill', kind: 'fill', page, locator: { kind: 'css', selector: '[data-dsh-chatgpt-web-session-input="true"]' }, value: request.prompt });
const verified = await browser.evaluate(page, ${JSON.stringify(VERIFY_FILLED)}, {
  prompt: request.prompt, connectorName: request.connectorName, beforeUserIds: request.baselineUserMessageIds,
});
if (verified.status !== 'ready') return verified;
await browser.run({ id: 'chatgpt-web-session-send', kind: 'click', page, locator: { kind: 'css', selector: '[data-dsh-chatgpt-web-session-send="true"]' } });
${EXACT_CONVERSATION_URL}
const submissionDeadline = Date.now() + request.submissionTimeoutMs;
let pendingSubmission;
while (Date.now() <= submissionDeadline) {
  const observed = await browser.evaluate(page, ${JSON.stringify(FIND_SUBMITTED_USER)}, {
    prompt: request.prompt, beforeUserIds: request.baselineUserMessageIds, outputMaxBytes: request.outputMaxBytes,
  });
  if (observed.status !== 'submission-pending') return observed;
  pendingSubmission = observed;
  if (isExactConversationUrl(observed.candidateUrl) || Date.now() >= submissionDeadline) return observed;
  await new Promise(resolve => setTimeout(resolve, Math.min(request.pollIntervalMs, Math.max(0, submissionDeadline - Date.now()))));
}
return pendingSubmission ?? { status: 'submission-pending', phase: 'after-submit' };`,
  }
}

/**
 * Build one non-mutating exact-turn observation program.
 * @param request - fixed browser and native user-message identity inputs.
 * @returns a browser-js-v1 program that performs one page observation.
 */
export function buildCoordinatedWebPollProgram(request: CoordinatedWebPollProgramRequest): BrowserRunProgramV1 {
  const encoded = JSON.stringify(request)
  return {
    version: 1,
    language: 'browser-js-v1',
    workspace: { kind: 'named', name: request.workspaceName, createIfMissing: true },
    requiredCapabilities: COORDINATED_WEB_SESSION_CAPABILITIES,
    output: { kind: 'json', maxBytes: request.outputMaxBytes },
    source: String.raw`const request = ${encoded};
const page = 'chatgpt-web-session';
await browser.run({ id: 'chatgpt-web-session-open', kind: 'open', page, url: request.url, reuse: 'exact-url', waitUntil: 'dom-content-loaded' });
return await browser.evaluate(page, ${JSON.stringify(POLL_EXACT_USER)}, {
  userMessageId: request.userMessageId, outputMaxBytes: request.outputMaxBytes,
});`,
  }
}

/**
 * Build one short proof attempt for an exact conversation URL captured by its send program.
 * @param request - browser target plus the exact rendered prompt to locate once.
 * @returns a browser-js-v1 program that returns only a newly proven exact turn.
 */
export function buildCoordinatedWebSubmissionProofProgram(
  request: CoordinatedWebSubmissionProofProgramRequest,
): BrowserRunProgramV1 {
  const encoded = JSON.stringify(request)
  return {
    version: 1,
    language: 'browser-js-v1',
    workspace: { kind: 'named', name: request.workspaceName, createIfMissing: true },
    requiredCapabilities: COORDINATED_WEB_SESSION_CAPABILITIES,
    output: { kind: 'json', maxBytes: request.outputMaxBytes },
    source: String.raw`const request = ${encoded};
const page = 'chatgpt-web-session';
${EXACT_CONVERSATION_URL}
if (!isExactConversationUrl(request.url)) return { status: 'submission-pending', phase: 'submission-proof' };
await browser.run({ id: 'chatgpt-web-session-open', kind: 'open', page, url: request.url, reuse: 'exact-url', waitUntil: 'dom-content-loaded' });
return await browser.evaluate(page, ${JSON.stringify(PROVE_SUBMITTED_USER)}, {
  prompt: request.prompt, expectedUrl: request.url, beforeUserIds: request.baselineUserMessageIds, outputMaxBytes: request.outputMaxBytes,
});`,
  }
}

/**
 * Build a no-send check for an uncertain pre-acceptance command.
 * @param request - fixed browser and expected lane page identity.
 * @returns a browser-js-v1 program that cannot mutate the composer.
 */
export function buildCoordinatedWebInspectProgram(request: CoordinatedWebInspectProgramRequest): BrowserRunProgramV1 {
  const encoded = JSON.stringify(request)
  return {
    version: 1,
    language: 'browser-js-v1',
    workspace: { kind: 'named', name: request.workspaceName, createIfMissing: true },
    requiredCapabilities: COORDINATED_WEB_SESSION_CAPABILITIES,
    output: { kind: 'json', maxBytes: request.outputMaxBytes },
    source: String.raw`const request = ${encoded};
const page = 'chatgpt-web-session';
try {
  await browser.run({ id: 'chatgpt-web-session-select', kind: 'select-page', page, match: { kind: 'exact-url', url: request.expectedUrl } });
} catch {
  return { status: 'identity-unproven', phase: 'inspect-unproven' };
}
return await browser.evaluate(page, ${JSON.stringify(INSPECT_UNPROVEN)}, { expectedUrl: request.expectedUrl });`,
  }
}
