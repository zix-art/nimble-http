'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const client = require('../index');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseURLOf(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('GET request parses JSON response automatically', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
  });

  const res = await client.get('/anything', { baseURL: baseURLOf(server) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { hello: 'world' });

  server.close();
});

test('POST serializes plain object body as JSON with correct headers', async () => {
  let receivedBody = '';
  let receivedContentType = '';

  const server = await startServer((req, res) => {
    receivedContentType = req.headers['content-type'];
    req.on('data', (chunk) => (receivedBody += chunk));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const res = await client.post('/items', { name: 'pulpen' }, { baseURL: baseURLOf(server) });

  assert.equal(res.status, 201);
  assert.match(receivedContentType, /application\/json/);
  assert.deepEqual(JSON.parse(receivedBody), { name: 'pulpen' });

  server.close();
});

test('automatically retries on 503 then succeeds', async () => {
  let attempts = 0;

  const server = await startServer((req, res) => {
    attempts += 1;
    if (attempts < 3) {
      res.writeHead(503);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('akhirnya berhasil');
    }
  });

  const res = await client.get('/flaky', {
    baseURL: baseURLOf(server),
    retries: 3,
    retryDelay: 5,
  });

  assert.equal(attempts, 3);
  assert.equal(res.data, 'akhirnya berhasil');

  server.close();
});

test('throws TimeoutError when server is too slow', async () => {
  const server = await startServer((req, res) => {
    setTimeout(() => res.end('telat'), 200);
  });

  await assert.rejects(
    client.get('/slow', { baseURL: baseURLOf(server), timeout: 30 }),
    (err) => {
      assert.equal(err.name, 'TimeoutError');
      return true;
    }
  );

  server.close();
});

test('request and response interceptors run in order', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echoedAuth: req.headers.authorization }));
  });

  const instance = client.create({ baseURL: baseURLOf(server) });

  instance.interceptors.request.use((config) => {
    config.headers = { ...config.headers, authorization: 'Bearer xyz' };
    return config;
  });

  instance.interceptors.response.use((response) => {
    response.data.intercepted = true;
    return response.data;
  });

  const data = await instance.get('/secure');

  assert.equal(data.echoedAuth, 'Bearer xyz');
  assert.equal(data.intercepted, true);

  server.close();
});

test('follows redirects and decompresses gzip body', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    const payload = JSON.stringify({ message: 'sudah dikompresi' });
    const gzipped = zlib.gzipSync(payload);
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(gzipped);
  });

  const res = await client.get('/start', { baseURL: baseURLOf(server) });
  assert.deepEqual(res.data, { message: 'sudah dikompresi' });

  server.close();
});

test('uploads FormData with files as real multipart/form-data', async () => {
  let receivedFieldValue = '';
  let receivedFileContent = '';
  let receivedContentType = '';

  const server = await startServer((req, res) => {
    receivedContentType = req.headers['content-type'];
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // crude multipart parsing, just enough to assert the fields arrived
      receivedFieldValue = /name="title"\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '';
      receivedFileContent = /filename="note\.txt"[\s\S]*?\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const form = new FormData();
  form.append('title', 'laporan bulanan');
  form.append('file', new Blob(['isi catatan'], { type: 'text/plain' }), 'note.txt');

  const res = await client.post('/upload', form, { baseURL: baseURLOf(server) });

  assert.equal(res.status, 200);
  assert.match(receivedContentType, /multipart\/form-data/);
  assert.equal(receivedFieldValue, 'laporan bulanan');
  assert.equal(receivedFileContent, 'isi catatan');

  server.close();
});

test('response cache serves repeated GETs without hitting the server again', async () => {
  let hits = 0;

  const server = await startServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hits }));
  });

  const instance = client.create({ baseURL: baseURLOf(server), cache: true });

  const first = await instance.get('/cached');
  const second = await instance.get('/cached');

  assert.equal(hits, 1); // server only actually hit once
  assert.deepEqual(first.data, { hits: 1 });
  assert.deepEqual(second.data, { hits: 1 });
  assert.equal(second.fromCache, true);

  instance.clearCache();
  const third = await instance.get('/cached');
  assert.equal(hits, 2); // cache cleared, server hit again

  server.close();
});

test('AbortController cancels an in-flight request', async () => {
  const server = await startServer((req, res) => {
    setTimeout(() => res.end('telat lagi'), 500);
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    client.get('/abort-me', { baseURL: baseURLOf(server), signal: controller.signal }),
    (err) => {
      assert.equal(err.name, 'CanceledError');
      assert.equal(err.code, 'ERR_CANCELED');
      return true;
    }
  );

  server.close();
});
