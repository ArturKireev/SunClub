/**
 * Управление лампами над столами.
 *
 * У каждого стола в lamp_config задан драйвер:
 *   {"type":"mock"}                                   — лампы нет, состояние только запоминается (по умолчанию)
 *   {"type":"http","on_url":"...","off_url":"...",    — реле/контроллер с HTTP-API
 *     "method":"POST","headers":{...}}
 *
 * Обратное направление (контроллер сам сообщает о состоянии света) — POST /api/hw/lamp, см. app.js.
 * Чтобы подключить другой протокол (MQTT, Modbus, Shelly), добавьте драйвер в DRIVERS.
 */
const TIMEOUT_MS = 3000;

function parseConfig(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return { type: 'mock' }; }
}

export function createLamps(db, { fetchImpl = globalThis.fetch } = {}) {
  const DRIVERS = {
    async mock() {},
    async http(cfg, on) {
      const url = on ? cfg.on_url : cfg.off_url;
      if (!url) throw new Error('не задан URL');
      const res = await fetchImpl(url, {
        method: cfg.method || 'POST',
        headers: cfg.headers || {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  };

  return {
    /** Включить/выключить лампу. Возвращает текст предупреждения, если команда не дошла (учёт при этом не страдает). */
    async set(table, on) {
      let warning = null;
      const cfg = parseConfig(table.lamp_config);
      try {
        const driver = DRIVERS[cfg.type];
        if (!driver) throw new Error(`неизвестный драйвер «${cfg.type}»`);
        await driver(cfg, on);
      } catch (e) {
        warning = `Лампа «${table.name}»: команда не выполнена (${e.message}). Включите/выключите вручную.`;
      }
      db.prepare('UPDATE tables SET lamp_on=? WHERE id=?').run(on ? 1 : 0, table.id);
      return warning;
    },
  };
}
