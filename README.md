# nimble-http

HTTP client untuk Node.js — **zero dependency**, dengan interceptor, retry & timeout otomatis, follow-redirect, decompression gzip/deflate/brotli otomatis, dan progress tracking upload/download bawaan.

Dibuat sebagai alternatif yang lebih lengkap & lebih ringan dibanding `axios` (yang punya banyak dependency transitif) dan `node-fetch` (yang fiturnya minimal).

## Kenapa ini "lebih bagus"?

| Fitur | nimble-http | axios | node-fetch |
|---|---|---|---|
| Dependency | **0** | beberapa (follow-redirects, dll) | beberapa |
| Interceptor request/response | ✅ | ✅ | ❌ |
| Retry otomatis + exponential backoff | ✅ bawaan | ❌ (butuh `axios-retry`) | ❌ |
| Timeout per-request | ✅ | ✅ | ❌ (manual via AbortController) |
| Auto decompress gzip/deflate/br | ✅ | ✅ | ✅ |
| Upload/download progress | ✅ bawaan | ✅ (browser only) | ❌ |
| Cancel request | ✅ `AbortController` standar | API `CancelToken` lama (deprecated) | ✅ `AbortController` |
| Ukuran | inti < 500 baris, tanpa `node_modules` | besar | kecil tapi fiturnya juga minim |

## Instalasi

Karena ini module lokal (belum dipublish ke npm), tinggal copy folder ini ke project-mu, atau:

```bash
npm install ./nimble-http
```

## Pemakaian dasar

```js
const http = require('nimble-http');

// GET
const res = await http.get('https://api.example.com/users/1');
console.log(res.data, res.status);

// POST — object otomatis di-JSON.stringify + header content-type otomatis
await http.post('https://api.example.com/users', { name: 'Budi' });
```

## Buat instance dengan konfigurasi default (seperti `axios.create`)

```js
const api = http.create({
  baseURL: 'https://api.example.com',
  timeout: 5000,
  retries: 3,            // otomatis retry sampai 3x kalau gagal
  headers: { 'x-api-key': 'rahasia' },
});

await api.get('/users/1'); // -> https://api.example.com/users/1
```

## Interceptor

```js
// Sisipkan token ke setiap request
api.interceptors.request.use((config) => {
  config.headers.authorization = `Bearer ${getToken()}`;
  return config;
});

// Tangani error secara global, atau "unwrap" data
api.interceptors.response.use(
  (response) => response.data,        // langsung dapat body-nya
  (error) => {
    if (error.response?.status === 401) refreshToken();
    throw error;
  }
);
```

## Retry & timeout otomatis

```js
await api.get('/data', {
  timeout: 3000,          // gagal kalau lebih dari 3 detik
  retries: 3,              // coba ulang sampai 3x
  retryOn: [500, 502, 503, 504, 429], // status yang memicu retry
  retryDelay: 300,         // delay dasar (ms), naik exponential + jitter setiap percobaan
});
```

Network error (DNS gagal, koneksi putus) dan timeout otomatis di-retry juga (atur lewat `retryOnNetworkError` / `retryOnTimeout`, default `true`).

## Cancel request

Pakai `AbortController` bawaan JavaScript — tidak perlu API proprietary:

```js
const controller = new AbortController();
const promise = api.get('/data', { signal: controller.signal });

setTimeout(() => controller.abort(), 1000); // batalkan setelah 1 detik
```

## Progress upload/download

```js
await api.post('/upload', bigBuffer, {
  onUploadProgress: ({ loaded, total }) => console.log(`${loaded}/${total}`),
});

await api.get('/download/file.zip', {
  responseType: 'buffer',
  onDownloadProgress: ({ loaded, total }) => console.log(`${loaded}/${total ?? '?'}`),
});
```

## Streaming

```js
// Body request berupa stream (misal file besar) — langsung di-pipe, tanpa di-buffer dulu
const fs = require('fs');
await api.post('/upload', fs.createReadStream('./video.mp4'));

// Response sebagai stream (tidak di-buffer ke memory)
const res = await api.get('/download/big-file', { responseType: 'stream' });
res.data.pipe(fs.createWriteStream('./output.bin'));
```

## Konfigurasi lengkap

| Opsi | Default | Keterangan |
|---|---|---|
| `baseURL` | `''` | Prefix untuk semua URL relatif |
| `timeout` | `0` (tanpa batas) | Timeout dalam ms |
| `headers` | `{}` | Header default |
| `params` | - | Object yang diserialize jadi query string |
| `retries` | `0` | Jumlah percobaan ulang otomatis |
| `retryDelay` | `300` | Delay dasar (ms) retry, exponential backoff |
| `retryOn` | `[408,429,500,502,503,504]` | Status code yang memicu retry |
| `maxRedirects` | `5` | Maksimal redirect yang diikuti |
| `maxContentLength` | `Infinity` | Batas ukuran response (byte) |
| `responseType` | `'auto'` | `auto` \| `json` \| `text` \| `buffer` \| `stream` |
| `decompress` | `true` | Auto-decompress gzip/deflate/br |
| `validateStatus` | `2xx = sukses` | Fungsi custom untuk menentukan status sukses |
| `signal` | - | `AbortSignal` untuk cancel |
| `onUploadProgress` / `onDownloadProgress` | - | Callback progress |

## Error handling

Semua error adalah instance dari `HttpError` (atau turunannya `TimeoutError`, `NetworkError`), dan selalu membawa `.config`. Kalau request sempat mendapat response, `.response` juga tersedia.

```js
const { HttpError, TimeoutError, NetworkError } = require('nimble-http');

try {
  await api.get('/data');
} catch (err) {
  if (err instanceof TimeoutError) { /* ... */ }
  else if (err instanceof NetworkError) { /* ... */ }
  else if (err.response) { console.log(err.response.status); }
}
```

## Keterbatasan yang jujur diakui

- Hanya untuk Node.js (tidak dirancang untuk jalan di browser).
- Belum ada dukungan proxy bawaan atau HTTP/2 — bisa ditambahkan lewat opsi `agent` custom kalau perlu.
- Belum ada caching bawaan (sengaja, sesuai kebutuhan yang diprioritaskan saat desain).

## Testing

```bash
npm test
```

Semua test memakai server HTTP lokal sungguhan (bukan mock), jadi perilaku retry, timeout, redirect, dan decompression benar-benar diuji end-to-end.
