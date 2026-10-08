export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (m) => new HttpError(400, m);
export const conflict = (m) => new HttpError(409, m);
export const forbidden = (m = 'Недостаточно прав') => new HttpError(403, m);
export const notFound = (m = 'Не найдено') => new HttpError(404, m);

export function int(v, name, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`Некорректное значение: ${name}`);
  return v;
}

export function str(v, name, { min = 0, max = 200 } = {}) {
  if (typeof v !== 'string') throw bad(`Некорректное значение: ${name}`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`Некорректное значение: ${name}`);
  return s;
}

export function oneOf(v, list, name) {
  if (!list.includes(v)) throw bad(`Некорректное значение: ${name}`);
  return v;
}
