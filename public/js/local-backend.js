// Браузерный режим: ядро приложения работает прямо на устройстве, данные лежат в IndexedDB.
// Сервер не нужен, поэтому нет сетевых задержек; программу можно раздавать со статического хостинга (GitHub Pages).
import { createCore } from './core/api.js';
import { initDb, seedIfEmpty } from './core/db.js';
import { createLamps } from './core/lamps.js';
import { wrapSqlJs } from './core/sqljs-db.js';
import { createSync } from './core/sync.js';

const IDB_NAME = 'sunclub';
const STORE = 'kv';
const KEY = 'db';
const TOKEN_KEY = 'sc_token';
const SESS_KEY = 'sunclub_sessions';

/** Сессии лежат в localStorage устройства, а не в базе: база синхронизируется между устройствами, входы — нет. */
function localSessions() {
  const load = () => { try { return JSON.parse(localStorage.getItem(SESS_KEY)) || {}; } catch { return {}; } };
  const save = (m) => localStorage.setItem(SESS_KEY, JSON.stringify(m));
  return {
    add(hash, userId, exp) { const m = load(); m[hash] = { user_id: userId, expires_at: exp }; save(m); },
    find: (hash) => load()[hash],
    remove(hash) { const m = load(); delete m[hash]; save(m); },
    removeUser(id) { const m = load(); for (const k of Object.keys(m)) if (m[k].user_id === id) delete m[k]; save(m); },
    purge(t) { const m = load(); for (const k of Object.keys(m)) if (m[k].expires_at < t) delete m[k]; save(m); },
  };
}

const REQUIRED_TABLES = ['users', 'checks', 'shifts', 'payments'];
const NO_SYNC = new Set(['/api/login', '/api/logout']); // вход и выход не должны порождать записи в облако

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
  let sql = new SQL.Database((await idbGet()) || undefined);
  const db = wrapSqlJs(sql);
  const fk = () => sql.run('PRAGMA foreign_keys = ON;');
  fk();
  initDb(db);
  await seedIfEmpty(db);
  const core = createCore({ db, lamps: createLamps(db), sessions: localSessions() });
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

  const hasTables = (database) => database.exec(`SELECT name FROM sqlite_master WHERE name IN (${REQUIRED_TABLES.map((t) => `'${t}'`).join(',')})`)[0]?.values.length === REQUIRED_TABLES.length;

  // Облачная синхронизация: свежую версию из облака подставляем «на лету», не пересоздавая ядро.
  const syncListeners = new Set();
  const sync = createSync({
    storage: localStorage,
    getBytes: async () => snapshot(),
    applyBytes: async (bytes) => {
      const next = new SQL.Database(bytes);
      if (!hasTables(next)) { next.close(); throw new Error('Облачная копия повреждена'); }
      const old = sql;
      sql = next;
      db.swap(next);
      old.close();
      fk();
      initDb(db);
      await saving;
      await idbPut(snapshot());
      core.emit();
    },
    onStatus: (s, i) => syncListeners.forEach((fn) => fn(s, i)),
  });
  sync.start();

  return {
    sync,
    onSyncStatus: (fn) => { syncListeners.add(fn); },
    async request(method, path, body) {
      const url = new URL(path, 'http://local');
      const r = await core.dispatch({
        method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ?? {},
        token: sessionStorage.getItem(TOKEN_KEY),
      });
      if (typeof r.setToken === 'string') sessionStorage.setItem(TOKEN_KEY, r.setToken);
      else if (r.setToken === null) sessionStorage.removeItem(TOKEN_KEY);
      if (method !== 'GET') {
        await persist();
        if (!NO_SYNC.has(url.pathname) && r.status < 400) sync.markDirty();
      }
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
        ok = hasTables(probe);
        probe.close();
      } catch { ok = false; }
      if (!ok) throw new Error('Это не файл резервной копии SunClub');
      await saving;
      await idbPut(bytes);
      sync.markDirty(); // восстановленные данные должны уйти в облако
      sessionStorage.removeItem(TOKEN_KEY);
      location.reload();
    },
  };
}
