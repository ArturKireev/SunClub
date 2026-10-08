// Хеширование PIN и токены на WebCrypto: один код работает и в браузере, и в Node.
const enc = new TextEncoder();
const ITER = 100_000;

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));

export function randomHex(bytes = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function derive(pin, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${toHex(salt)}$${toHex(await derive(pin, salt, ITER))}`;
}

export async function verifyPin(pin, stored) {
  const [, iter, saltHex, hashHex] = stored.split('$');
  const actual = await derive(pin, fromHex(saltHex), Number(iter));
  return safeEqual(actual, fromHex(hashHex));
}

export const validPin = (pin) => typeof pin === 'string' && /^\d{4,6}$/.test(pin);

export async function sha(s) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
export const newToken = () => randomHex(32);

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
