// Облачная синхронизация: устройство работает локально и мгновенно, а копия базы уходит в облако в фоне.
// Версионирование «сравнить и записать»: запись принимается, только если вы начинали с последней версии из облака.
// Хранилище — веб-приложение Google Apps Script (public/apps-script/Code.gs); протокол простой: meta / get / put.

const toB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));

/**
 * deps: { storage, getBytes(), applyBytes(bytes), fetchImpl, onStatus(status, info), debounceMs, pollMs, now }
 * status: off | synced | pending | offline | conflict | error
 */
export function createSync({ storage, getBytes, applyBytes, fetchImpl = (...a) => fetch(...a), onStatus = () => {}, debounceMs = 8000, pollMs = 20000, now = Date.now }) {
  const CFG = 'sunclub_sync_cfg';
  const META = 'sunclub_sync_meta';
  const read = (k, d) => { try { return JSON.parse(storage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => storage.setItem(k, JSON.stringify(v));

  let cfg = read(CFG, null);
  let meta = read(META, { base: 0, dirty: false });
  let status = cfg ? 'pending' : 'off';
  let info = {};
  let seq = 0;
  let timer = 0;
  let poller = 0;
  let busy = null;

  if (!cfg?.deviceId && cfg) cfg.deviceId = Math.random().toString(36).slice(2);

  const setStatus = (s, extra = {}) => { status = s; info = { ...info, ...extra }; onStatus(status, info); };
  const saveMeta = () => write(META, meta);

  async function call(action, payload = {}) {
    let res;
    try {
      res = await fetchImpl(cfg.url, { method: 'POST', body: JSON.stringify({ key: cfg.key, action, ...payload }), redirect: 'follow' });
    } catch (e) {
      const err = new Error('Нет связи с облаком');
      err.offline = true;
      throw err;
    }
    let data;
    try { data = await res.json(); } catch { throw new Error('Облако ответило не так, как ожидалось. Проверьте адрес веб-приложения.'); }
    if (data.error) throw new Error(data.error);
    return data;
  }

  // Все операции выполняем строго по очереди.
  const exclusive = (fn) => { busy = (busy || Promise.resolve()).catch(() => {}).then(fn); return busy; };

  async function doPush(force = false) {
    const startSeq = seq;
    const data = toB64(await gzip(await getBytes()));
    const r = await call('put', { base_version: meta.base, device_id: cfg.deviceId, device_name: cfg.deviceName, data, force });
    if (r.conflict) { setStatus('conflict', { cloud: r }); return false; }
    meta.base = r.version;
    if (seq === startSeq) meta.dirty = false;
    saveMeta();
    setStatus(meta.dirty ? 'pending' : 'synced', { version: r.version, at: r.updated_at, cloud: null });
    if (meta.dirty) schedule();
    return true;
  }

  async function doPull() {
    const r = await call('get');
    if (!r.version) throw new Error('В облаке пока нет данных');
    await applyBytes(await gunzip(fromB64(r.data)));
    meta = { base: r.version, dirty: false };
    saveMeta();
    setStatus('synced', { version: r.version, at: r.updated_at, cloud: null });
  }

  async function doCheck() {
    const m = await call('meta');
    if (m.version > meta.base) {
      if (meta.dirty) return setStatus('conflict', { cloud: m });
      return doPull();
    }
    if (m.version < meta.base) return setStatus('conflict', { cloud: m });
    if (meta.dirty) return doPush();
    return setStatus('synced', { version: m.version, at: m.updated_at });
  }

  function guard(fn) {
    return exclusive(async () => {
      if (!cfg) return;
      try { await fn(); } catch (e) { setStatus(e.offline ? 'offline' : 'error', { error: e.message }); if (!e.offline) throw e; }
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (status !== 'conflict') guard(() => doPush()).catch(() => {}); }, debounceMs);
  }

  return {
    get status() { return status; },
    get info() { return info; },
    get config() { return cfg && { url: cfg.url, key: cfg.key, deviceName: cfg.deviceName }; },
    get configured() { return !!cfg; },

    configure({ url, key, deviceName }) {
      cfg = { url: url.trim(), key: key.trim(), deviceName: (deviceName || 'Устройство').trim(), deviceId: cfg?.deviceId || Math.random().toString(36).slice(2) };
      write(CFG, cfg);
      setStatus('pending');
    },

    disconnect() {
      cfg = null;
      storage.removeItem(CFG);
      meta = { base: 0, dirty: false };
      saveMeta();
      clearTimeout(timer);
      clearInterval(poller);
      setStatus('off');
    },

    /** Первое подключение устройства: что делать с данными. 'pushed' — облако было пустым, туда ушли данные этого устройства. 'cloud-has-data' — нужен выбор. */
    async connect() {
      let result;
      await guard(async () => {
        const m = await call('meta');
        if (!m.version) { meta = { base: 0, dirty: true }; await doPush(); result = 'pushed'; }
        else result = { cloudHasData: true, version: m.version, device_name: m.device_name, updated_at: m.updated_at };
      });
      return result;
    },

    /** Забрать данные из облака на это устройство (локальные будут заменены). */
    pull: () => guard(doPull),
    /** Записать данные этого устройства в облако поверх облачных. */
    forcePush: () => guard(() => doPush(true)),
    check: () => guard(doCheck),

    /** Вызывать после каждого изменения данных на этом устройстве. */
    markDirty() {
      if (!cfg) return;
      seq += 1;
      meta.dirty = true;
      saveMeta();
      if (status !== 'conflict') setStatus('pending');
      schedule();
    },

    start() {
      clearInterval(poller);
      if (!cfg) return;
      guard(doCheck).catch(() => {});
      poller = setInterval(() => { if (status !== 'conflict') guard(doCheck).catch(() => {}); }, pollMs);
    },
    stop() { clearTimeout(timer); clearInterval(poller); },
    /** Отправить немедленно (например, при закрытии смены). */
    flush: () => { clearTimeout(timer); return meta.dirty && status !== 'conflict' ? guard(() => doPush()) : Promise.resolve(); },
    get dirty() { return meta.dirty; },
  };
}
