'use strict';

const zlib = require('zlib');
const { URL } = require('url');
const { HttpError, NetworkError } = require('./errors');
const { stripHeaders } = require('./utils');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function buildResponseObject(res, body, config) {
  let data = body;

  if (Buffer.isBuffer(body)) {
    const contentType = res.headers['content-type'] || '';
    let type = config.responseType;

    if (!type || type === 'auto') {
      type = contentType.includes('application/json') ? 'json' : 'text';
    }

    if (type === 'json') {
      const text = body.toString('utf8');
      try {
        data = text.length ? JSON.parse(text) : null;
      } catch {
        data = text; // fall back to raw text if the body isn't actually valid JSON
      }
    } else if (type === 'text') {
      data = body.toString('utf8');
    } else if (type === 'buffer') {
      data = body;
    }
  }

  return {
    data,
    status: res.statusCode,
    statusText: res.statusMessage,
    headers: res.headers,
    config,
  };
}

/**
 * Handles an incoming http(s) response: follows redirects, decompresses
 * the body (gzip/deflate/br), tracks download progress, then resolves
 * with a normalized response object (or a readable stream, if requested).
 */
function handleResponse({ res, config, requestURL, client, resolve, reject }) {
  if (REDIRECT_STATUSES.has(res.statusCode) && res.headers.location && config.maxRedirects > 0) {
    res.resume(); // discard the body of the redirect response

    let redirectURL;
    try {
      redirectURL = new URL(res.headers.location, requestURL).toString();
    } catch (err) {
      return reject(new HttpError(`Invalid redirect location: ${res.headers.location}`, { config, code: 'ERR_BAD_REDIRECT' }));
    }

    const nextConfig = { ...config, url: redirectURL, baseURL: '', maxRedirects: config.maxRedirects - 1 };

    const convertToGet =
      res.statusCode === 303 ||
      ((res.statusCode === 301 || res.statusCode === 302) && !['GET', 'HEAD'].includes(config.method));

    if (convertToGet) {
      nextConfig.method = 'GET';
      nextConfig.data = undefined;
      nextConfig.headers = stripHeaders(config.headers, ['content-length', 'content-type']);
    }

    client._dispatch(nextConfig).then(resolve, reject);
    return;
  }

  let stream = res;
  const encoding = (res.headers['content-encoding'] || '').toLowerCase();

  if (config.decompress) {
    if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
    else if (encoding === 'br' && typeof zlib.createBrotliDecompress === 'function') {
      stream = res.pipe(zlib.createBrotliDecompress());
    }
  }

  if (config.responseType === 'stream') {
    resolve(buildResponseObject(res, stream, config));
    return;
  }

  const chunks = [];
  let received = 0;
  const total = Number(res.headers['content-length']) || null;

  stream.on('data', (chunk) => {
    chunks.push(chunk);
    received += chunk.length;

    if (config.onDownloadProgress) {
      config.onDownloadProgress({ loaded: received, total });
    }

    if (config.maxContentLength && received > config.maxContentLength) {
      stream.destroy();
      reject(new HttpError('maxContentLength exceeded', { config, code: 'ERR_MAX_CONTENT_LENGTH' }));
    }
  });

  stream.on('end', () => {
    resolve(buildResponseObject(res, Buffer.concat(chunks), config));
  });

  stream.on('error', (err) => {
    reject(new NetworkError(err.message, config, err));
  });
}

module.exports = { handleResponse, buildResponseObject };
