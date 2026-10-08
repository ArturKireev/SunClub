// Браузерный режим: ядро приложения работает прямо на устройстве, данные лежат в IndexedDB.
// Сервер не нужен, поэтому нет сетевых задержек; программу можно раздавать со статического хостинга (GitHub Pages).
import { createCore } from './core/api.js';
import { initDb, seedIfEmpty } from './core/db.js';
import { createLamps } from './core/lamps.js';
import { wrapSqlJs } from './core/sqljs-db.js';

const IDB_NAME = 'sunclub';
const STORE = 'kv';
const KEY = 'db';
const TOKEN_KEY = 'sc_token';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(bytes) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tr = db.transaction(STORE, 'readwrite');
    tr.objectStore(STORE).put(bytes, KEY);
    tr.oncomplete = () => resolve();
    tr.onerror = () => reject(tr.error);
    tr.onabort = () => reject(tr.error);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.initSqlJs) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить модуль базы данных'));
    document.head.append(s);
  });
}

/** Только одна вкладка может работать с локальной базой, иначе они затрут данные друг друга. */
async function acquireLock() {
  if (!navigator.locks) return true;
  return new Promise((resolve) => {
    navigator.locks.request('sunclub-local-db', { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;
    });
  });
}

export async function startLocalBackend() {
  if (!(await acquireLock())) throw Object.assign(new Error('Программа уже открыта в другой вкладке или окне. Закройте её там и обновите страницу.'), { code: 'locked' });
  await loadScript('vendor/sql-wasm.js');
  const SQL = await globalThis.initSqlJs({ locateFile: (f) => `vendor/${f}` });
  const sql = new SQL.Database((await idbGet()) || undefined);
  const db = wrapSqlJs(sql);
  const fk = () => sql.run('PRAGMA foreign_keys = ON;');
  fk();
  initDb(db);
  await seedIfEmpty(db);
  const core = createCore({ db, lamps: createLamps(db) });
  navigator.storage?.persist?.().catch(() => {});

  // Сохраняем базу после каждого изменения (файл маленький, выгрузка занимает миллисекунды).
  let saving = Promise.resolve();
  const snapshot = () => {
    const bytes = sql.export(); // export закрывает и переоткрывает БД, поэтому заново включаем внешние ключи
    fk();
    return bytes;
  };
  const persist = () => {
    const bytes = snapshot();
    saving = saving.then(() => idbPut(bytes)).catch((e) => console.error('Не удалось сохранить базу', e));
    return saving;
  };
  await persist();

  return {
    async request(method, path, body) {
      const url = new URL(path, 'http://local');
      const r = await core.dispatch({
        method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ?? {},
        token: sessionStorage.getItem(TOKEN_KEY),
      });
      if (typeof r.setToken === 'string') sessionStorage.setItem(TOKEN_KEY, r.setToken);
      else if (r.setToken === null) sessionStorage.removeItem(TOKEN_KEY);
      if (method !== 'GET') await persist();
      return r;
    },
    onChange: (fn) => core.onChange(fn),
    /** Резервная копия: файл SQLite целиком. */
    exportBackup: () => snapshot(),
    /** Восстановление из файла: проверяем структуру, сохраняем и перезагружаем страницу. */
    async importBackup(bytes) {
      let ok = false;
      try {
        const probe = new SQL.Database(bytes);
        ok = probe.exec("SELECT name FROM sqlite_master WHERE name IN ('users','checks','shifts','payments')")[0]?.values.length === 4;
        probe.close();
      } catch { ok = false; }
      if (!ok) throw new Error('Это не файл резервной копии SunClub');
      await saving;
      await idbPut(bytes);
      sessionStorage.removeItem(TOKEN_KEY);
      location.reload();
    },
  };
}
