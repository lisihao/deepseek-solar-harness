/** Guest-only namespace, data codec and explicitly granted functions. */
export const QUICKJS_GUEST_SOURCE = String.raw`
(() => {
  'use strict';
  const own = Object.getOwnPropertyDescriptors;
  const proto = Object.getPrototypeOf;
  const define = Object.defineProperty;
  const keys = Reflect.ownKeys;
  const stringify = JSON.stringify;
  const finite = Number.isFinite;
  const integer = Number.isSafeInteger;
  const number = Number;
  const string = String;
  const parse = JSON.parse;
  const freeze = Object.freeze;
  const isArray = Array.isArray;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  const records = new Map();
  let expected = new Set();
  let enabled = false;
  let currentId;
  const bridge = globalThis.__dshBridge;
  const log = globalThis.__dshLog;
  const call = (id, method, args) => {
    if (!enabled) throw new Error('RLM bridge unavailable outside the active cell');
    let end = args.length;
    while (end > 0 && args[end - 1] === undefined) end--;
    return bridge(id, method, stringify(args.slice(0, end)));
  };
  const grant = (name, value) => define(globalThis, name, { value, writable: false, configurable: false });
  delete globalThis.__dshBridge;
  delete globalThis.__dshLog;
  const capabilities = () => {
    const rlm = (task, options) => call(currentId, 'spawn', [task, options]);
    Object.assign(rlm, {
      listChildren: () => call(currentId, 'listChildren', []),
      childSummaries: () => call(currentId, 'childSummaries', []),
      readChildResult: (child, options) => call(currentId, 'readChildResult', [child, options]),
      deleteChild: child => call(currentId, 'deleteChild', [child]),
    });
    return freeze({ rlm: freeze(rlm), console: freeze({ log: (...args) => {
      if (!enabled) throw new Error('RLM console unavailable outside the active cell');
      log(currentId, stringify(args));
    } }) });
  };
  const granted = capabilities();
  grant('rlm', granted.rlm);
  grant('console', granted.console);
  const publish = entry => {
    if (!expected.has(entry.name) || records.has(entry.name)) throw new Error('invalid persistent declaration: ' + entry.name);
    expected.delete(entry.name);
    records.set(entry.name, entry);
    define(globalThis, entry.name, { get: entry.get, set: entry.set, configurable: false });
  };
  grant('__dshPublish', entries => { for (const entry of entries) publish(entry); });
  const data = (value, seen = new Set()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && finite(value)) return value;
    if (typeof value !== 'object') throw new Error('value is not plain JSON data');
    if (seen.has(value)) throw new Error('cyclic value is not restorable');
    if (proto(value) !== objectPrototype && proto(value) !== arrayPrototype && proto(value) !== null) throw new Error('special object is not restorable');
    seen.add(value);
    const descriptors = own(value);
    if (isArray(value)) {
      const length = descriptors.length.value;
      const properties = keys(descriptors);
      if (!integer(length) || length < 0 || properties.length !== length + 1) throw new Error('sparse or extended array is not restorable JSON');
      for (const key of properties) {
        if (key === 'length') continue;
        const index = typeof key === 'string' ? number(key) : NaN;
        if (!integer(index) || index < 0 || index >= length || string(index) !== key) throw new Error('extended array is not restorable JSON');
      }
    }
    const output = isArray(value) ? [] : Object.create(null);
    for (const key of keys(descriptors)) {
      if (typeof key !== 'string') throw new Error('symbol key is not restorable');
      if (isArray(value) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!('value' in descriptor)) throw new Error('accessor is not restorable');
      if (!descriptor.enumerable) throw new Error('non-enumerable value is not restorable');
      define(output, key, { value: data(descriptor.value, seen), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(value);
    return output;
  };
  return freeze({
    decode: serialized => parse(serialized).value,
    initialize: serialized => {
      const initial = parse(serialized);
      grant('context', initial.context);
      for (const item of initial.variables) {
        if (item.error) { records.set(item.name, { ...item, get: () => { throw new Error(item.error); } }); continue; }
        let value = item.defined ? item.value : undefined;
        expected.add(item.name);
        publish({ name: item.name, kind: item.kind, get: () => value,
          ...(item.kind === 'const' ? {} : { set: next => { value = next; } }) });
      }
    },
    begin: (serialized, id) => {
      if (enabled) throw new Error('cell already active');
      const names = parse(serialized);
      for (const name of names) if (records.has(name) || Object.prototype.hasOwnProperty.call(globalThis, name)) throw new Error('binding already exists: ' + name);
      expected = new Set(names);
      enabled = true;
      currentId = id;
      return granted;
    },
    close: () => { enabled = false; currentId = undefined; },
    pack: value => {
      enabled = false;
      const variables = [];
      for (const [name, entry] of records) {
        try {
          const current = entry.get();
          variables.push({ name, declaration: entry.kind, defined: current !== undefined,
            ...(current === undefined ? {} : { value: data(current) }) });
        } catch { variables.push({ name, declaration: entry.kind, error: 'binding cannot be restored as plain JSON data' }); }
      }
      let result;
      let display;
      if (value === undefined) display = 'undefined';
      else {
        try {
          result = data(value);
          if (own(arrayPrototype).toJSON || own(objectPrototype).toJSON) throw new Error('custom JSON serialization unavailable');
          display = stringify(result);
        } catch { result = undefined; display = '[non-JSON value; complete JSON result unavailable]'; }
      }
      if (own(arrayPrototype).toJSON || own(objectPrototype).toJSON) throw new Error('custom JSON serialization unavailable');
      return stringify({ variables, context: data(context), display, ...(result === undefined ? {} : { value: result }) });
    },
  });
})()
`
