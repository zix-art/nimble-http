'use strict';

const { Readable } = require('stream');
const { isPlainObject } = require('./utils');

/** True if `val` is a WHATWG ReadableStream (web stream), the kind `fetch` expects for streaming bodies. */
function isWebReadableStream(val) {
  return val && typeof val.getReader === 'function';
}

/** True if `val` is a Node.js Readable stream (has `.pipe`). */
function isNodeStream(val) {
  return val && typeof val.pipe === 'function';
}

/**
 * Wraps a Buffer in a WHATWG ReadableStream that reports progress as it's
 * read, since `fetch` itself has no upload-progress event. The pacing here
 * reflects how fast Node hands the bytes to the network stack, which is a
 * reasonable proxy for upload progress, but isn't a true wire-level signal.
 */
function bufferToProgressStream(buffer, onProgress) {
  const total = buffer.length;
  let sent = 0;
  const chunkSize = 64 * 1024;

  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const chunk = buffer.subarray(sent, sent + chunkSize);
      controller.enqueue(chunk);
      sent += chunk.length;
      onProgress({ loaded: sent, total: total || null });
    },
  });
}

/**
 * Normalizes `config.data` into a body `fetch` understands, and mutates
 * `headers` with the right `content-type` when one isn't already set.
 * Returns `{ body, isStream }`. `isStream` tells the caller to set
 * `duplex: 'half'`, which Node's fetch requires for streaming request bodies.
 */
function prepareBody(data, headers, onUploadProgress) {
  if (data === undefined || data === null) return { body: undefined, isStream: false };

  // FormData/Blob: let fetch generate the correct (multipart) content-type itself.
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    return { body: data, isStream: false };
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return { body: data, isStream: false };
  }
  if (data instanceof URLSearchParams) {
    if (!headers['content-type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return { body: data, isStream: false };
  }

  if (isNodeStream(data)) {
    const webStream = Readable.toWeb(data);
    if (onUploadProgress) {
      // We can't easily tee progress out of an arbitrary Node stream without
      // also re-chunking it, so for raw streams we report indeterminate
      // progress (no `total`) at the start; precise byte tracking is only
      // available for Buffer/string bodies, see below.
      onUploadProgress({ loaded: 0, total: null });
    }
    return { body: webStream, isStream: true };
  }

  if (isWebReadableStream(data)) {
    return { body: data, isStream: true };
  }

  if (Buffer.isBuffer(data) || typeof data === 'string') {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (onUploadProgress) {
      return { body: bufferToProgressStream(buffer, onUploadProgress), isStream: true };
    }
    return { body: data, isStream: false };
  }

  if (isPlainObject(data) || Array.isArray(data)) {
    if (!headers['content-type']) {
      headers['content-type'] = 'application/json;charset=utf-8';
    }
    const json = JSON.stringify(data);
    if (onUploadProgress) {
      return { body: bufferToProgressStream(Buffer.from(json), onUploadProgress), isStream: true };
    }
    return { body: json, isStream: false };
  }

  return { body: String(data), isStream: false };
}

module.exports = { prepareBody, isWebReadableStream, isNodeStream };
