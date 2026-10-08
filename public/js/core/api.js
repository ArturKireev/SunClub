import { tx } from './db.js';
import { hashPin, verifyPin, validPin, sha, newToken, safeEqual, createLoginLimiter } from './auth.js';
import { HttpError, bad, conflict, forbidden, notFound, int, str, oneOf } from './util.js';
import { playSeconds, timeCharge, checkTotals, durationHuman } from './billing.js';

const SESSION_TTL = 16 * 3600 * 1000;
const METHODS = ['cash', 'card', 'sbp'];
const TABLE_KINDS = ['pool', 'pyramid', 'snooker', 'carom'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Ядро приложения без привязки к транспорту: dispatch({method, path, query, body, headers, token})
 * -> { status, data, setToken }. Работает и за HTTP-сервером (server/http.js), и прямо в браузере (local-backend.js).
 */
/** Хранилище сессий в самой базе (серверный режим). В браузере сессии хранятся отдельно, чтобы не синхронизироваться между устройствами. */
export function dbSessions(db) {
  return {
    add: (hash, userId, expiresAt) => db.prepare('INSERT INTO auth_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hash, userId, expiresAt),
    find: (hash) => db.prepare('SELECT user_id, expires_at FROM auth_tokens WHERE token_hash=?').get(hash),
    remove: (hash) => db.prepare('DELETE FROM auth_tokens WHERE token_hash=?').run(hash),
    removeUser: (userId) => db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(userId),
    purge: (t) => db.prepare('DELETE FROM auth_tokens WHERE expires_at<?').run(t),
  };
}

export function createCore({ db, lamps, now = Date.now, sessions = dbSessions(db) }) {
  const limiter = createLoginLimiter();
  const listeners = new Set();
  const routes = [];

  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const q1 = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  function route(method, pattern, role, fn) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, role, fn });
  }

  // ---------- общие помощники ----------

  function settings() {
    const o = {};
    for (const r of q('SELECT key,value FROM settings')) o[r.key] = r.value;
    return { ...o, step_min: +o.step_min, min_minutes: +o.min_minutes, max_discount_pct: +o.max_discount_pct };
  }
  const audit = (userId, action, details) =>
    run('INSERT INTO audit(ts,user_id,action,details) VALUES (?,?,?,?)', now(), userId ?? null, action, details ? JSON.stringify(details) : null);

  const currentShift = () => q1('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
  function requireShift() {
    const s = currentShift();
    if (!s) throw conflict('Смена не открыта. Откройте смену на вкладке «Смена».');
    return s;
  }

  function loadCheck(id, t = now()) {
    const check = q1('SELECT * FROM checks WHERE id=?', id);
    if (!check) return null;
    const lines = q('SELECT * FROM check_lines WHERE check_id=? ORDER BY id', id);
    const sessions = q('SELECT * FROM play_sessions WHERE check_id=? ORDER BY id', id);
    const payments = q('SELECT * FROM payments WHERE check_id=? ORDER BY id', id);
    return { ...check, lines, sessions, payments, ...checkTotals(check, lines, sessions, settings(), t) };
  }
  function mustCheck(id, status) {
    const c = loadCheck(id);
    if (!c) throw notFound('Чек не найден');
    if (status && c.status !== status) throw conflict(status === 'open' ? 'Чек уже закрыт' : 'Чек не оплачен');
    return c;
  }

  function moveStock(productId, delta, reason, checkId, userId) {
    const p = q1('SELECT * FROM products WHERE id=?', productId);
    if (!p || !p.track_stock || delta === 0) return;
    run('UPDATE products SET stock = stock + ? WHERE id=?', delta, productId);
    run('INSERT INTO stock_moves(product_id,delta,reason,check_id,user_id,created_at) VALUES (?,?,?,?,?,?)', productId, delta, reason, checkId, userId, now());
  }

  function addItemLine(check, productId, qty, userId) {
    int(qty, 'количество', { min: 1, max: 99 });
    const p = q1('SELECT * FROM products WHERE id=? AND active=1', productId);
    if (!p) throw notFound('Товар не найден');
    if (p.track_stock && p.stock < qty) throw conflict(`Недостаточно на складе: «${p.name}» — осталось ${p.stock}`);
    const ex = q1("SELECT * FROM check_lines WHERE check_id=? AND kind='item' AND product_id=? AND price_kop=?", check.id, p.id, p.price_kop);
    if (ex) run('UPDATE check_lines SET qty=qty+? WHERE id=?', qty, ex.id);
    else run("INSERT INTO check_lines(check_id,kind,product_id,name,price_kop,qty) VALUES (?, 'item', ?, ?, ?, ?)", check.id, p.id, p.name, p.price_kop, qty);
    moveStock(p.id, -qty, 'sale', check.id, userId);
  }

  /** Останавливает активные/паузные сессии чека, фиксируя стоимость времени строкой чека. Возвращает столы, где надо погасить свет. */
  function endSessions(checkId, { bill = true } = {}) {
    const cfg = settings();
    const t = now();
    const tables = [];
    for (const s of q("SELECT * FROM play_sessions WHERE check_id=? AND status!='ended'", checkId)) {
      const sec = playSeconds(s, t);
      run("UPDATE play_sessions SET status='ended', ended_at=?, accrued_sec=?, running_since=NULL WHERE id=?", t, sec, s.id);
      const table = q1('SELECT * FROM tables WHERE id=?', s.table_id);
      if (bill && sec > 0) {
        run("INSERT INTO check_lines(check_id,kind,session_id,name,price_kop,qty) VALUES (?, 'time', ?, ?, ?, 1)",
          checkId, s.id, `${table.name} · ${durationHuman(sec)}`, timeCharge(sec, s.rate_kop, cfg));
      }
      tables.push(table);
    }
    return tables;
  }

  async function applyLamps(list) {
    const warnings = [];
    for (const [table, on] of list) {
      const w = await lamps.set(table, on);
      if (w) warnings.push(w);
    }
    return warnings;
  }

  function openCheckOfTable(tableId) {
    return q1("SELECT * FROM checks WHERE status='open' AND table_id=?", tableId);
  }
  function liveSession(checkId) {
    return q1("SELECT * FROM play_sessions WHERE check_id=? AND status!='ended' ORDER BY id DESC LIMIT 1", checkId);
  }
  function mustTable(id) {
    const t = q1('SELECT * FROM tables WHERE id=?', id);
    if (!t || !t.active) throw notFound('Стол не найден');
    return t;
  }

  function startSession(table, userId, source) {
    const t = now();
    const shift = currentShift();
    const checkId = Number(run("INSERT INTO checks(kind,table_id,status,shift_id,created_by,created_at) VALUES ('table',?,'open',?,?,?)", table.id, shift?.id ?? null, userId, t).lastInsertRowid);
    run("INSERT INTO play_sessions(table_id,check_id,status,rate_kop,started_at,running_since,source) VALUES (?,?,'active',?,?,?,?)", table.id, checkId, table.rate_kop, t, t, source);
    return checkId;
  }
  function pauseSession(s) {
    const t = now();
    run("UPDATE play_sessions SET status='paused', accrued_sec=?, running_since=NULL WHERE id=?", playSeconds(s, t), s.id);
  }
  function resumeSession(s) {
    run("UPDATE play_sessions SET status='active', running_since=? WHERE id=?", now(), s.id);
  }

  // ---------- оплата ----------

  function finalizePayment(check, body, user, shift) {
    const cfg = settings();
    if (check.sessions.some((s) => s.status !== 'ended')) throw conflict('Сначала остановите игру за столом');
    const subtotal = check.frozen_kop;
    const discount = int(body.discount_kop ?? 0, 'скидка', { min: 0, max: subtotal });
    const maxDiscount = user.role === 'admin' ? subtotal : Math.floor((subtotal * cfg.max_discount_pct) / 100);
    if (discount > maxDiscount) throw forbidden(`Скидка больше допустимой (${cfg.max_discount_pct}%). Позовите администратора.`);
    const total = subtotal - discount;
    const payments = Array.isArray(body.payments) ? body.payments : [];
    let sum = 0;
    for (const p of payments) {
      oneOf(p.method, METHODS, 'способ оплаты');
      sum += int(p.amount_kop, 'сумма', { min: 1 });
    }
    if (sum !== total) throw bad(`Сумма оплат (${sum / 100}) не совпадает с суммой чека (${total / 100})`);
    const t = now();
    for (const p of payments) {
      run('INSERT INTO payments(check_id,shift_id,method,amount_kop,user_id,created_at) VALUES (?,?,?,?,?,?)', check.id, shift.id, p.method, p.amount_kop, user.id, t);
    }
    run("UPDATE checks SET status='paid', closed_at=?, closed_by=?, discount_kop=?, discount_note=?, total_kop=? WHERE id=?",
      t, user.id, discount, discount ? str(body.discount_note ?? '', 'причина скидки', { max: 200 }) : null, total, check.id);
    audit(user.id, 'check.pay', { check: check.id, total, discount, payments });
    return total;
  }

  // ---------- сводки ----------

  function shiftSummary(shift) {
    const by = { cash: 0, card: 0, sbp: 0 };
    for (const r of q('SELECT method, SUM(amount_kop) s FROM payments WHERE shift_id=? GROUP BY method', shift.id)) by[r.method] = r.s;
    const refunds = q1('SELECT COALESCE(SUM(-amount_kop),0) s FROM payments WHERE shift_id=? AND amount_kop<0', shift.id).s;
    const ops = q('SELECT o.*, u.name user_name FROM cash_ops o JOIN users u ON u.id=o.user_id WHERE shift_id=? ORDER BY o.id', shift.id);
    const opsSum = ops.reduce((s, o) => s + o.amount_kop, 0);
    const count = q1('SELECT COUNT(DISTINCT check_id) c FROM payments WHERE shift_id=? AND amount_kop>0', shift.id).c;
    const user = q1('SELECT name FROM users WHERE id=?', shift.user_id);
    return {
      ...shift,
      user_name: user?.name,
      by_method: by,
      total_kop: by.cash + by.card + by.sbp,
      refunds_kop: refunds,
      checks_count: count,
      cash_ops: ops,
      expected_cash_kop: shift.opening_cash_kop + by.cash + opsSum,
    };
  }

  function buildReport(from, to, tz) {
    const cond = 'c.status=\'paid\' AND c.closed_at>=? AND c.closed_at<?';
    const byMethod = { cash: 0, card: 0, sbp: 0 };
    for (const r of q('SELECT method, SUM(amount_kop) s FROM payments WHERE created_at>=? AND created_at<? GROUP BY method', from, to)) byMethod[r.method] = r.s;
    const lineSums = { time: 0, item: 0 };
    for (const r of q(`SELECT l.kind, SUM(l.price_kop*l.qty) s FROM check_lines l JOIN checks c ON c.id=l.check_id WHERE ${cond} GROUP BY l.kind`, from, to)) lineSums[r.kind] = r.s;
    const disc = q1(`SELECT COALESCE(SUM(c.discount_kop),0) s, COUNT(*) n FROM checks c WHERE ${cond}`, from, to);
    const byCategory = q(`SELECT cat.name, SUM(l.price_kop*l.qty) sum_kop, SUM(l.qty) qty FROM check_lines l JOIN checks c ON c.id=l.check_id
      JOIN products p ON p.id=l.product_id JOIN categories cat ON cat.id=p.category_id WHERE l.kind='item' AND ${cond} GROUP BY cat.id ORDER BY sum_kop DESC`, from, to);
    const topProducts = q(`SELECT l.name, SUM(l.price_kop*l.qty) sum_kop, SUM(l.qty) qty FROM check_lines l JOIN checks c ON c.id=l.check_id
      WHERE l.kind='item' AND ${cond} GROUP BY l.product_id ORDER BY sum_kop DESC LIMIT 15`, from, to);
    const byTable = q(`SELECT t.id, t.name, SUM(l.price_kop*l.qty) sum_kop, SUM(ps.accrued_sec) seconds, COUNT(*) sessions FROM check_lines l
      JOIN checks c ON c.id=l.check_id JOIN play_sessions ps ON ps.id=l.session_id JOIN tables t ON t.id=ps.table_id
      WHERE l.kind='time' AND ${cond} GROUP BY t.id ORDER BY t.sort, t.id`, from, to);
    const byDay = q(`SELECT strftime('%Y-%m-%d', created_at/1000 + ?, 'unixepoch') day, SUM(amount_kop) sum_kop FROM payments
      WHERE created_at>=? AND created_at<? GROUP BY day ORDER BY day`, tz * 60, from, to);
    const t = now();
    const staff = new Map();
    for (const s of q('SELECT s.*, u.name user_name FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.opened_at<? AND COALESCE(s.closed_at,?)>?', to, t, from)) {
      const a = Math.max(s.opened_at, from);
      const b = Math.min(s.closed_at ?? t, to);
      const rev = q1('SELECT COALESCE(SUM(amount_kop),0) s FROM payments WHERE shift_id=? AND created_at>=? AND created_at<?', s.id, from, to).s;
      const e = staff.get(s.user_id) || { user_id: s.user_id, name: s.user_name, shifts: 0, seconds: 0, revenue_kop: 0 };
      e.shifts += 1;
      e.seconds += Math.max(0, Math.round((b - a) / 1000));
      e.revenue_kop += rev;
      staff.set(s.user_id, e);
    }
    return {
      from, to,
      by_method: byMethod,
      total_kop: byMethod.cash + byMethod.card + byMethod.sbp,
      time_kop: lineSums.time,
      items_kop: lineSums.item,
      discounts_kop: disc.s,
      checks_count: disc.n,
      by_category: byCategory,
      top_products: topProducts,
      by_table: byTable,
      by_day: byDay,
      staff: [...staff.values()],
    };
  }

  // ---------- публичные маршруты ----------

  route('GET', '/api/login-users', null, () =>
    q("SELECT id,name,role,must_change FROM users WHERE active=1 ORDER BY role, id"));

  route('POST', '/api/login', null, async (c) => {
    const id = int(c.body.user_id, 'пользователь');
    const u = q1('SELECT * FROM users WHERE id=? AND active=1', id);
    if (!u) throw bad('Пользователь не найден');
    const t = now();
    const wait = limiter.check(id, t);
    if (wait) throw new HttpError(429, `Слишком много попыток. Подождите ${wait} с.`);
    if (typeof c.body.pin !== 'string' || !(await verifyPin(c.body.pin, u.pin_hash))) {
      limiter.fail(id, t);
      audit(id, 'login.fail');
      throw new HttpError(401, 'Неверный PIN');
    }
    limiter.ok(id);
    const token = newToken();
    sessions.purge(t);
    sessions.add(await sha(token), u.id, t + SESSION_TTL);
    audit(u.id, 'login');
    c.setToken = token;
    return { user: { id: u.id, name: u.name, role: u.role, must_change: !!u.must_change } };
  });

  // Контроллер ламп сообщает о состоянии света над столом: свет горит — идёт игра и начисляется время.
  route('POST', '/api/hw/lamp', null, (c) => {
    const key = String(c.headers['x-device-key'] || '');
    const real = settings().hw_key;
    if (!real || !safeEqual(new TextEncoder().encode(key), new TextEncoder().encode(real))) throw new HttpError(401, 'Неверный ключ устройства');
    const table = mustTable(int(c.body.table_id, 'стол'));
    const on = c.body.on === true;
    const result = tx(db, () => {
      const check = openCheckOfTable(table.id);
      const live = check && liveSession(check.id);
      let action = 'none';
      if (on) {
        if (!check) {
          const shift = currentShift();
          const by = shift?.user_id ?? q1("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").id;
          startSession(table, by, 'lamp');
          action = 'started';
        } else if (live?.status === 'paused') { resumeSession(live); action = 'resumed'; }
      } else if (live?.status === 'active') { pauseSession(live); action = 'paused'; }
      run('UPDATE tables SET lamp_on=? WHERE id=?', on ? 1 : 0, table.id);
      audit(null, 'hw.lamp', { table: table.id, on, action });
      return action;
    });
    return { ok: true, action: result };
  });

  // ---------- вход/выход, профиль ----------

  route('POST', '/api/logout', 'staff', async (c) => {
    sessions.remove(await sha(c.token));
    c.setToken = null;
    return { ok: true };
  });

  route('GET', '/api/me', 'staff', (c) => ({ user: publicUser(c.user) }));

  route('POST', '/api/me/pin', 'any', async (c) => {
    const u = q1('SELECT * FROM users WHERE id=?', c.user.id);
    if (!(await verifyPin(String(c.body.old_pin ?? ''), u.pin_hash))) throw new HttpError(401, 'Текущий PIN указан неверно');
    if (!validPin(c.body.new_pin)) throw bad('PIN — от 4 до 6 цифр');
    if (c.body.new_pin === c.body.old_pin) throw bad('Новый PIN должен отличаться от текущего');
    run('UPDATE users SET pin_hash=?, must_change=0 WHERE id=?', await hashPin(c.body.new_pin), u.id);
    audit(u.id, 'pin.change');
    return { ok: true };
  });

  const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, must_change: !!u.must_change });

  // ---------- общее состояние для интерфейса ----------

  route('GET', '/api/state', 'staff', (c) => {
    const t = now();
    const admin = c.user.role === 'admin';
    const s = settings();
    const { hw_key, ...pub } = s;
    const shift = currentShift();
    const lastClosed = q1('SELECT counted_cash_kop FROM shifts WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 1');
    return {
      now: t,
      user: publicUser(c.user),
      settings: pub,
      shift: shift ? shiftSummary(shift) : null,
      last_closing_cash_kop: lastClosed?.counted_cash_kop ?? 0,
      tables: q('SELECT * FROM tables ORDER BY sort, id').map((x) => (admin ? x : { ...x, lamp_config: undefined })),
      checks: q("SELECT id FROM checks WHERE status='open' ORDER BY id").map((r) => loadCheck(r.id, t)),
      categories: q('SELECT * FROM categories ORDER BY sort, id'),
      products: q('SELECT * FROM products ORDER BY name'),
      staff: q('SELECT id,name,role,active FROM users ORDER BY id'),
    };
  });

  // ---------- столы ----------

  route('POST', '/api/tables/:id/start', 'staff', async (c) => {
    const table = mustTable(+c.params.id);
    const warnings = [];
    tx(db, () => {
      requireShift();
      if (openCheckOfTable(table.id)) throw conflict('За этим столом уже есть открытый чек');
      const id = startSession(table, c.user.id, 'manual');
      audit(c.user.id, 'table.start', { table: table.id, check: id });
    });
    warnings.push(...await applyLamps([[table, true]]));
    return { ok: true, warnings };
  });

  route('POST', '/api/tables/:id/pause', 'staff', async (c) => {
    const table = mustTable(+c.params.id);
    tx(db, () => {
      requireShift();
      const check = openCheckOfTable(table.id);
      const s = check && liveSession(check.id);
      if (!s || s.status !== 'active') throw conflict('Игра не идёт');
      pauseSession(s);
      audit(c.user.id, 'table.pause', { table: table.id });
    });
    return { ok: true, warnings: await applyLamps([[table, false]]) };
  });

  route('POST', '/api/tables/:id/resume', 'staff', async (c) => {
    const table = mustTable(+c.params.id);
    tx(db, () => {
      requireShift();
      const check = openCheckOfTable(table.id);
      const s = check && liveSession(check.id);
      if (!s || s.status !== 'paused') throw conflict('Игра не на паузе');
      resumeSession(s);
      audit(c.user.id, 'table.resume', { table: table.id });
    });
    return { ok: true, warnings: await applyLamps([[table, true]]) };
  });

  // Перенос игры на другой стол: время на старом столе фиксируется по его тарифу, на новом идёт по новому.
  route('POST', '/api/tables/:id/move', 'staff', async (c) => {
    const from = mustTable(+c.params.id);
    const to = mustTable(int(c.body.to_table_id, 'стол'));
    if (from.id === to.id) throw bad('Выберите другой стол');
    const lampsToSet = [];
    tx(db, () => {
      requireShift();
      const check = openCheckOfTable(from.id);
      const s = check && liveSession(check.id);
      if (!s) throw conflict('Игра не идёт');
      if (openCheckOfTable(to.id)) throw conflict(`«${to.name}» занят`);
      const wasActive = s.status === 'active';
      endSessions(check.id);
      const t = now();
      run('UPDATE checks SET table_id=? WHERE id=?', to.id, check.id);
      run("INSERT INTO play_sessions(table_id,check_id,status,rate_kop,started_at,running_since,source) VALUES (?,?,?,?,?,?,'move')",
        to.id, check.id, wasActive ? 'active' : 'paused', to.rate_kop, t, wasActive ? t : null);
      lampsToSet.push([from, false]);
      if (wasActive) lampsToSet.push([to, true]);
      audit(c.user.id, 'table.move', { from: from.id, to: to.id, check: check.id });
    });
    return { ok: true, warnings: await applyLamps(lampsToSet) };
  });

  // ---------- чеки ----------

  route('GET', '/api/checks', 'staff', (c) => {
    const t = now();
    let rows;
    if (c.user.role === 'admin') {
      const from = +c.query.from || t - 7 * 86400000;
      const to = +c.query.to || t + 1;
      rows = q("SELECT id FROM checks WHERE (status='open' OR COALESCE(closed_at,created_at) BETWEEN ? AND ?) ORDER BY id DESC LIMIT 300", from, to);
    } else {
      const shift = currentShift();
      rows = shift ? q("SELECT id FROM checks WHERE status='open' OR created_at>=? OR closed_at>=? ORDER BY id DESC LIMIT 300", shift.opened_at, shift.opened_at) : [];
    }
    return rows.map((r) => {
      const ch = loadCheck(r.id, t);
      const table = ch.table_id ? q1('SELECT name FROM tables WHERE id=?', ch.table_id) : null;
      return { ...ch, table_name: table?.name ?? null };
    });
  });

  route('GET', '/api/checks/:id', 'staff', (c) => {
    const ch = mustCheck(+c.params.id);
    const table = ch.table_id ? q1('SELECT name FROM tables WHERE id=?', ch.table_id) : null;
    const names = Object.fromEntries(q('SELECT id,name FROM users').map((u) => [u.id, u.name]));
    return { ...ch, table_name: table?.name ?? null, created_by_name: names[ch.created_by], closed_by_name: names[ch.closed_by] };
  });

  route('POST', '/api/checks/:id/lines', 'staff', (c) => {
    tx(db, () => {
      requireShift();
      addItemLine(mustCheck(+c.params.id, 'open'), int(c.body.product_id, 'товар'), c.body.qty ?? 1, c.user.id);
    });
    return { ok: true };
  });

  route('PATCH', '/api/lines/:id', 'staff', (c) => {
    tx(db, () => {
      requireShift();
      const line = q1('SELECT * FROM check_lines WHERE id=?', +c.params.id);
      if (!line || line.kind !== 'item') throw notFound('Позиция не найдена');
      mustCheck(line.check_id, 'open');
      const qty = int(c.body.qty, 'количество', { min: 0, max: 99 });
      const delta = qty - line.qty;
      if (delta > 0) {
        const p = q1('SELECT * FROM products WHERE id=?', line.product_id);
        if (p.track_stock && p.stock < delta) throw conflict(`Недостаточно на складе: «${p.name}» — осталось ${p.stock}`);
      }
      if (qty === 0) run('DELETE FROM check_lines WHERE id=?', line.id);
      else run('UPDATE check_lines SET qty=? WHERE id=?', qty, line.id);
      moveStock(line.product_id, -delta, delta < 0 ? 'return' : 'sale', line.check_id, c.user.id);
    });
    return { ok: true };
  });

  // Остановить игру и зафиксировать стоимость времени (перед оплатой).
  route('POST', '/api/checks/:id/stop', 'staff', async (c) => {
    let tables = [];
    tx(db, () => {
      requireShift();
      const check = mustCheck(+c.params.id, 'open');
      tables = endSessions(check.id);
      audit(c.user.id, 'check.stop', { check: check.id });
    });
    return { ok: true, warnings: await applyLamps(tables.map((t) => [t, false])) };
  });

  route('POST', '/api/checks/:id/pay', 'staff', (c) => {
    const total = tx(db, () => finalizePayment(mustCheck(+c.params.id, 'open'), c.body, c.user, requireShift()));
    return { ok: true, total_kop: total };
  });

  // Продажа в баре без стола: чек создаётся и оплачивается сразу.
  route('POST', '/api/sales', 'staff', (c) => {
    const lines = Array.isArray(c.body.lines) ? c.body.lines : [];
    if (!lines.length) throw bad('Корзина пуста');
    const id = tx(db, () => {
      const shift = requireShift();
      const id = Number(run("INSERT INTO checks(kind,status,shift_id,created_by,created_at) VALUES ('bar','open',?,?,?)", shift.id, c.user.id, now()).lastInsertRowid);
      for (const l of lines) addItemLine({ id }, int(l.product_id, 'товар'), l.qty, c.user.id);
      finalizePayment(mustCheck(id, 'open'), c.body, c.user, shift);
      return id;
    });
    return { ok: true, check_id: id };
  });

  // Отмена открытого чека (например, стол включили по ошибке).
  route('POST', '/api/checks/:id/cancel', 'staff', async (c) => {
    const reason = str(c.body.reason ?? '', 'причина', { min: 3, max: 200 });
    let tables = [];
    tx(db, () => {
      requireShift();
      const check = mustCheck(+c.params.id, 'open');
      if (c.user.role !== 'admin') {
        const secs = check.sessions.reduce((s, x) => s + playSeconds(x, now()), 0);
        if (check.lines.length > 0 || secs >= 120) throw forbidden('Отменить такой чек может только администратор');
      }
      tables = endSessions(check.id, { bill: false });
      for (const l of check.lines) if (l.kind === 'item') moveStock(l.product_id, l.qty, 'cancel', check.id, c.user.id);
      run("UPDATE checks SET status='void', void_reason=?, voided_by=?, voided_at=?, closed_at=?, total_kop=0 WHERE id=?", reason, c.user.id, now(), now(), check.id);
      audit(c.user.id, 'check.cancel', { check: check.id, reason });
    });
    return { ok: true, warnings: await applyLamps(tables.map((t) => [t, false])) };
  });

  // Возврат по оплаченному чеку: отрицательные платежи в текущей смене, товар возвращается на склад.
  route('POST', '/api/checks/:id/void', 'admin', (c) => {
    const reason = str(c.body.reason ?? '', 'причина', { min: 3, max: 200 });
    tx(db, () => {
      const shift = requireShift();
      const check = mustCheck(+c.params.id, 'paid');
      const t = now();
      for (const p of check.payments) {
        run('INSERT INTO payments(check_id,shift_id,method,amount_kop,user_id,created_at) VALUES (?,?,?,?,?,?)', check.id, shift.id, p.method, -p.amount_kop, c.user.id, t);
      }
      for (const l of check.lines) if (l.kind === 'item') moveStock(l.product_id, l.qty, 'refund', check.id, c.user.id);
      run("UPDATE checks SET status='void', void_reason=?, voided_by=?, voided_at=? WHERE id=?", reason, c.user.id, t, check.id);
      audit(c.user.id, 'check.void', { check: check.id, reason, total: check.total_kop });
    });
    return { ok: true };
  });

  // ---------- смены ----------

  route('POST', '/api/shifts/open', 'staff', (c) => {
    const opening = int(c.body.opening_cash_kop ?? 0, 'остаток в кассе', { min: 0 });
    tx(db, () => {
      if (currentShift()) throw conflict('Смена уже открыта');
      const id = Number(run('INSERT INTO shifts(user_id,opened_at,opening_cash_kop) VALUES (?,?,?)', c.user.id, now(), opening).lastInsertRowid);
      // чеки, начатые между сменами (например, по сигналу лампы), привязываем к новой смене
      run("UPDATE checks SET shift_id=? WHERE status='open' AND shift_id IS NULL", id);
      audit(c.user.id, 'shift.open', { shift: id, opening });
    });
    return { ok: true };
  });

  route('POST', '/api/shifts/close', 'staff', (c) => {
    const counted = int(c.body.counted_cash_kop, 'пересчитанная касса', { min: 0 });
    let summary;
    tx(db, () => {
      const shift = requireShift();
      if (shift.user_id !== c.user.id && c.user.role !== 'admin') throw forbidden('Закрыть смену может тот, кто её открыл, или администратор');
      const pending = q1("SELECT COUNT(*) n FROM checks WHERE status='open'").n;
      if (pending && !c.body.force) throw new HttpError(409, `Есть неоплаченные чеки (${pending}). Они перейдут в следующую смену.`, { code: 'open_checks' });
      const sum = shiftSummary(shift);
      run('UPDATE shifts SET closed_at=?, closed_by=?, counted_cash_kop=?, expected_cash_kop=?, note=? WHERE id=?',
        now(), c.user.id, counted, sum.expected_cash_kop, str(c.body.note ?? '', 'комментарий', { max: 300 }) || null, shift.id);
      summary = shiftSummary(q1('SELECT * FROM shifts WHERE id=?', shift.id));
      audit(c.user.id, 'shift.close', { shift: shift.id, counted, expected: sum.expected_cash_kop });
    });
    return summary;
  });

  route('POST', '/api/cash-ops', 'staff', (c) => {
    const amount = int(c.body.amount_kop, 'сумма');
    if (amount === 0) throw bad('Сумма не может быть нулевой');
    const note = str(c.body.note ?? '', 'комментарий', { min: 3, max: 200 });
    tx(db, () => {
      const shift = requireShift();
      if (amount < 0 && -amount > shiftSummary(shift).expected_cash_kop) throw conflict('В кассе недостаточно наличных');
      run('INSERT INTO cash_ops(shift_id,amount_kop,note,user_id,created_at) VALUES (?,?,?,?,?)', shift.id, amount, note, c.user.id, now());
      audit(c.user.id, 'cash.op', { amount, note });
    });
    return { ok: true };
  });

  route('GET', '/api/shifts', 'staff', (c) => {
    const rows = c.user.role === 'admin'
      ? q('SELECT * FROM shifts ORDER BY id DESC LIMIT 100')
      : q('SELECT * FROM shifts WHERE user_id=? ORDER BY id DESC LIMIT 30', c.user.id);
    return rows.map(shiftSummary);
  });

  // ---------- меню и склад ----------

  route('POST', '/api/categories', 'admin', (c) => {
    const name = str(c.body.name, 'название', { min: 1, max: 60 });
    const id = Number(run('INSERT INTO categories(name,sort) VALUES (?, COALESCE((SELECT MAX(sort) FROM categories),0)+1)', name).lastInsertRowid);
    audit(c.user.id, 'category.create', { id, name });
    return { id };
  });
  route('PATCH', '/api/categories/:id', 'admin', (c) => {
    run('UPDATE categories SET name=? WHERE id=?', str(c.body.name, 'название', { min: 1, max: 60 }), +c.params.id);
    return { ok: true };
  });

  function productFields(b, partial) {
    const f = {};
    if (!partial || 'name' in b) f.name = str(b.name, 'название', { min: 1, max: 80 });
    if (!partial || 'category_id' in b) {
      f.category_id = int(b.category_id, 'категория');
      if (!q1('SELECT id FROM categories WHERE id=?', f.category_id)) throw bad('Категория не найдена');
    }
    if (!partial || 'price_kop' in b) f.price_kop = int(b.price_kop, 'цена', { min: 0, max: 100_000_00 });
    if (!partial || 'track_stock' in b) f.track_stock = b.track_stock ? 1 : 0;
    if (!partial || 'min_stock' in b) f.min_stock = int(b.min_stock ?? 0, 'минимальный остаток', { min: 0 });
    if ('active' in b) f.active = b.active ? 1 : 0;
    return f;
  }
  route('POST', '/api/products', 'admin', (c) => {
    const f = productFields(c.body, false);
    const stock = int(c.body.stock ?? 0, 'остаток', { min: 0 });
    const id = tx(db, () => {
      const id = Number(run('INSERT INTO products(category_id,name,price_kop,track_stock,min_stock,stock) VALUES (?,?,?,?,?,0)', f.category_id, f.name, f.price_kop, f.track_stock, f.min_stock).lastInsertRowid);
      if (stock) {
        run('UPDATE products SET stock=? WHERE id=?', stock, id);
        run("INSERT INTO stock_moves(product_id,delta,reason,user_id,created_at) VALUES (?,?,'initial',?,?)", id, stock, c.user.id, now());
      }
      audit(c.user.id, 'product.create', { id, ...f });
      return id;
    });
    return { id };
  });
  route('PATCH', '/api/products/:id', 'admin', (c) => {
    const f = productFields(c.body, true);
    const keys = Object.keys(f);
    if (!keys.length) throw bad('Нечего менять');
    if (!q1('SELECT id FROM products WHERE id=?', +c.params.id)) throw notFound('Товар не найден');
    run(`UPDATE products SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => f[k]), +c.params.id);
    audit(c.user.id, 'product.update', { id: +c.params.id, ...f });
    return { ok: true };
  });
  // Приход/списание/инвентаризация: delta — изменение остатка.
  route('POST', '/api/products/:id/stock', 'admin', (c) => {
    const delta = int(c.body.delta, 'количество');
    const reason = oneOf(c.body.reason, ['receipt', 'writeoff', 'inventory'], 'причина');
    if (delta === 0) throw bad('Количество не может быть нулевым');
    tx(db, () => {
      const p = q1('SELECT * FROM products WHERE id=?', +c.params.id);
      if (!p) throw notFound('Товар не найден');
      if (p.stock + delta < 0) throw conflict('Остаток не может быть отрицательным');
      run('UPDATE products SET stock=stock+? WHERE id=?', delta, p.id);
      run('INSERT INTO stock_moves(product_id,delta,reason,user_id,created_at) VALUES (?,?,?,?,?)', p.id, delta, reason, c.user.id, now());
      audit(c.user.id, 'stock.adjust', { product: p.id, delta, reason });
    });
    return { ok: true };
  });

  // ---------- администрирование: столы, сотрудники, настройки ----------

  function tableFields(b, partial) {
    const f = {};
    if (!partial || 'name' in b) f.name = str(b.name, 'название', { min: 1, max: 40 });
    if (!partial || 'kind' in b) f.kind = oneOf(b.kind, TABLE_KINDS, 'тип стола');
    if (!partial || 'rate_kop' in b) f.rate_kop = int(b.rate_kop, 'тариф', { min: 0, max: 1_000_000_00 });
    if ('sort' in b) f.sort = int(b.sort, 'порядок');
    if ('active' in b) f.active = b.active ? 1 : 0;
    if ('lamp_config' in b) {
      const cfg = typeof b.lamp_config === 'string' ? JSON.parse(b.lamp_config || '{}') : b.lamp_config;
      oneOf(cfg.type, ['mock', 'http'], 'тип лампы');
      if (cfg.type === 'http') for (const k of ['on_url', 'off_url']) if (!/^https?:\/\//.test(cfg[k] || '')) throw bad(`Укажите ${k} (http://…)`);
      f.lamp_config = JSON.stringify(cfg);
    }
    return f;
  }
  route('POST', '/api/tables', 'admin', (c) => {
    let f;
    try { f = tableFields(c.body, false); } catch (e) { if (e instanceof SyntaxError) throw bad('Некорректный JSON лампы'); throw e; }
    const id = Number(run('INSERT INTO tables(name,kind,rate_kop,sort,lamp_config) VALUES (?,?,?, COALESCE((SELECT MAX(sort) FROM tables),0)+1, ?)', f.name, f.kind, f.rate_kop, f.lamp_config ?? '{"type":"mock"}').lastInsertRowid);
    audit(c.user.id, 'table.create', { id, ...f });
    return { id };
  });
  route('PATCH', '/api/tables/:id', 'admin', (c) => {
    let f;
    try { f = tableFields(c.body, true); } catch (e) { if (e instanceof SyntaxError) throw bad('Некорректный JSON лампы'); throw e; }
    const keys = Object.keys(f);
    if (!keys.length) throw bad('Нечего менять');
    if (f.active === 0 && openCheckOfTable(+c.params.id)) throw conflict('За столом есть открытый чек');
    run(`UPDATE tables SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => f[k]), +c.params.id);
    audit(c.user.id, 'table.update', { id: +c.params.id, ...f });
    return { ok: true };
  });

  route('GET', '/api/users', 'admin', () => q('SELECT id,name,role,active,must_change,created_at FROM users ORDER BY id'));
  route('POST', '/api/users', 'admin', async (c) => {
    const name = str(c.body.name, 'имя', { min: 2, max: 40 });
    const role = oneOf(c.body.role, ['admin', 'worker'], 'роль');
    if (!validPin(c.body.pin)) throw bad('PIN — от 4 до 6 цифр');
    const id = Number(run('INSERT INTO users(name,role,pin_hash,must_change,created_at) VALUES (?,?,?,1,?)', name, role, await hashPin(c.body.pin), now()).lastInsertRowid);
    audit(c.user.id, 'user.create', { id, name, role });
    return { id };
  });
  route('PATCH', '/api/users/:id', 'admin', (c) => {
    const id = +c.params.id;
    const u = q1('SELECT * FROM users WHERE id=?', id);
    if (!u) throw notFound('Сотрудник не найден');
    const name = 'name' in c.body ? str(c.body.name, 'имя', { min: 2, max: 40 }) : u.name;
    const role = 'role' in c.body ? oneOf(c.body.role, ['admin', 'worker'], 'роль') : u.role;
    const active = 'active' in c.body ? (c.body.active ? 1 : 0) : u.active;
    tx(db, () => {
      const admins = q1("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id!=?", id).n;
      if (admins === 0 && (role !== 'admin' || !active)) throw conflict('Должен остаться хотя бы один активный администратор');
      if (id === c.user.id && !active) throw conflict('Нельзя отключить самого себя');
      if (!active && q1('SELECT 1 x FROM shifts WHERE closed_at IS NULL AND user_id=?', id)) throw conflict('У сотрудника открыта смена');
      run('UPDATE users SET name=?, role=?, active=? WHERE id=?', name, role, active, id);
      if (!active || role !== u.role) sessions.removeUser(id);
      audit(c.user.id, 'user.update', { id, name, role, active });
    });
    return { ok: true };
  });
  route('POST', '/api/users/:id/pin', 'admin', async (c) => {
    if (!validPin(c.body.pin)) throw bad('PIN — от 4 до 6 цифр');
    const id = +c.params.id;
    if (!q1('SELECT id FROM users WHERE id=?', id)) throw notFound('Сотрудник не найден');
    run('UPDATE users SET pin_hash=?, must_change=1 WHERE id=?', await hashPin(c.body.pin), id);
    sessions.removeUser(id);
    audit(c.user.id, 'user.pin_reset', { id });
    return { ok: true };
  });

  route('GET', '/api/settings', 'admin', () => settings());
  route('PUT', '/api/settings', 'admin', (c) => {
    const b = c.body;
    const out = {};
    if ('club_name' in b) out.club_name = str(b.club_name, 'название клуба', { min: 1, max: 60 });
    if ('step_min' in b) out.step_min = String(int(b.step_min, 'шаг тарификации', { min: 1, max: 60 }));
    if ('min_minutes' in b) out.min_minutes = String(int(b.min_minutes, 'минимальное время', { min: 0, max: 240 }));
    if ('max_discount_pct' in b) out.max_discount_pct = String(int(b.max_discount_pct, 'скидка', { min: 0, max: 100 }));
    for (const k of ['shift_start', 'shift_end']) {
      if (k in b) {
        if (!TIME_RE.test(b[k])) throw bad('Время смены указывайте в формате ЧЧ:ММ');
        out[k] = b[k];
      }
    }
    if ('sbp_note' in b) out.sbp_note = str(b.sbp_note, 'подпись QR', { max: 200 });
    if ('sbp_qr' in b) {
      if (typeof b.sbp_qr !== 'string' || (b.sbp_qr && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(b.sbp_qr)) || b.sbp_qr.length > 2_000_000) throw bad('QR должен быть картинкой (PNG/JPEG/SVG) до 1,5 МБ');
      out.sbp_qr = b.sbp_qr;
    }
    if (b.regen_hw_key) out.hw_key = newToken().slice(0, 32);
    tx(db, () => {
      for (const [k, v] of Object.entries(out)) run('UPDATE settings SET value=? WHERE key=?', v, k);
      audit(c.user.id, 'settings.update', { keys: Object.keys(out) });
    });
    return settings();
  });

  route('GET', '/api/reports', 'admin', (c) => {
    const to = +c.query.to || now();
    const from = +c.query.from || to - 7 * 86400000;
    if (!(from < to)) throw bad('Неверный период');
    return buildReport(from, to, Number.isFinite(+c.query.tz) ? +c.query.tz : 0);
  });

  route('GET', '/api/stock-moves', 'admin', (c) =>
    q(`SELECT m.*, p.name product_name, u.name user_name FROM stock_moves m JOIN products p ON p.id=m.product_id
       LEFT JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT ?`, Math.min(+c.query.limit || 100, 500)));

  route('GET', '/api/audit', 'admin', () =>
    q('SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300'));

  // ---------- диспетчер ----------

  const emit = () => listeners.forEach((fn) => fn());

  /** Пользователь по токену сессии (или null). */
  async function authenticate(token) {
    if (!token) return null;
    const sess = sessions.find(await sha(token));
    if (!sess || sess.expires_at < now()) return null;
    return q1('SELECT * FROM users WHERE id=? AND active=1', sess.user_id) || null;
  }

  async function dispatch({ method, path, query = {}, body = {}, headers = {}, token = null }) {
    try {
      let matched = null;
      let params = {};
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (m) { matched = r; params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); break; }
      }
      if (!matched) return { status: 404, data: { error: 'Не найдено' } };

      const c = { params, query, body, headers, user: null, token, setToken: undefined };
      if (matched.role) {
        const user = await authenticate(token);
        if (!user) return { status: 401, data: { error: 'Требуется вход' } };
        c.user = user;
        if (matched.role === 'admin' && user.role !== 'admin') return { status: 403, data: { error: 'Только для администратора' } };
        if (user.must_change && matched.role !== 'any' && path !== '/api/logout' && path !== '/api/me') {
          return { status: 403, data: { error: 'Сначала смените PIN', code: 'must_change_pin' } };
        }
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Некорректный запрос');

      const data = await matched.fn(c);
      if (method !== 'GET') emit();
      return { status: 200, data, setToken: c.setToken };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, data: { error: e.message, code: e.code } };
      console.error(`${method} ${path}`, e);
      return { status: 500, data: { error: 'Внутренняя ошибка' } };
    }
  }

  return {
    dispatch,
    authenticate,
    /** Подписка на любые изменения данных (для обновления интерфейса). */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit,
  };
}
