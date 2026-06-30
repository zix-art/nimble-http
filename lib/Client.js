'use strict';

const { InterceptorManager } = require('./InterceptorManager');
const { HttpError, TimeoutError, CanceledError, NetworkError } = require('./errors');
const { buildURL, mergeHeaders, sleep } = require('./utils');
const { handleResponse } = require('./responseHandler');
const { prepareBody } = require('./body');
const { ResponseCache } = require('./cache');

const DEFAULTS = {
  baseURL: '',
  timeout: 0, // 0 = no timeout
  headers: {},
  params: undefined,
  maxRedirects: 5,
  maxContentLength: Infinity,
  retries: 0,
  retryDelay: 300, // base delay (ms); grows exponentially with jitter
  retryOn: [408, 429, 500, 502, 503, 504],
  retryOnNetworkError: true,
  retryOnTimeout: true,
  validateStatus: (status) => status >= 200 && status < 300,
  responseType: 'auto', // auto | json | text | buffer | stream
  cache: false, // false | true | ms | { ttl: ms } — only applies to GET/HEAD
};

/** Combines several AbortSignals into one that aborts as soon as any of them does. */
function anySignal(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 1) return valid[0];

  const controller = new AbortController();
  for (const signal of valid) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

class Client {
  constructor(config = {}) {
    this.defaults = { ...DEFAULTS, ...config, headers: mergeHeaders(DEFAULTS.headers, config.headers) };
    this.interceptors = {
      request: new InterceptorManager(),
      response: new InterceptorManager(),
    };
    this._cache = new ResponseCache();
  }

  /** Creates an independent instance, inheriting (and overriding) these defaults. */
  create(config = {}) {
    return new Client({ ...this.defaults, ...config });
  }

  /** Clears every entry in this instance's response cache. */
  clearCache() {
    this._cache.clear();
  }

  get(url, config) { return this.request({ ...config, method: 'GET', url }); }
  delete(url, config) { return this.request({ ...config, method: 'DELETE', url }); }
  head(url, config) { return this.request({ ...config, method: 'HEAD', url }); }
  options(url, config) { return this.request({ ...config, method: 'OPTIONS', url }); }
  post(url, data, config) { return this.request({ ...config, method: 'POST', url, data }); }
  put(url, data, config) { return this.request({ ...config, method: 'PUT', url, data }); }
  patch(url, data, config) { return this.request({ ...config, method: 'PATCH', url, data }); }

  /**
   * Performs an HTTP request, running it through request/response
   * interceptors, the response cache, and the retry loop.
   * @param {object|string} configInput
   */
  async request(configInput) {
    let config = this._mergeConfig(configInput);

    for (const handler of this._handlers('request')) {
      try {
        config = (await handler.onFulfilled(config)) || config;
      } catch (err) {
        if (handler.onRejected) return handler.onRejected(err);
        throw err;
      }
    }

    const cacheable = ResponseCache.isCacheable(config);
    let cacheKey = null;

    if (cacheable) {
      cacheKey = this._cache.key(config.method, buildURL(config.baseURL, config.url, config.params).toString());
      const cached = this._cache.get(cacheKey);
      if (cached) {
        return this._runResponseInterceptors(ResponseCache.clone(cached), null);
      }
    }

    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const response = await this._dispatch(config);

        if (!config.validateStatus(response.status)) {
          throw new HttpError(`Request failed with status code ${response.status}`, {
            config,
            response,
            code: 'ERR_BAD_RESPONSE',
          });
        }

        if (cacheable) {
          this._cache.set(cacheKey, response, ResponseCache.ttlFor(config));
        }

        return await this._runResponseInterceptors(response, null);
      } catch (err) {
        const status = err.response ? err.response.status : null;
        const canRetry = attempt < config.retries && this._isRetryable(err, status, config);

        if (!canRetry) {
          return this._runResponseInterceptors(null, err);
        }

        await sleep(this._computeRetryDelay(config, attempt));
        attempt += 1;
      }
    }
  }

  /** Single network attempt, built on native `fetch`: builds the request, awaits, and normalizes the response. */
  async _dispatch(config) {
    let requestURL;
    try {
      requestURL = buildURL(config.baseURL, config.url, config.params);
    } catch (err) {
      throw new HttpError(err.message, { config, code: 'ERR_INVALID_URL' });
    }

    const method = (config.method || 'GET').toUpperCase();
    const headers = mergeHeaders(config.headers);
    const allowsBody = !['GET', 'HEAD'].includes(method);

    let body;
    let isStream = false;
    if (allowsBody && config.data !== undefined && config.data !== null) {
      ({ body, isStream } = prepareBody(config.data, headers, config.onUploadProgress));
    }

    const timeoutController = new AbortController();
    const signal = anySignal([config.signal, timeoutController.signal]);

    let timer = null;
    if (config.timeout) {
      timer = setTimeout(() => timeoutController.abort(), config.timeout);
    }

    let res;
    try {
      res = await fetch(requestURL, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal,
        ...(isStream ? { duplex: 'half' } : {}),
        ...(config.dispatcher ? { dispatcher: config.dispatcher } : {}),
      });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        if (config.signal && config.signal.aborted) throw new CanceledError(config);
        throw new TimeoutError(config);
      }
      throw new NetworkError(err.message, config, err);
    } finally {
      if (timer) clearTimeout(timer);
    }

    return handleResponse({ res, config, requestURL, client: this });
  }

  async _runResponseInterceptors(response, error) {
    let result = response;
    let err = error;

    for (const handler of this._handlers('response')) {
      try {
        if (err) {
          if (handler.onRejected) {
            result = await handler.onRejected(err);
            err = null; // recovered by this handler
          }
        } else if (handler.onFulfilled) {
          result = await handler.onFulfilled(result);
        }
      } catch (e) {
        err = e;
        result = null;
      }
    }

    if (err) throw err;
    return result;
  }

  _handlers(type) {
    const list = [];
    this.interceptors[type].forEach((h) => list.push(h));
    return list;
  }

  _isRetryable(err, status, config) {
    if (status !== null) return config.retryOn.includes(status);
    if (err.name === 'TimeoutError') return config.retryOnTimeout;
    if (err.name === 'NetworkError') return config.retryOnNetworkError;
    return false;
  }

  _computeRetryDelay(config, attempt) {
    if (typeof config.retryDelay === 'function') return config.retryDelay(attempt);
    const base = config.retryDelay * 2 ** attempt;
    const jitter = Math.random() * base * 0.2;
    return base + jitter;
  }

  _mergeConfig(input) {
    const config = typeof input === 'string' ? { url: input } : { ...input };
    const merged = {
      ...this.defaults,
      ...config,
      headers: mergeHeaders(this.defaults.headers, config.headers),
    };
    if (!merged.url) throw new Error('config.url is required');
    merged.method = (merged.method || 'GET').toUpperCase();
    return merged;
  }
}

module.exports = { Client };
