import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb, seedIfEmpty } from '../server/db.js';
import { createLamps } from '../server/lamps.js';
import { createApp } from '../server/app.js';

let clock = Date.parse('2026-01-01T10:00:00Z');
const lampCalls = [];

async function boot() {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const fetchImpl = async (url) => { lampCalls.push(url); return { ok: true }; };
  const app = createApp({ db, lamps: createLamps(db, { fetchImpl }), publicDir: new URL('../public', import.meta.url).pathname, now: () => clock });
  const server = createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = (cookie = '') => {
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    };
    return {
      get: (p) => call('GET', p),
      post: (p, b = {}, h) => call('POST', p, b, h),
      patch: (p, b) => call('PATCH', p, b),
      put: (p, b) => call('PUT', p, b),
    };
  };
  const login = async (userId, pin, newPin) => {
    const s = session();
    const r = await s.post('/api/login', { user_id: userId, pin });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.user.must_change) {
      assert.equal((await s.get('/api/state')).status, 403);
      assert.equal((await s.post('/api/me/pin', { old_pin: pin, new_pin: newPin })).status, 200);
    }
    return s;
  };
  return { db, app, server, session, login, close: () => { app.close(); server.close(); } };
}

test('полный сценарий: смена → стол → бар → оплата → возврат → закрытие смены', async (t) => {
  const { db, server, login, close, session } = await boot();
  t.after(close);
  const admin = await login(1, '1111', '7777');
  const worker = await login(3, '1001', '5555');

  // без смены работать нельзя
  let r = await worker.post('/api/tables/1/start');
  assert.equal(r.status, 409);

  assert.equal((await worker.post('/api/shifts/open', { opening_cash_kop: 500000 })).status, 200);
  assert.equal((await worker.post('/api/shifts/open', { opening_cash_kop: 0 })).status, 409);

  // настройка лампы по HTTP
  r = await admin.patch('/api/tables/1', { lamp_config: { type: 'http', on_url: 'http://relay/1/on', off_url: 'http://relay/1/off' } });
  assert.equal(r.status, 200);

  r = await worker.post('/api/tables/1/start');
  assert.equal(r.status, 200);
  assert.deepEqual(lampCalls, ['http://relay/1/on']);
  assert.equal((await worker.post('/api/tables/1/start')).status, 409);

  // 30 минут игры, 10 минут пауза, ещё 30 минут
  clock += 30 * 60_000;
  assert.equal((await worker.post('/api/tables/1/pause')).status, 200);
  clock += 10 * 60_000;
  assert.equal((await worker.post('/api/tables/1/resume')).status, 200);
  clock += 30 * 60_000;

  let state = (await worker.get('/api/state')).data;
  const chk = state.checks.find((c) => c.table_id === 1);
  assert.equal(chk.live_kop, 50000);            // 60 мин × 500 ₽/ч

  const cola = state.products.find((p) => p.name.startsWith('Кола'));
  assert.equal((await worker.post(`/api/checks/${chk.id}/lines`, { product_id: cola.id, qty: 2 })).status, 200);

  // оплата без остановки игры запрещена
  r = await worker.post(`/api/checks/${chk.id}/pay`, { payments: [{ method: 'cash', amount_kop: 74000 }] });
  assert.equal(r.status, 409);

  assert.equal((await worker.post(`/api/checks/${chk.id}/stop`)).status, 200);
  state = (await worker.get('/api/state')).data;
  const stopped = state.checks.find((c) => c.id === chk.id);
  assert.equal(stopped.total_kop, 50000 + 24000);

  // скидка больше 10% у сотрудника запрещена, неверная сумма отклоняется
  r = await worker.post(`/api/checks/${chk.id}/pay`, { discount_kop: 20000, payments: [{ method: 'cash', amount_kop: 54000 }] });
  assert.equal(r.status, 403);
  r = await worker.post(`/api/checks/${chk.id}/pay`, { payments: [{ method: 'cash', amount_kop: 1000 }] });
  assert.equal(r.status, 400);

  // смешанная оплата: карта + СБП + наличные
  r = await worker.post(`/api/checks/${chk.id}/pay`, {
    discount_kop: 4000, discount_note: 'постоянный гость',
    payments: [{ method: 'card', amount_kop: 30000 }, { method: 'sbp', amount_kop: 20000 }, { method: 'cash', amount_kop: 20000 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await worker.post(`/api/checks/${chk.id}/pay`, { payments: [] })).status, 409);

  // продажа в баре за наличные, склад уменьшается
  const water = state.products.find((p) => p.name.startsWith('Вода'));
  r = await worker.post('/api/sales', { lines: [{ product_id: water.id, qty: 3 }], payments: [{ method: 'cash', amount_kop: 24000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  state = (await worker.get('/api/state')).data;
  assert.equal(state.products.find((p) => p.id === water.id).stock, 17);
  assert.equal(state.products.find((p) => p.id === cola.id).stock, 18);
  assert.equal(state.shift.by_method.card, 30000);
  assert.equal(state.shift.by_method.sbp, 20000);
  assert.equal(state.shift.by_method.cash, 44000);
  assert.equal(state.shift.expected_cash_kop, 500000 + 44000);

  // нельзя продать больше, чем на складе
  r = await worker.post('/api/sales', { lines: [{ product_id: water.id, qty: 50 }], payments: [{ method: 'cash', amount_kop: 1 }] });
  assert.equal(r.status, 409);

  // отчёты и возврат — только админ
  assert.equal((await worker.get('/api/reports')).status, 403);
  assert.equal((await worker.post(`/api/checks/${chk.id}/void`, { reason: 'ошибка' })).status, 403);
  assert.equal((await admin.post(`/api/checks/${chk.id}/void`, { reason: 'ошибочный чек' })).status, 200);
  state = (await worker.get('/api/state')).data;
  assert.equal(state.shift.by_method.card, 0);
  assert.equal(state.shift.refunds_kop, 70000);
  assert.equal(state.products.find((p) => p.id === cola.id).stock, 20);
  assert.equal(state.shift.expected_cash_kop, 500000 + 24000);

  r = await admin.get(`/api/reports?from=${clock - 86400000}&to=${clock + 1000}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.total_kop, 24000);

  // закрытие смены: только открывший или админ
  const other = await login(4, '1002', '6666');
  assert.equal((await other.post('/api/shifts/close', { counted_cash_kop: 0 })).status, 403);
  r = await worker.post('/api/shifts/close', { counted_cash_kop: 520000 });
  assert.equal(r.status, 200);
  assert.equal(r.data.expected_cash_kop, 524000);
  assert.equal(r.data.counted_cash_kop - r.data.expected_cash_kop, -4000);
  assert.equal((await worker.get('/api/state')).data.shift, null);
});

test('сигнал контроллера: свет включён → игра идёт, выключен → пауза', async (t) => {
  const { login, close, session, db } = await boot();
  t.after(close);
  const admin = await login(1, '1111', '7777');
  const key = (await admin.get('/api/settings')).data.hw_key;
  const hw = session();

  assert.equal((await hw.post('/api/hw/lamp', { table_id: 2, on: true }, { 'x-device-key': 'bad' })).status, 401);
  let r = await hw.post('/api/hw/lamp', { table_id: 2, on: true }, { 'x-device-key': key });
  assert.equal(r.data.action, 'started');
  clock += 20 * 60_000;
  r = await hw.post('/api/hw/lamp', { table_id: 2, on: false }, { 'x-device-key': key });
  assert.equal(r.data.action, 'paused');
  clock += 20 * 60_000;                                    // пока свет погашен — время не идёт
  const state = (await admin.get('/api/state')).data;
  const chk = state.checks.find((c) => c.table_id === 2);
  assert.equal(chk.live_kop, Math.round((20 * 500) / 60) * 100);
  r = await hw.post('/api/hw/lamp', { table_id: 2, on: true }, { 'x-device-key': key });
  assert.equal(r.data.action, 'resumed');
});

test('PIN: блокировка после 5 ошибок, администратор не может остаться один без прав', async (t) => {
  const { login, close, session } = await boot();
  t.after(close);
  const s = session();
  for (let i = 0; i < 5; i++) assert.equal((await s.post('/api/login', { user_id: 3, pin: '0000' })).status, 401);
  assert.equal((await s.post('/api/login', { user_id: 3, pin: '1001' })).status, 429);

  const admin = await login(1, '1111', '7777');
  assert.equal((await admin.patch('/api/users/2', { active: false })).status, 200);
  assert.equal((await admin.patch('/api/users/1', { role: 'worker' })).status, 409);
});
