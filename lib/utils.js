'use strict';

const { URL } = require('url');

function isPlainObject(val) {
  return Object.prototype.toString.call(val) === '[object Object]';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves a (possibly relative) URL string + query params into a full URL object. */
function buildURL(baseURL, url, params) {
  if (!url) throw new Error('config.url is required');

  const hasProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(url);
  let full;

  if (hasProtocol) {
    full = new URL(url);
  } else if (baseURL) {
    const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
    full = new URL(url.replace(/^\/+/, ''), base);
  } else {
    throw new Error(`Invalid URL "${url}": must be absolute, or "baseURL" must be set`);
  }

  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        value.forEach((v) => full.searchParams.append(key, v));
      } else {
        full.searchParams.append(key, value);
      }
    }
  }

  return full;
}

/** Merges N header objects, normalizing keys to lowercase (last one wins). */
function mergeHeaders(...sources) {
  const result = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null) continue;
      result[k.toLowerCase()] = v;
    }
  }
  return result;
}

/** Removes a header case-insensitively, returning a new object. */
function stripHeaders(headers, names) {
  const result = { ...headers };
  const lowerNames = names.map((n) => n.toLowerCase());
  for (const key of Object.keys(result)) {
    if (lowerNames.includes(key.toLowerCase())) delete result[key];
  }
  return result;
}

module.exports = { isPlainObject, sleep, buildURL, mergeHeaders, stripHeaders };
