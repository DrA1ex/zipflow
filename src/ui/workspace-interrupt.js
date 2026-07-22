export function installWorkspaceInterruptHandler(app, controller) {
  if (!app || typeof app.handleInputEvent !== 'function') return () => {};
  const original = app.handleInputEvent;
  const intercepted = function handleZipflowInputEvent(event) {
    if (isWorkspaceInterruptEvent(event)) {
      void controller.handleInterrupt()
        .then(() => app.invalidate?.())
        .catch((error) => controller.handleUnexpected(error));
      return undefined;
    }
    return original.call(this, event);
  };
  app.handleInputEvent = intercepted;
  return () => {
    if (app.handleInputEvent === intercepted) app.handleInputEvent = original;
  };
}

export function isWorkspaceInterruptEvent(event) {
  if (!event || event.type === 'pointer') return false;
  const key = event.key ?? event;
  return key?.name === 'ctrl-c' || (key?.ctrl === true && String(key?.name ?? '').toLowerCase() === 'c');
}
