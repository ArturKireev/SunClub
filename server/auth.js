import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const validPin = (pin) => typeof pin === 'string' && /^\d{4,6}$/.test(pin);

export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

/** Защита от подбора PIN: 5 ошибок подряд блокируют вход пользователя на минуту. */
export function createLoginLimiter({ max = 5, lockMs = 60_000 } = {}) {
  const fails = new Map();
  return {
    check(userId, now) {
      const f = fails.get(userId);
      return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
    },
    fail(userId, now) {
      const f = fails.get(userId) || { n: 0, until: 0 };
      f.n += 1;
      if (f.n >= max) { f.until = now + lockMs; f.n = 0; }
      fails.set(userId, f);
    },
    ok(userId) { fails.delete(userId); },
  };
}
