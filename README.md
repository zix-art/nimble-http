# nimble-http

HTTP client untuk Node.js — **zero dependency**, dibangun di atas `fetch()` native bawaan Node.js, dilengkapi interceptor, retry & timeout otomatis, response caching, FormData upload, follow-redirect, dan progress tracking upload/download.

Daripada nulis ulang networking layer dari nol, `nimble-http` memakai `fetch()` (sudah stabil & teruji sejak Node 18) sebagai fondasi, lalu menambal kekurangannya: `fetch` polos tidak punya interceptor, retry otomatis, baseURL/params helper, response caching bawaan, atau error class yang informatif. `nimble-http` menutup semua celah itu sambil tetap mewarisi kekuatan `fetch` (HTTP keep-alive, auto-decompress, dukungan HTTP/2 lewat undici).

## Kenapa ini "lebih bagus"?

| Fitur | nimble-http | axios | node-fetch / fetch polos |
|---|---|---|---|
| Dependency | **0** (`fetch` bawaan Node) | beberapa | 0 (fetch) / 1 (node-fetch) |
| Interceptor request/response | ✅ | ✅ | ❌ |
| Retry otomatis + exponential backoff | ✅ bawaan | ❌ (butuh `axios-retry`) | ❌ |
| Timeout per-request | ✅ | ✅ | ❌ (manual via AbortController) |
| Response caching bawaan | ✅ | ❌ | ❌ |
| FormData / file upload | ✅ native | ✅ (browser only) | ✅ manual |
| Auto decompress gzip/deflate/br | ✅ (otomatis dari `fetch`) | ✅ | ✅ |
| Upload/download progress | ✅ bawaan | ✅ (browser only) | ❌ |
| Cancel request | ✅ `AbortController` standar | API `CancelToken` lama (deprecated) | ✅ `AbortController` |
| baseURL + auto query params | ✅ | ✅ | ❌ |
| Error class informatif (`.config`, `.response`, `.code`) | ✅ | ✅ | ❌ (cuma `TypeError` generik) |

## Instalasi

```bash
npm install nimble-http
```

> **Catatan:** versi 2.x butuh **Node.js 18 ke atas** (syarat `fetch` native). Kalau masih pakai Node 16, tetap di versi `1.x`.


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

## Response caching

Bawaan, opt-in per-request atau per-instance. Hanya berlaku untuk `GET`/`HEAD`:

```js
// Aktifkan dengan TTL default 60 detik
await api.get('/posts/1', { cache: true });

// TTL custom (ms)
await api.get('/posts/1', { cache: 60_000 });
await api.get('/posts/1', { cache: { ttl: 5 * 60_000 } }); // 5 menit

// Request kedua dalam rentang TTL tidak akan menyentuh jaringan sama sekali
const res = await api.get('/posts/1', { cache: true });
console.log(res.fromCache); // true kalau diambil dari cache

// Bersihkan seluruh cache instance ini
api.clearCache();
```

Cache disimpan per-instance di memory (bukan shared antar instance, dan hilang saat proses restart). Cocok untuk data yang jarang berubah dalam satu siklus hidup aplikasi (config, lookup table, dsb) — bukan pengganti caching layer seperti Redis untuk kebutuhan production skala besar.

## FormData & upload file

`nimble-http` memakai `FormData`/`Blob` bawaan Node.js (tersedia global sejak Node 18) — tidak perlu library tambahan, dan `fetch` otomatis mengatur `Content-Type: multipart/form-data; boundary=...` yang benar:

```js
const form = new FormData();
form.append('title', 'Laporan Bulanan');
form.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), 'laporan.pdf');

await api.post('/upload', form);
// Jangan set header content-type manual untuk FormData — biarkan fetch yang atur boundary-nya
```



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
| `cache` | `false` | `false` \| `true` (TTL 60s) \| angka ms \| `{ ttl }`. Hanya untuk GET/HEAD |
| `maxRedirects` | `5` | Maksimal redirect yang diikuti |
| `maxContentLength` | `Infinity` | Batas ukuran response (byte) |
| `responseType` | `'auto'` | `auto` \| `json` \| `text` \| `buffer` \| `stream` |
| `validateStatus` | `2xx = sukses` | Fungsi custom untuk menentukan status sukses |
| `signal` | - | `AbortSignal` untuk cancel |
| `onUploadProgress` / `onDownloadProgress` | - | Callback progress |

> Decompression gzip/deflate/br kini otomatis dilakukan oleh `fetch` itu sendiri — tidak perlu (dan tidak bisa) dimatikan manual.

## Error handling

Semua error adalah instance dari `HttpError` (atau turunannya `TimeoutError`, `NetworkError`, `CanceledError`), dan selalu membawa `.config`. Kalau request sempat mendapat response, `.response` juga tersedia.

```js
const { HttpError, TimeoutError, NetworkError, CanceledError } = require('nimble-http');

try {
  await api.get('/data');
} catch (err) {
  if (err instanceof TimeoutError) { /* timeout internal (config.timeout) */ }
  else if (err instanceof CanceledError) { /* dibatalkan via config.signal/AbortController */ }
  else if (err instanceof NetworkError) { /* DNS gagal, koneksi putus, dst */ }
  else if (err.response) { console.log(err.response.status); }
}
```

## Keterbatasan yang jujur diakui

- Hanya untuk Node.js 18+ (tidak dirancang untuk jalan di browser; dan tidak support Node < 18 karena butuh `fetch` native).
- Upload progress untuk body Buffer/string itu "best effort" — `fetch` tidak punya event progress level-jaringan asli seperti `XMLHttpRequest`, jadi progress yang dilaporkan mengikuti kecepatan Node menyerahkan data ke stack jaringan, bukan kecepatan byte benar-benar terkirim ke server.
- Upload progress untuk Node stream mentah (`fs.createReadStream`, dll) hanya melaporkan status awal (indeterminate), bukan progress byte-per-byte — pakai Buffer/string kalau butuh tracking presisi.
- Response cache bersifat in-memory per-instance, bukan pengganti caching layer terdistribusi (Redis, dll) untuk skala production.
- Belum ada dukungan proxy bawaan — tapi bisa lewat `config.dispatcher` (diteruskan langsung ke `fetch`, menerima instance `undici.ProxyAgent` kalau butuh).

## Changelog

### 2.0.0 (Breaking)
- **Rebase total**: mesin di dalam (`_dispatch`) sekarang pakai `fetch()` native Node, bukan modul `http`/`https` manual.
- Minimum Node naik dari `>=16` ke `>=18`.
- Tambah **response caching** bawaan (`config.cache`).
- Tambah dukungan **FormData/Blob** native untuk upload file & multipart.
- Decompression gzip/deflate/br kini otomatis lewat `fetch` — opsi `decompress` dihapus (tidak relevan lagi).
- Error abort sekarang dipecah jadi 2: `TimeoutError` (timeout internal) vs `CanceledError` (dibatalkan manual via `AbortController`). Sebelumnya satu kode `ERR_ABORTED` untuk keduanya.
- Opsi `agent` (Node http.Agent) dihapus; pakai `config.dispatcher` (undici) sebagai gantinya kalau perlu kontrol koneksi tingkat lanjut.

### 1.0.0
- Rilis awal berbasis modul `http`/`https` manual.

## Testing

```bash
npm test
```

Semua test memakai server HTTP lokal sungguhan (bukan mock), jadi perilaku retry, timeout, redirect, dan decompression benar-benar diuji end-to-end.
