import { h, icon, toast } from '../ui.js';
import { get, post } from '../api.js';

/** Экран входа: выбор сотрудника → PIN. onDone(user) вызывается после входа и (если нужно) смены PIN. */
export async function renderLogin(root, onDone) {
  let users = [];
  try { users = await get('/api/login-users'); } catch (e) { toast(e.message, 'err'); }
  const box = h('div', { class: 'login-box' });
  root.replaceChildren(h('div', { class: 'login' }, box));
  showUsers();

  function brand(sub) {
    return [h('div', { class: 'brand' }, h('span', { class: 'dot' }), 'SunClub'), h('p', null, sub)];
  }

  function showUsers() {
    box.replaceChildren(...brand('Выберите сотрудника'), h('div', { class: 'users' }, users.map((u) =>
      h('button', { class: 'btn user-btn', onclick: () => showPin(u) },
        h('span', { class: 'avatar' }, u.name.trim()[0]?.toUpperCase() || '?'),
        h('span', { class: 'grow' }, u.name),
        h('span', { class: 'muted', style: { fontSize: '13px' } }, u.role === 'admin' ? 'админ' : 'сотрудник')))));
  }

  function showPin(u) {
    let pin = '';
    const dots = h('div', { class: 'pin-dots' });
    const err = h('div', { class: 'err' });
    const draw = () => dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('i', { class: i < pin.length ? 'on' : '' })));
    const submit = async () => {
      if (pin.length < 4) return;
      try {
        const r = await post('/api/login', { user_id: u.id, pin });
        if (r.user.must_change) return showChange(r.user, pin);
        onDone(r.user);
      } catch (e) { err.textContent = e.message; pin = ''; draw(); }
    };
    const press = (d) => { if (pin.length < 6) { pin += d; err.textContent = ''; draw(); } };
    const key = (e) => {
      if (!box.isConnected) return document.removeEventListener('keydown', key);
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') { pin = pin.slice(0, -1); draw(); }
      else if (e.key === 'Enter') submit();
    };
    document.addEventListener('keydown', key);
    box.replaceChildren(...brand(u.name), dots, err, h('div', { class: 'pad' },
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => h('button', { class: 'btn', onclick: () => press(d) }, d)),
      h('button', { class: 'btn ghost', onclick: showUsers }, '←'),
      h('button', { class: 'btn', onclick: () => press('0') }, '0'),
      h('button', { class: 'btn primary', onclick: submit }, icon('check'))));
    draw();
  }

  function showChange(user, oldPin) {
    const a = h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'off', placeholder: 'Новый PIN (4–6 цифр)' });
    const b = h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'off', placeholder: 'Повторите PIN' });
    const err = h('div', { class: 'err' });
    const save = async () => {
      if (a.value !== b.value) { err.textContent = 'PIN не совпадают'; return; }
      try {
        await post('/api/me/pin', { old_pin: oldPin, new_pin: a.value });
        onDone({ ...user, must_change: false });
      } catch (e) { err.textContent = e.message; }
    };
    box.replaceChildren(...brand('Задайте свой PIN'), h('div', { class: 'stack' }, a, b, err,
      h('button', { class: 'btn primary lg block', onclick: save }, 'Сохранить и войти')));
    a.focus();
  }
}
