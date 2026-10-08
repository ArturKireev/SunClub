import { get } from './api.js';
import { toast } from './ui.js';
import { playSeconds, checkTotals } from './shared/billing.js';

export const store = {
  state: null,
  offset: 0,
  sessions: new Map(),
  checks: new Map(),
  onChange: () => {},
};

/** Серверное время (часы планшета могут отставать). */
export const now = () => Date.now() + store.offset;

export async function loadState() {
  const s = await get('/api/state');
  store.offset = s.now - Date.now();
  store.state = s;
  store.sessions = new Map();
  store.checks = new Map();
  for (const c of s.checks) {
    store.checks.set(c.id, c);
    for (const x of c.sessions) store.sessions.set(x.id, x);
  }
  store.onChange();
  return s;
}

export const tableCheck = (tableId) => store.state.checks.find((c) => c.table_id === tableId && c.kind === 'table') || null;
export const liveSessionOf = (check) => check?.sessions.find((s) => s.status !== 'ended') || null;
export const isAdmin = () => store.state?.user.role === 'admin';
export const productById = (id) => store.state.products.find((p) => p.id === id);

/** Итоги чека «прямо сейчас» (по клиентским часам, скорректированным на сервер). */
export const liveTotals = (check) => checkTotals(check, check.lines, check.sessions, store.state.settings, now());
export const liveSeconds = (session) => playSeconds(session, now());

/**
 * Выполняет действие: показывает предупреждения/ошибки, затем обновляет состояние.
 * Возвращает результат действия или false при ошибке.
 */
export async function act(fn, okMsg) {
  try {
    const r = await fn();
    (r?.warnings || []).forEach((w) => toast(w, 'warn'));
    if (okMsg) toast(okMsg);
    await loadState();
    return r ?? true;
  } catch (e) {
    toast(e.message, 'err');
    await loadState().catch(() => {});
    return false;
  }
}
