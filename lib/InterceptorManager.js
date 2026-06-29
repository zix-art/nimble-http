'use strict';

/**
 * Manages a chain of request/response interceptors.
 * Each handler can be async. Returning a value from `onFulfilled`
 * replaces the config/response passed down the chain; throwing (or
 * returning a rejected promise) hands control to the next handler's
 * `onRejected`, letting errors be recovered from mid-chain.
 */
class InterceptorManager {
  constructor() {
    this.handlers = [];
  }

  /**
   * @param {Function} onFulfilled
   * @param {Function} [onRejected]
   * @returns {number} id - pass to `.eject(id)` to remove this handler later
   */
  use(onFulfilled, onRejected) {
    this.handlers.push({ onFulfilled, onRejected });
    return this.handlers.length - 1;
  }

  /** Removes a previously registered handler by its id. */
  eject(id) {
    if (this.handlers[id]) {
      this.handlers[id] = null;
    }
  }

  /** Iterates over all active (non-ejected) handlers. */
  forEach(fn) {
    this.handlers.forEach((h) => {
      if (h !== null) fn(h);
    });
  }
}

module.exports = { InterceptorManager };
