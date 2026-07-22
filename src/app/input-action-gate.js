export class InputActionGate {
  constructor() {
    this.active = null;
  }

  async run(action) {
    if (typeof action !== 'function') throw new TypeError('Input action must be a function.');
    if (this.active) return false;
    const task = Promise.resolve().then(action);
    this.active = task;
    try {
      await task;
      return true;
    } finally {
      if (this.active === task) this.active = null;
    }
  }
}
