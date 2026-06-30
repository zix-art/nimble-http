'use strict';

const { Client } = require('./lib/Client');
const { HttpError, TimeoutError, CanceledError, NetworkError } = require('./lib/errors');

// Default ready-to-use instance — `const http = require('nimble-http'); http.get(...)`
const instance = new Client();

instance.Client = Client;
instance.create = (config) => new Client(config);
instance.HttpError = HttpError;
instance.TimeoutError = TimeoutError;
instance.CanceledError = CanceledError;
instance.NetworkError = NetworkError;
// Re-exported for convenience so callers don't need a separate `global.FormData` import.
instance.FormData = globalThis.FormData;

module.exports = instance;
