'use strict';

/**
 * Base error class for all errors thrown by nimble-http.
 * Always carries the request `config`, and if available, the `response`
 * and a machine-readable `code` (similar in spirit to axios, but without
 * the extra layers of indirection).
 */
class HttpError extends Error {
  constructor(message, { config, request, response, code } = {}) {
    super(message);
    this.name = 'HttpError';
    this.config = config;
    this.request = request;
    this.response = response;
    this.code = code;
    this.isHttpError = true;

    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Thrown when a request exceeds `config.timeout`. */
class TimeoutError extends HttpError {
  constructor(config) {
    super(`Timeout of ${config.timeout}ms exceeded`, { config, code: 'ETIMEDOUT' });
    this.name = 'TimeoutError';
  }
}

/** Thrown when the request was aborted via `config.signal` (the user's own AbortController). */
class CanceledError extends HttpError {
  constructor(config) {
    super('Request canceled', { config, code: 'ERR_CANCELED' });
    this.name = 'CanceledError';
  }
}

/** Thrown on low-level connection problems (DNS failure, ECONNREFUSED, socket reset, etc). */
class NetworkError extends HttpError {
  constructor(message, config, original) {
    super(message, { config, code: (original && original.code) || 'ENETWORK' });
    this.name = 'NetworkError';
    this.original = original;
  }
}

module.exports = { HttpError, TimeoutError, CanceledError, NetworkError };
