import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
};
const MAX_BODY = 3 * 1024 * 1024;
const COOKIE_TTL = 16 * 3600;

/** HTTP-обёртка над ядром: статика, cookie с токеном, SSE-уведомления об изменениях. */
export function createHttpApp({ core, publicDir }) {
  const clients = new Set();
  core.onChange(() => { for (const res of clients) res.write(`data: ${Date.now()}\n\n`); });
  const keepAlive = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
  keepAlive.unref();

  const tokenOf = (req) => {
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === 'sc_token') return part.slice(i + 1).trim();
    }
    return null;
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body ?? null));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (ch) => {
        size += ch.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); return; }
        chunks.push(ch);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Некорректный JSON'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  async function serveStatic(req, res, pathname) {
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^([/\\])+/, '');
    const file = join(publicDir, rel);
    if (file !== publicDir && !file.startsWith(publicDir + sep)) return send(res, 403, { error: 'Нет доступа' });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not file');
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch {
      send(res, 404, { error: 'Не найдено' });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Метод не поддерживается' });
        return await serveStatic(req, res, url.pathname);
      }
      const token = tokenOf(req);
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!(await core.authenticate(token))) return send(res, 401, { error: 'Требуется вход' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const r = await core.dispatch({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers, token });
      const headers = {};
      if (typeof r.setToken === 'string') headers['Set-Cookie'] = `sc_token=${r.setToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_TTL}`;
      else if (r.setToken === null) headers['Set-Cookie'] = 'sc_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
      send(res, r.status, r.data, headers);
    } catch (e) {
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(`${req.method} ${req.url}`, e);
      send(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  return { handle, close() { clearInterval(keepAlive); for (const r of clients) r.end(); } };
}
