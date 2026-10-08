/**
 * SunClub — облачное хранилище для синхронизации.
 *
 * Хранит одну актуальную копию базы клуба в файле на вашем Google Диске и предыдущую версию рядом (на случай ошибки).
 * Само приложение работает на устройстве мгновенно, а сюда отправляет копию в фоне.
 *
 * Как подключить:
 *  1. script.google.com → «Новый проект», вставьте этот код целиком.
 *  2. Замените SECRET ниже на длинный пароль (20+ символов, придумайте сами) и сохраните.
 *  3. «Начать развертывание» → «Новое развертывание» → тип «Веб-приложение»:
 *       выполнять от имени: Я;  доступ: Все.
 *     Разрешите доступ к Диску. Скопируйте «URL веб-приложения».
 *  4. В SunClub: Настройки → Облако → вставьте URL и тот же пароль.
 */
const SECRET = 'ЗАМЕНИТЕ_НА_ДЛИННЫЙ_ПАРОЛЬ';
const FILE = 'sunclub-db.json';
const PREV = 'sunclub-db.prev.json';

function doGet() {
  return out({ ok: true, name: 'SunClub sync' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ error: 'Некорректный запрос' });
  }
  if (!SECRET || SECRET.indexOf('ЗАМЕНИТЕ') === 0) return out({ error: 'Задайте SECRET в Code.gs' });
  if (!safeEqual(String(req.key || ''), SECRET)) return out({ error: 'Неверный ключ' });

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const cur = read(FILE);
    const version = cur ? cur.version : 0;
    const info = cur ? { version: cur.version, updated_at: cur.updated_at, device_id: cur.device_id, device_name: cur.device_name } : { version: 0 };

    if (req.action === 'meta') return out(info);
    if (req.action === 'get') return out(cur || { version: 0 });
    if (req.action === 'put') {
      if (typeof req.data !== 'string' || !req.data.length || req.data.length > 40 * 1024 * 1024) return out({ error: 'Некорректные данные' });
      if (!req.force && Number(req.base_version) !== version) return out(Object.assign({ conflict: true }, info));
      if (cur) write(PREV, JSON.stringify(cur));
      const next = {
        version: version + 1,
        updated_at: Date.now(),
        device_id: String(req.device_id || '').slice(0, 64),
        device_name: String(req.device_name || '').slice(0, 64),
        data: req.data,
      };
      write(FILE, JSON.stringify(next));
      return out({ ok: true, version: next.version, updated_at: next.updated_at });
    }
    return out({ error: 'Неизвестное действие' });
  } finally {
    lock.releaseLock();
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function find(name) {
  const it = DriveApp.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function read(name) {
  const f = find(name);
  if (!f) return null;
  const text = f.getBlob().getDataAsString();
  return text ? JSON.parse(text) : null;
}

function write(name, text) {
  const f = find(name);
  if (f) f.setContent(text);
  else DriveApp.createFile(name, text, 'application/json');
}
