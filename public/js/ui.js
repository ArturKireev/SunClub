// Мелкие UI-хелперы без зависимостей: создание DOM, модальные окна, уведомления, формы.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}

function append(el, kids) {
  // в строках «название — значение» каждый текст оборачиваем в span, иначе flex склеит их в один блок
  const wrap = el.classList?.contains('sumrow');
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    if (k instanceof Node) el.append(k);
    else el.append(wrap ? h('span', null, String(k)) : document.createTextNode(String(k)));
  }
}

const ICONS = {
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  pause: '<path d="M7 4v16M17 4v16"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  logout: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>',
  table: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="7" cy="10" r=".8"/><circle cx="17" cy="14" r=".8"/>',
  bar: '<path d="M5 3h14l-1 8a5 5 0 0 1-12 0zM12 16v5M8 21h8"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
};
export function icon(name) {
  const s = document.createElement('span');
  s.style.display = 'inline-flex';
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s.firstChild;
}

// ---------- деньги и даты ----------

export function parseMoney(s) {
  const t = String(s ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (t === '' || !/^-?\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100);
}
export const rubInput = (kop) => (kop % 100 === 0 ? String(kop / 100) : (kop / 100).toFixed(2));

const dtf = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' });
export const fmtDateTime = (ms) => (ms ? dtf.format(ms) : '—');
export const fmtTime = (ms) => (ms ? tf.format(ms) : '—');
export const fmtDay = (ms) => df.format(ms);

// ---------- уведомления ----------

export function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}

// ---------- модальные окна ----------

const stack = [];

/**
 * openModal({ title, render, footer, size, live })
 * render() возвращает содержимое; если live — окно перерисовывается при обновлении данных.
 * footer(modal) возвращает массив кнопок.
 */
export function openModal({ title, render, footer, size = '', live = false, onclose }) {
  const root = document.getElementById('modal-root');
  const body = h('div', { class: 'body' });
  const foot = h('footer');
  const titleEl = h('h2');
  const m = {
    el: null,
    close() {
      const i = stack.indexOf(m);
      if (i >= 0) stack.splice(i, 1);
      m.el.remove();
      document.removeEventListener('keydown', onKey);
      onclose?.();
    },
    rerender() {
      const t = typeof title === 'function' ? title() : title;
      titleEl.textContent = t ?? '';
      const scroll = body.scrollTop;
      body.replaceChildren();
      append(body, [render(m)]);
      body.scrollTop = scroll;
      const f = footer ? footer(m) : [];
      foot.replaceChildren();
      append(foot, f);
      foot.classList.toggle('hidden', !f || f.length === 0);
    },
    live,
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && stack[stack.length - 1] === m) m.close();
  };
  m.el = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === m.el) m.close(); } },
    h('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true' },
      h('header', null, titleEl, h('button', { class: 'btn ghost x', onclick: () => m.close(), 'aria-label': 'Закрыть' }, icon('x'))),
      body, foot));
  document.addEventListener('keydown', onKey);
  root.append(m.el);
  stack.push(m);
  m.rerender();
  return m;
}

export const refreshModals = () => stack.filter((m) => m.live).forEach((m) => m.rerender());
export const closeAllModals = () => [...stack].forEach((m) => m.close());

export function confirmDialog(text, { okText = 'Подтвердить', danger = false, title = 'Подтверждение' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openModal({
      title, size: 'narrow',
      render: () => h('p', { style: { margin: 0 } }, text),
      footer: (m) => [
        h('button', { class: 'btn', onclick: () => m.close() }, 'Отмена'),
        h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, onclick: () => { finish(true); m.close(); } }, okText),
      ],
      onclose: () => finish(false),
    });
  });
}

/**
 * Форма в модальном окне. fields: [{name,label,type,value,options,hint,placeholder}]
 * type: text | password | money | int | select | check | textarea | file | note
 * submit(values) — async; при ошибке окно остаётся открытым и показывает сообщение.
 */
export function formDialog({ title, fields, submitText = 'Сохранить', submit, danger = false, size = 'narrow', extra }) {
  return new Promise((resolve) => {
    const inputs = {};
    let ok = false;
    const err = h('div', { class: 'err', style: { minHeight: 0, textAlign: 'left' } });
    const body = h('div', { class: 'stack' }, fields.map((f) => {
      let input;
      if (f.type === 'note') return h('div', { class: 'muted' }, f.label);
      if (f.type === 'select') {
        input = h('select', { value: f.value }, f.options.map((o) => h('option', { value: o.v }, o.l)));
        input.value = f.value ?? f.options[0]?.v;
      } else if (f.type === 'check') {
        input = h('input', { type: 'checkbox', checked: !!f.value });
        inputs[f.name] = { el: input, f };
        return h('label', { class: 'check' }, input, f.label);
      } else if (f.type === 'textarea') input = h('textarea', { rows: 3, value: f.value ?? '', placeholder: f.placeholder });
      else if (f.type === 'file') input = h('input', { type: 'file', accept: f.accept });
      else {
        input = h('input', {
          type: f.type === 'password' ? 'password' : 'text', value: f.value ?? '', placeholder: f.placeholder,
          inputmode: f.type === 'money' ? 'decimal' : f.type === 'int' || f.type === 'password' ? 'numeric' : null,
          autocomplete: 'off', maxlength: f.maxlength,
        });
      }
      inputs[f.name] = { el: input, f };
      return h('div', { class: 'field' }, h('label', null, f.label), input, f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    }), extra, err);

    const collect = async () => {
      const v = {};
      for (const [name, { el, f }] of Object.entries(inputs)) {
        if (f.type === 'check') v[name] = el.checked;
        else if (f.type === 'money') {
          const n = parseMoney(el.value);
          if (Number.isNaN(n)) throw new Error(`Введите сумму: ${f.label}`);
          v[name] = n;
        } else if (f.type === 'int') {
          const n = Number(String(el.value).replace(/\s/g, ''));
          if (!Number.isInteger(n)) throw new Error(`Введите целое число: ${f.label}`);
          v[name] = n;
        } else if (f.type === 'file') v[name] = el.files[0] || null;
        else v[name] = el.value;
      }
      return v;
    };

    const m = openModal({
      title, size,
      render: () => body,
      footer: (mm) => [
        h('button', { class: 'btn', onclick: () => mm.close() }, 'Отмена'),
        h('button', {
          class: `btn ${danger ? 'danger solid' : 'primary'}`,
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            err.textContent = '';
            try {
              await submit(await collect());
              ok = true;
              mm.close();
            } catch (ex) {
              err.textContent = ex.message;
              btn.disabled = false;
            }
          },
        }, submitText),
      ],
      onclose: () => resolve(ok),
    });
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'file') m.el.querySelector('footer .btn:last-child').click(); });
    setTimeout(() => body.querySelector('input:not([type=checkbox]),select,textarea')?.focus(), 30);
  });
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.readAsDataURL(file);
  });
}
