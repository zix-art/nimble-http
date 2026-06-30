'use strict';

const { isPlainObject } = require('./utils');

const DEFAULT_TTL = 60_000; // 60s

/**
 * Simple in-memory cache for GET/HEAD responses, opt-in via `config.cache`.
 * Each `Client` instance owns its own cache, so instances never leak data
 * to one another.
 *
 * `config.cache` accepts:
 *   - `false` / omitted -> caching disabled (default)
 *   - `true`            -> enabled, default 60s TTL
 *   - a number          -> enabled, custom TTL in ms
 *   - `{ ttl }`         -> enabled, custom TTL in ms
 */
class ResponseCache {
  constructor() {
    this.store = new Map();
  }

  static isCacheable(config) {
    if (!config.cache) return false;
    const method = (config.method || 'GET').toUpperCase();
    return method === 'GET' || method === 'HEAD';
  }

  static ttlFor(config) {
    if (typeof config.cache === 'number') return config.cache;
    if (isPlainObject(config.cache) && typeof config.cache.ttl === 'number') return config.cache.ttl;
    return DEFAULT_TTL;
  }

  key(method, url) {
    return `${method.toUpperCase()} ${url}`;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.response;
  }

  set(key, response, ttl) {
    this.store.set(key, { response, expiresAt: Date.now() + ttl });
  }

  clear() {
    this.store.clear();
  }

  /** Returns a deep, independent copy so cached entries can't be mutated by callers. */
  static clone(response) {
    return {
      ...response,
      data: typeof structuredClone === 'function' ? structuredClone(response.data) : response.data,
      headers: { ...response.headers },
      fromCache: true,
    };
  }
}

module.exports = { ResponseCache };
