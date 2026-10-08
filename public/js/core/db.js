import { hashPin, randomHex } from './auth.js';

// Работает с любым адаптером SQLite с интерфейсом node:sqlite:
//   db.exec(sql), db.prepare(sql) -> { run(...a), get(...a), all(...a) }
// (в Node это DatabaseSync, в браузере — обёртка над sql.js, см. sqljs-db.js).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','worker')),
  pin_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pool',
  rate_kop INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  lamp_config TEXT NOT NULL DEFAULT '{"type":"mock"}',
  lamp_on INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  price_kop INTEGER NOT NULL,
  track_stock INTEGER NOT NULL DEFAULT 1,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  check_id INTEGER,
  user_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by INTEGER,
  opening_cash_kop INTEGER NOT NULL DEFAULT 0,
  counted_cash_kop INTEGER,
  expected_cash_kop INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS cash_ops (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  amount_kop INTEGER NOT NULL,           -- + внесение, - изъятие
  note TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('table','bar')),
  table_id INTEGER REFERENCES tables(id),
  status TEXT NOT NULL CHECK (status IN ('open','paid','void')),
  shift_id INTEGER REFERENCES shifts(id),
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by INTEGER,
  discount_kop INTEGER NOT NULL DEFAULT 0,
  discount_note TEXT,
  total_kop INTEGER,
  void_reason TEXT,
  voided_by INTEGER,
  voided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_checks_open ON checks(status, table_id);
CREATE INDEX IF NOT EXISTS idx_checks_closed ON checks(closed_at);

CREATE TABLE IF NOT EXISTS play_sessions (
  id INTEGER PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES tables(id),
  check_id INTEGER NOT NULL REFERENCES checks(id),
  status TEXT NOT NULL CHECK (status IN ('active','paused','ended')),
  rate_kop INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  accrued_sec INTEGER NOT NULL DEFAULT 0,
  running_since INTEGER,
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_sessions_check ON play_sessions(check_id);

CREATE TABLE IF NOT EXISTS check_lines (
  id INTEGER PRIMARY KEY,
  check_id INTEGER NOT NULL REFERENCES checks(id),
  kind TEXT NOT NULL CHECK (kind IN ('item','time')),
  product_id INTEGER REFERENCES products(id),
  session_id INTEGER REFERENCES play_sessions(id),
  name TEXT NOT NULL,
  price_kop INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_lines_check ON check_lines(check_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  check_id INTEGER NOT NULL REFERENCES checks(id),
  shift_id INTEGER REFERENCES shifts(id),
  method TEXT NOT NULL CHECK (method IN ('cash','card','sbp')),
  amount_kop INTEGER NOT NULL,           -- отрицательное значение = возврат
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id);
CREATE INDEX IF NOT EXISTS idx_payments_time ON payments(created_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT
);
`;

export const DEFAULT_SETTINGS = {
  club_name: 'SunClub',
  step_min: '1',          // шаг тарификации, минут
  min_minutes: '0',       // минимальное время к оплате, минут
  max_discount_pct: '10', // максимальная скидка для сотрудника, %
  sbp_qr: '',             // data:URL картинки QR-кода СБП
  sbp_note: '',           // подпись к QR (телефон / получатель)
  hw_key: '',             // ключ доступа для контроллера ламп
  shift_start: '10:00',   // плановое начало смены
  shift_end: '22:00',     // плановый конец смены
};

/** Создаёт таблицы и настройки по умолчанию (идемпотентно). */
export function initDb(db) {
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  db.prepare("UPDATE settings SET value=? WHERE key='hw_key' AND value=''").run(randomHex(16));
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Начальные данные для пустой базы: 2 админа, 3 сотрудника, столы и меню. Все PIN нужно сменить при первом входе. */
export async function seedIfEmpty(db, log = () => {}) {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const now = Date.now();
  const users = [
    ['Администратор 1', 'admin', '1111'],
    ['Администратор 2', 'admin', '2222'],
    ['Сотрудник 1', 'worker', '1001'],
    ['Сотрудник 2', 'worker', '1002'],
    ['Сотрудник 3', 'worker', '1003'],
  ];
  const iu = db.prepare('INSERT INTO users(name,role,pin_hash,must_change,created_at) VALUES (?,?,?,1,?)');
  const hashes = await Promise.all(users.map(([, , p]) => hashPin(p)));
  for (const [i, [n, r, p]] of users.entries()) {
    iu.run(n, r, hashes[i], now);
    log(`  ${n} (${r === 'admin' ? 'админ' : 'сотрудник'}): PIN ${p}`);
  }
  const it = db.prepare('INSERT INTO tables(name,kind,rate_kop,sort) VALUES (?,?,?,?)');
  [
    ['Стол 1', 'pool', 50000],
    ['Стол 2', 'pool', 50000],
    ['Стол 3', 'pool', 50000],
    ['Стол 4', 'pool', 50000],
    ['Стол 5', 'pyramid', 70000],
    ['Стол 6', 'snooker', 90000],
  ].forEach(([n, k, r], i) => it.run(n, k, r, i + 1));

  const ic = db.prepare('INSERT INTO categories(name,sort) VALUES (?,?)');
  const ip = db.prepare('INSERT INTO products(category_id,name,price_kop,stock,min_stock) VALUES (?,?,?,?,?)');
  const menu = {
    Напитки: [['Вода 0,5 л', 8000], ['Кола 0,33 л', 12000], ['Чай', 10000], ['Кофе', 15000], ['Пиво 0,5 л', 25000]],
    Снеки: [['Чипсы', 15000], ['Орешки', 12000], ['Сухарики', 10000], ['Сэндвич', 25000]],
  };
  let sort = 0;
  for (const [cat, items] of Object.entries(menu)) {
    const cid = Number(ic.run(cat, ++sort).lastInsertRowid);
    for (const [n, p] of items) ip.run(cid, n, p, 20, 5);
  }
}
