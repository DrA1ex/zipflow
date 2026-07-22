export function createInterruptAwareInput(input, { onInterrupt = null } = {}) {
  if (!input || typeof input.on !== 'function') return input;
  const registrations = [];
  let interruptAttached = false;
  let proxy;

  const interruptListener = (data) => {
    const count = countInterruptBytes(data);
    for (let index = 0; index < count; index += 1) onInterrupt?.();
  };

  const attachInterruptListener = () => {
    if (interruptAttached) input.removeListener('data', interruptListener);
    input.prependListener('data', interruptListener);
    interruptAttached = true;
  };

  const detachInterruptListenerIfUnused = () => {
    if (!interruptAttached || registrations.length) return;
    input.removeListener('data', interruptListener);
    interruptAttached = false;
  };

  const forget = (registration) => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
    detachInterruptListenerIfUnused();
  };

  const add = (method, event, listener) => {
    if (event !== 'data') {
      input[method](event, listener);
      return proxy;
    }
    const registration = { listener, wrapped: null, once: method === 'once' || method === 'prependOnceListener' };
    const wrapped = (data) => {
      const value = removeInterruptBytes(data);
      if (!hasInput(value)) return undefined;
      if (registration.once) {
        input.removeListener('data', wrapped);
        forget(registration);
      }
      return listener(value);
    };
    registration.wrapped = wrapped;
    registrations.push(registration);
    const underlyingMethod = method === 'once'
      ? 'on'
      : method === 'prependOnceListener'
        ? 'prependListener'
        : method;
    input[underlyingMethod](event, wrapped);
    // Keep the raw interrupt observer ahead of every application listener,
    // including listeners registered with prependListener().
    attachInterruptListener();
    return proxy;
  };

  const remove = (method, event, listener) => {
    if (event !== 'data') {
      input[method](event, listener);
      return proxy;
    }
    const registration = registrations.findLast((item) => item.listener === listener);
    input[method](event, registration?.wrapped ?? listener);
    if (registration) forget(registration);
    return proxy;
  };

  const removeAll = (event) => {
    input.removeAllListeners(event);
    if (event === undefined || event === 'data') {
      registrations.length = 0;
      interruptAttached = false;
    }
    return proxy;
  };

  proxy = new Proxy(input, {
    get(target, property) {
      if (typeof property === 'string' && ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener'].includes(property)) {
        return (event, listener) => add(property, event, listener);
      }
      if (property === 'off' || property === 'removeListener') return (event, listener) => remove(property, event, listener);
      if (property === 'removeAllListeners') return removeAll;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

function countInterruptBytes(data) {
  if (Buffer.isBuffer(data)) {
    let count = 0;
    for (const byte of data) if (byte === 0x03) count += 1;
    return count;
  }
  return [...String(data)].reduce((count, character) => count + (character === '\x03' ? 1 : 0), 0);
}

function removeInterruptBytes(data) {
  if (Buffer.isBuffer(data)) return Buffer.from([...data].filter((byte) => byte !== 0x03));
  return String(data).replaceAll('\x03', '');
}

function hasInput(value) {
  return Buffer.isBuffer(value) ? value.length > 0 : String(value).length > 0;
}
