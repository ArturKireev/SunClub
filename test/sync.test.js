import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createSync, gzip, gunzip } from '../public/js/core/sync.js';

// Настоящий Code.gs выполняется в песочнице с имитацией Google Drive.
function appsScript(secret = 'секрет-для-теста-1234567890') {
  const files = new Map();
  const mkFile = (name) => ({ getBlob: () => ({ getDataAsString: () => files.get(name) }), setContent: (t) => files.set(name, t) });
  const ctx = {
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    DriveApp: {
      getFilesByName: (n) => { const has = files.has(n); let used = false; return { hasNext: () => has && !used, next: () => { used = true; return mkFile(n); } }; },
      createFile: (n, t) => files.set(n, t),
    },
    JSON, Date, String, Number, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../public/apps-script/Code.gs', import.meta.url), 'utf8').replace(/const SECRET = '[^']*';/, `const SECRET = '${secret}';`), ctx);
  let down = false;
  const fetchImpl = async (url, { body }) => {
    if (down) throw new TypeError('network');
    const out = ctx.doPost({ postData: { contents: body } });
    return { json: async () => JSON.parse(out.s) };
  };
  return { files, fetchImpl, secret, setDown: (v) => { down = v; } };
}

function device(cloud, name, bytes) {
  const mem = new Map();
  const dev = { bytes, applied: 0, statuses: [] };
  dev.sync = createSync({
    storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) },
    getBytes: async () => dev.bytes,
    applyBytes: async (b) => { dev.bytes = b; dev.applied += 1; },
    fetchImpl: cloud.fetchImpl,
    onStatus: (s) => dev.statuses.push(s),
    debounceMs: 5, pollMs: 1e9,
  });
  dev.sync.configure({ url: 'https://script.example/exec', key: cloud.secret, deviceName: name });
  return dev;
}
const bytesOf = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

test('gzip туда-обратно', async () => {
  const src = bytesOf('база клуба '.repeat(1000));
  const gz = await gzip(src);
  assert.ok(gz.length < src.length / 5);
  assert.equal(text(await gunzip(gz)), text(src));
});

test('второе устройство получает данные, изменения доходят в обе стороны', async () => {
  const cloud = appsScript();
  const club = device(cloud, 'Клуб', bytesOf('v1'));
  assert.equal(await club.sync.connect(), 'pushed');

  const owner = device(cloud, 'Телефон', bytesOf('пусто'));
  const r = await owner.sync.connect();
  assert.equal(r.cloudHasData, true);
  assert.equal(r.device_name, 'Клуб');
  await owner.sync.pull();
  assert.equal(text(owner.bytes), 'v1');

  club.bytes = bytesOf('v2: продажа');
  club.sync.markDirty();
  await club.sync.flush();
  await owner.sync.check();
  assert.equal(text(owner.bytes), 'v2: продажа');

  owner.bytes = bytesOf('v3: цена изменена');
  owner.sync.markDirty();
  await owner.sync.flush();
  await club.sync.check();
  assert.equal(text(club.bytes), 'v3: цена изменена');
  assert.equal(club.sync.status, 'synced');
  assert.ok(cloud.files.has('sunclub-db.prev.json'), 'предыдущая версия сохраняется');
});

test('конфликт: оба меняли, не зная друг о друге', async () => {
  const cloud = appsScript();
  const a = device(cloud, 'A', bytesOf('base'));
  await a.sync.connect();
  const b = device(cloud, 'B', bytesOf('x'));
  await b.sync.connect();
  await b.sync.pull();

  a.bytes = bytesOf('A меняет'); a.sync.markDirty(); await a.sync.flush();
  b.bytes = bytesOf('B меняет'); b.sync.markDirty(); await b.sync.flush();
  assert.equal(b.sync.status, 'conflict');
  assert.equal(b.sync.info.cloud.device_name, 'A');

  await b.sync.pull();                     // выбрали «взять из облака»
  assert.equal(text(b.bytes), 'A меняет');
  assert.equal(b.sync.status, 'synced');

  b.bytes = bytesOf('B снова'); b.sync.markDirty(); await b.sync.flush();
  a.bytes = bytesOf('A снова'); a.sync.markDirty(); await a.sync.flush();
  assert.equal(a.sync.status, 'conflict');
  await a.sync.forcePush();                // выбрали «записать моё»
  assert.equal(a.sync.status, 'synced');
  await b.sync.check();
  assert.equal(text(b.bytes), 'A снова');
});

test('нет связи: изменения копятся и уходят, когда связь вернулась', async () => {
  const cloud = appsScript();
  const a = device(cloud, 'A', bytesOf('1'));
  await a.sync.connect();
  cloud.setDown(true);
  a.bytes = bytesOf('2'); a.sync.markDirty();
  await a.sync.flush();
  assert.equal(a.sync.status, 'offline');
  assert.equal(a.sync.dirty, true);
  cloud.setDown(false);
  await a.sync.check();
  assert.equal(a.sync.status, 'synced');
  assert.equal(a.sync.dirty, false);
  const b = device(cloud, 'B', bytesOf('?'));
  await b.sync.connect(); await b.sync.pull();
  assert.equal(text(b.bytes), '2');
});

test('неверный ключ отклоняется, секрет по умолчанию не работает', async () => {
  const cloud = appsScript();
  const bad = device(cloud, 'X', bytesOf('1'));
  bad.sync.configure({ url: 'u', key: 'не тот ключ', deviceName: 'X' });
  await assert.rejects(() => bad.sync.connect(), /Неверный ключ/);
  const fresh = appsScript('ЗАМЕНИТЕ_НА_ДЛИННЫЙ_ПАРОЛЬ');
  const d = device(fresh, 'Y', bytesOf('1'));
  await assert.rejects(() => d.sync.connect(), /Задайте SECRET/);
});
