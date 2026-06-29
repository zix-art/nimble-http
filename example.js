'use strict';

const http = require('./index');

async function main() {
  // 1. Instance dengan default (baseURL, header, timeout, retry otomatis)
  const api = http.create({
    baseURL: 'https://jsonplaceholder.typicode.com',
    timeout: 5000,
    retries: 2, // otomatis retry 2x kalau gagal/5xx/timeout
    headers: { 'x-app': 'nimble-http-example' },
  });

  // 2. Request interceptor — misal sisipkan token ke setiap request
  api.interceptors.request.use((config) => {
    config.headers = { ...config.headers, authorization: 'Bearer demo-token' };
    return config;
  });

  // 3. Response interceptor — unwrap data, atau tangani error global
  api.interceptors.response.use(
    (response) => response.data, // langsung return body-nya saja
    (error) => {
      console.error('[interceptor] request gagal:', error.message);
      throw error;
    }
  );

  // GET sederhana
  const post = await api.get('/posts/1');
  console.log('GET /posts/1 ->', post);

  // POST dengan body JSON otomatis di-stringify
  const created = await api.post('/posts', { title: 'halo', body: 'dunia', userId: 1 });
  console.log('POST /posts ->', created);

  // Timeout + retry otomatis (akan retry kalau timeout/5xx)
  try {
    await api.get('/posts/1', { timeout: 50, retries: 1 }); // sengaja super pendek
  } catch (err) {
    console.log('Contoh timeout tertangkap:', err.name, err.code);
  }

  // Cancel request dengan AbortController standar (tidak butuh API proprietary)
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  try {
    await api.get('/posts', { signal: controller.signal });
  } catch (err) {
    console.log('Contoh abort tertangkap:', err.code);
  }
}

main().catch((err) => {
  console.error('Gagal:', err);
  process.exitCode = 1;
});
