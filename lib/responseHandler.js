'use strict';

const { Readable } = require('stream');
const { HttpError } = require('./errors');
const { stripHeaders } = require('./utils');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headersToObject(fetchHeaders) {
  const obj = {};
  for (const [key, value] of fetchHeaders.entries()) {
    obj[key] = value;
  }
  return obj;
}

function parseBody(buffer, res, config) {
  if (config.responseType === 'buffer') return buffer;

  const contentType = res.headers.get('content-type') || '';
  let type = config.responseType;

  if (!type || type === 'auto') {
    type = contentType.includes('application/json') ? 'json' : 'text';
  }

  if (type === 'text') return buffer.toString('utf8');

  if (type === 'json') {
    const text = buffer.toString('utf8');
    if (!text.length) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text; // fall back to raw text if the body isn't actually valid JSON
    }
  }

  return buffer;
}

function buildResponseObject(res, data, config) {
  return {
    data,
    status: res.status,
    statusText: res.statusText,
    headers: headersToObject(res.headers),
    config,
  };
}

/**
 * Given a raw `fetch` Response (with `redirect: 'manual'`), either follows
 * a redirect (respecting `config.maxRedirects` and the spec's GET-downgrade
 * rules) or reads, decodes, and normalizes the body into a response object.
 *
 * Note: gzip/deflate/br decompression is handled transparently by Node's
 * `fetch` itself (per the Fetch spec) — no manual zlib step is needed here.
 */
async function handleResponse({ res, config, requestURL, client }) {
  if (REDIRECT_STATUSES.has(res.status) && res.headers.get('location') && config.maxRedirects > 0) {
    let redirectURL;
    try {
      redirectURL = new URL(res.headers.get('location'), requestURL).toString();
    } catch {
      throw new HttpError(`Invalid redirect location: ${res.headers.get('location')}`, {
        config,
        code: 'ERR_BAD_REDIRECT',
      });
    }

    const nextConfig = { ...config, url: redirectURL, baseURL: '', maxRedirects: config.maxRedirects - 1 };

    const convertToGet =
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && !['GET', 'HEAD'].includes(config.method));

    if (convertToGet) {
      nextConfig.method = 'GET';
      nextConfig.data = undefined;
      nextConfig.headers = stripHeaders(config.headers, ['content-length', 'content-type']);
    }

    return client._dispatch(nextConfig);
  }

  if (config.responseType === 'stream') {
    const nodeStream = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
    return buildResponseObject(res, nodeStream, config);
  }

  if (!res.body) {
    return buildResponseObject(res, parseBody(Buffer.alloc(0), res, config), config);
  }

  const total = Number(res.headers.get('content-length')) || null;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    received += value.length;

    if (config.onDownloadProgress) {
      config.onDownloadProgress({ loaded: received, total });
    }

    if (config.maxContentLength && received > config.maxContentLength) {
      await reader.cancel();
      throw new HttpError('maxContentLength exceeded', { config, code: 'ERR_MAX_CONTENT_LENGTH' });
    }
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buildResponseObject(res, parseBody(buffer, res, config), config);
}

module.exports = { handleResponse, buildResponseObject };
