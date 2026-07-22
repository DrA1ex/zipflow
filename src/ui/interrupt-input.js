const INTERRUPT_SENTINEL = '\x1a';

export function createInterruptAwareInput(input) {
  if (!input || typeof input.on !== 'function') return input;
  const wrappers = new Map();
  let proxy;
  const add = (method, event, listener) => {
    if (event !== 'data') {
      input[method](event, listener);
      return proxy;
    }
    const wrapped = (data) => listener(rewriteInterrupt(data));
    wrappers.set(listener, wrapped);
    input[method](event, wrapped);
    return proxy;
  };
  const remove = (method, event, listener) => {
    input[method](event, wrappers.get(listener) ?? listener);
    wrappers.delete(listener);
    return proxy;
  };
  proxy = new Proxy(input, {
    get(target, property) {
      if (property === 'on' || property === 'addListener') {
        return (event, listener) => add(property, event, listener);
      }
      if (property === 'once') {
        return (event, listener) => add('once', event, listener);
      }
      if (property === 'off' || property === 'removeListener') {
        return (event, listener) => remove(property, event, listener);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

function rewriteInterrupt(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const rewritten = text.replaceAll('\x03', INTERRUPT_SENTINEL);
  return Buffer.isBuffer(data) ? Buffer.from(rewritten) : rewritten;
}
