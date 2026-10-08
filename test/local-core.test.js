// Браузерный режим: то же ядро поверх sql.js (WASM). Проверяем в Node теми же сценариями.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initDb, seedIfEmpty } from '../public/js/core/db.js';
import { createLamps } from '../public/js/core/lamps.js';
import { createCore } from '../public/js/core/api.js';
import { wrapSqlJs } from '../public/js/core/sqljs-db.js';

const require = createRequire(import.meta.url);
const initSqlJs = require('../public/vendor/sql-wasm.js');
const wasmBinary = readFileSync(new URL('../public/vendor/sql-wasm.wasm', import.meta.url));

let clock = Date.parse('2026-02-01T10:00:00Z');

async function boot(bytes) {
  const SQL = await initSqlJs({ wasmBinary });
  const sql = new SQL.Database(bytes);
  const db = wrapSqlJs(sql);
  db.exec('PRAGMA foreign_keys = ON;');
  initDb(db);
  await seedIfEmpty(db);
  const core = createCore({ db, lamps: createLamps(db), now: () => clock });
  let token = null;
  const call = async (method, path, body) => {
    const [p, qs] = path.split('?');
    const r = await core.dispatch({ method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), body, token });
    if (r.setToken !== undefined) token = r.setToken;
    return r;
  };
  return { sql, call };
}

test('sql.js: смена → игра → бар → оплата → закрытие, данные переживают экспорт/импорт', async () => {
  const { sql, call } = await boot();
  let r = await call('POST', '/api/login', { user_id: 3, pin: '1001' });
  assert.equal(r.status, 200);
  assert.ok(r.data.user.must_change);
  assert.equal((await call('POST', '/api/me/pin', { old_pin: '1001', new_pin: '5555' })).status, 200);

  assert.equal((await call('POST', '/api/shifts/open', { opening_cash_kop: 100000 })).status, 200);
  assert.equal((await call('POST', '/api/tables/1/start')).status, 200);
  clock += 45 * 60_000;
  let state = (await call('GET', '/api/state')).data;
  const chk = state.checks[0];
  assert.equal(chk.live_kop, 37500);                       // 45 мин × 500 ₽/ч
  const water = state.products.find((p) => p.name.startsWith('Вода'));
  assert.equal((await call('POST', `/api/checks/${chk.id}/lines`, { product_id: water.id, qty: 2 })).status, 200);
  assert.equal((await call('POST', `/api/checks/${chk.id}/stop`)).status, 200);
  r = await call('POST', `/api/checks/${chk.id}/pay`, { payments: [{ method: 'sbp', amount_kop: 37500 + 16000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  r = await call('POST', '/api/shifts/close', { counted_cash_kop: 100000 });
  assert.equal(r.status, 200);
  assert.equal(r.data.by_method.sbp, 53500);
  assert.equal(r.data.expected_cash_kop, 100000);

  // «перезапуск»: выгружаем базу и поднимаем заново из байтов
  const bytes = sql.export();
  const again = await boot(bytes);
  const login = await again.call('POST', '/api/login', { user_id: 3, pin: '5555' });
  assert.equal(login.status, 200, 'PIN сохранился');
  const shifts = (await again.call('GET', '/api/shifts')).data;
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].total_kop, 53500);
});

test('часы смены: формат ЧЧ:ММ проверяется', async () => {
  const { call } = await boot();
  await call('POST', '/api/login', { user_id: 1, pin: '1111' });
  await call('POST', '/api/me/pin', { old_pin: '1111', new_pin: '7777' });
  assert.equal((await call('PUT', '/api/settings', { shift_start: '25:00' })).status, 400);
  const r = await call('PUT', '/api/settings', { shift_start: '09:30', shift_end: '21:00' });
  assert.equal(r.status, 200);
  assert.equal(r.data.shift_start, '09:30');
});
