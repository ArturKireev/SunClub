// Транспорт к ядру приложения: локальный (в браузере) или серверный (HTTP). Выбирается автоматически.
let mode = 'local';
let local = null;
let onUnauthorized = null;
let feed = null;
const handlers = new Set();

export const getMode = () => mode;
export const getLocal = () => local;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

/** Подписка на изменения данных (в серверном режиме — из других вкладок/устройств, в локальном — после каждой операции). */
export const subscribeChanges = (fn) => { handlers.add(fn); };
const fire = () => handlers.forEach((f) => f());

export function startChangeFeed() {
  if (mode !== 'server' || feed) return;
  feed = new EventSource('api/events');
  feed.onmessage = fire;
}
export function stopChangeFeed() {
  feed?.close();
  feed = null;
}

/** Режим: ?mode=server|local в адресе, иначе — сервер, если по /api отвечает JSON, иначе локальный. */
export async function initBackend() {
  const forced = new URLSearchParams(location.search).get('mode');
  if (forced !== 'local') {
    try {
      const r = await fetch('api/login-users', { signal: AbortSignal.timeout(2500) });
      if ((r.headers.get('content-type') || '').includes('json')) { mode = 'server'; return mode; }
    } catch { /* сервера нет — работаем локально */ }
    if (forced === 'server') throw new Error('Сервер недоступен');
  }
  const { startLocalBackend } = await import('./local-backend.js');
  local = await startLocalBackend();
  local.onChange(fire);
  mode = 'local';
  return mode;
}

export async function api(method, path, body) {
  const p = path.replace(/^\//, '');
  let status;
  let data = null;
  if (mode === 'local') {
    ({ status, data } = await local.request(method, p, body));
  } else {
    const res = await fetch(p, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    try { data = await res.json(); } catch { /* пустой ответ */ }
  }
  if (status >= 400) {
    const e = new Error(data?.error || `Ошибка ${status}`);
    e.status = status;
    e.code = data?.code;
    if (status === 401 && p !== 'api/login') onUnauthorized?.();
    throw e;
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
