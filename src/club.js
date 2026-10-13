import { DurableObject } from 'cloudflare:workers';
import { initDb, seedIfEmpty } from '../public/js/core/db.js';
import { createLamps } from '../public/js/core/lamps.js';
import { createCore } from '../public/js/core/api.js';
import { wrapDoSql } from './do-sql.js';

const COOKIE_TTL = 16 * 3600;
const MAX_BODY = 3 * 1024 * 1024;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body ?? null), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

function tokenOf(req) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'sc_token') return part.slice(i + 1).trim();
  }
  return null;
}

/** Единственный экземпляр на клуб: база SQLite внутри Durable Object, то же ядро, что в браузере и на Node. */
export class Club extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Set();
    this.enc = new TextEncoder();
    this.ctx.blockConcurrencyWhile(async () => {
      const db = wrapDoSql(ctx);
      initDb(db);
      await seedIfEmpty(db);
      this.core = createCore({ db, lamps: createLamps(db) });
      this.core.onChange(() => this.broadcast());
    });
  }

  broadcast() {
    const msg = this.enc.encode(`data: ${Date.now()}\n\n`);
    for (const w of this.clients) w.write(msg).catch(() => this.clients.delete(w));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const token = tokenOf(req);
    try {
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!(await this.core.authenticate(token))) return json(401, { error: 'Требуется вход' });
        const { readable, writable } = new TransformStream();
        const w = writable.getWriter();
        w.write(this.enc.encode('retry: 3000\n\n'));
        this.clients.add(w);
        req.signal.addEventListener('abort', () => this.clients.delete(w));
        return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
      }
      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        const text = await req.text();
        if (text.length > MAX_BODY) return json(413, { error: 'Слишком большой запрос' });
        if (text) { try { body = JSON.parse(text); } catch { return json(400, { error: 'Некорректный JSON' }); } }
      }
      const headers = Object.fromEntries(req.headers);
      const r = await this.core.dispatch({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers, token });
      const h = {};
      if (typeof r.setToken === 'string') h['Set-Cookie'] = `sc_token=${r.setToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_TTL}`;
      else if (r.setToken === null) h['Set-Cookie'] = 'sc_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
      return json(r.status, r.data, h);
    } catch (e) {
      console.error(`${req.method} ${req.url}`, e);
      return json(500, { error: 'Внутренняя ошибка сервера' });
    }
  }
}
