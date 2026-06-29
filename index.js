'use strict';

const { Client } = require('./lib/Client');
const { HttpError, TimeoutError, NetworkError } = require('./lib/errors');

// Default ready-to-use instance — `const http = require('nimble-http'); http.get(...)`
const instance = new Client();

instance.Client = Client;
instance.create = (config) => new Client(config);
instance.HttpError = HttpError;
instance.TimeoutError = TimeoutError;
instance.NetworkError = NetworkError;

module.exports = instance;
