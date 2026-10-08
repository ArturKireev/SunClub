import test from 'node:test';
import assert from 'node:assert/strict';
import { timeCharge, playSeconds, checkTotals } from '../public/js/core/billing.js';

const RATE = 60000; // 600 ₽/час

test('стоимость времени: поминутно с округлением до рубля', () => {
  assert.equal(timeCharge(0, RATE), 0);
  assert.equal(timeCharge(1, RATE), 1000);            // начатая минута = 10 ₽
  assert.equal(timeCharge(90 * 60, RATE), 90000);     // 90 мин = 900 ₽
  assert.equal(timeCharge(90 * 60 + 1, RATE), 91000);
});

test('шаг тарификации и минимум', () => {
  assert.equal(timeCharge(61, RATE, { step_min: 15 }), 15000);        // 2 мин → 15 мин
  assert.equal(timeCharge(16 * 60, RATE, { step_min: 15 }), 30000);
  assert.equal(timeCharge(60, RATE, { min_minutes: 30 }), 30000);
});

test('playSeconds учитывает паузу', () => {
  assert.equal(playSeconds({ accrued_sec: 100, running_since: null }, 1e9), 100);
  assert.equal(playSeconds({ accrued_sec: 100, running_since: 1_000_000 }, 1_030_000), 130);
});

test('итоги чека: строки + текущая игра − скидка', () => {
  const lines = [{ price_kop: 12000, qty: 2 }];
  const sessions = [{ status: 'active', accrued_sec: 0, running_since: 1000, rate_kop: RATE }];
  const t = checkTotals({ discount_kop: 5000 }, lines, sessions, {}, 1000 + 30 * 60 * 1000);
  assert.equal(t.frozen_kop, 24000);
  assert.equal(t.live_kop, 30000);
  assert.equal(t.total_kop, 49000);
});
