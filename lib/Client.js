'use strict';

const http = require('http');
const https = require('https');

const { InterceptorManager } = require('./InterceptorManager');
const { HttpError, TimeoutError, NetworkError } = require('./errors');
const { buildURL, mergeHeaders, isPlainObject, sleep } = require('./utils');
const { handleResponse } = require('./responseHandler');

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
  decompress: true,
};

class Client {
  constructor(config = {}) {
    this.defaults = { ...DEFAULTS, ...config, headers: mergeHeaders(DEFAULTS.headers, config.headers) };
    this.interceptors = {
      request: new InterceptorManager(),
      response: new InterceptorManager(),
    };
  }

  /** Creates an independent instance, inheriting (and overriding) these defaults. */
  create(config = {}) {
    const instance = new Client({ ...this.defaults, ...config });
    return instance;
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
   * interceptors and the retry loop.
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

  /** Single network attempt: builds the request, writes the body, awaits the response. */
  _dispatch(config) {
    return new Promise((resolve, reject) => {
      let requestURL;
      try {
        requestURL = buildURL(config.baseURL, config.url, config.params);
      } catch (err) {
        return reject(new HttpError(err.message, { config, code: 'ERR_INVALID_URL' }));
      }

      const isHttps = requestURL.protocol === 'https:';
      const transport = isHttps ? https : http;
      const headers = mergeHeaders(config.headers);

      let bodyData = null;
      let isStreamBody = false;

      if (config.data !== undefined && config.data !== null) {
        if (typeof config.data.pipe === 'function') {
          isStreamBody = true;
        } else if (Buffer.isBuffer(config.data) || typeof config.data === 'string') {
          bodyData = config.data;
        } else if (isPlainObject(config.data) || Array.isArray(config.data)) {
          bodyData = JSON.stringify(config.data);
          if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
        } else {
          bodyData = String(config.data);
        }

        if (!isStreamBody) headers['content-length'] = Buffer.byteLength(bodyData);
      }

      if (config.decompress && !headers['accept-encoding']) {
        headers['accept-encoding'] = 'gzip, deflate, br';
      }

      const options = {
        method: config.method || 'GET',
        hostname: requestURL.hostname,
        port: requestURL.port || (isHttps ? 443 : 80),
        path: requestURL.pathname + requestURL.search,
        headers,
        agent: config.agent,
      };

      const req = transport.request(options, (res) => {
        handleResponse({ res, config, requestURL, client: this, resolve, reject });
      });

      let timer = null;
      if (config.timeout) {
        timer = setTimeout(() => {
          req.destroy();
          reject(new TimeoutError(config));
        }, config.timeout);
      }

      const clearTimer = () => { if (timer) clearTimeout(timer); };

      req.on('error', (err) => {
        clearTimer();
        reject(new NetworkError(err.message, config, err));
      });
      req.on('close', clearTimer);

      if (config.signal) {
        const abortNow = () => {
          clearTimer();
          req.destroy();
          reject(new HttpError('Request aborted', { config, code: 'ERR_ABORTED' }));
        };

        if (config.signal.aborted) {
          return abortNow();
        }
        config.signal.addEventListener('abort', abortNow, { once: true });
      }

      if (isStreamBody) {
        config.data.pipe(req);
      } else if (bodyData && config.onUploadProgress) {
        this._writeWithProgress(req, bodyData, config.onUploadProgress);
      } else if (bodyData) {
        req.end(bodyData);
      } else {
        req.end();
      }
    });
  }

  _writeWithProgress(req, buffer, onProgress) {
    const total = buffer.length;
    const chunkSize = 64 * 1024;
    let sent = 0;

    const writeNext = () => {
      if (sent >= total) return req.end();
      const chunk = buffer.subarray(sent, sent + chunkSize);
      req.write(chunk, () => {
        sent += chunk.length;
        onProgress({ loaded: sent, total });
        writeNext();
      });
    };

    writeNext();
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
    return merged;
  }
}

module.exports = { Client };
