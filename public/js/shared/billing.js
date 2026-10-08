// Общая логика тарификации: используется и сервером, и интерфейсом.
// Деньги везде хранятся в копейках (целые числа), время — в миллисекундах.

/** Сколько секунд наиграно по сессии на момент now. */
export function playSeconds(session, now) {
  let sec = session.accrued_sec || 0;
  if (session.running_since) sec += Math.max(0, Math.floor((now - session.running_since) / 1000));
  return sec;
}

/**
 * Стоимость времени. Минуты округляются вверх до шага (step_min),
 * но не меньше min_minutes; итог округляется до целого рубля.
 */
export function timeCharge(seconds, rateKop, cfg = {}) {
  if (!(seconds > 0)) return 0;
  const step = Math.max(1, cfg.step_min | 0 || 1);
  const min = Math.max(0, cfg.min_minutes | 0);
  const minutes = Math.max(Math.ceil(seconds / (60 * step)) * step, min);
  return Math.round((minutes * rateKop) / 60 / 100) * 100;
}

/** Итоги чека. lines: [{price_kop, qty}], sessions: сессии чека (учитываются только активные/на паузе). */
export function checkTotals(check, lines, sessions, cfg, now) {
  const frozen = lines.reduce((s, l) => s + l.price_kop * l.qty, 0);
  let live = 0;
  for (const s of sessions) {
    if (s.status === 'ended') continue;
    live += timeCharge(playSeconds(s, now), s.rate_kop, cfg);
  }
  const subtotal = frozen + live;
  const discount = check.discount_kop || 0;
  return { frozen_kop: frozen, live_kop: live, subtotal_kop: subtotal, total_kop: Math.max(0, subtotal - discount) };
}

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
export function money(kop) {
  return rub.format((kop || 0) / 100) + ' ₽';
}

export function duration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function durationHuman(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}
