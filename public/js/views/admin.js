import { h, icon, formDialog, openModal, confirmDialog, fmtDateTime, rubInput, toast, readFileAsDataUrl } from '../ui.js';
import { get, post, patch, put } from '../api.js';
import { store, loadState } from '../store.js';
import { money } from '../shared/billing.js';
import { kindLabel } from './tables.js';

let tab = 'tables';
const TABS = [['tables', 'Столы'], ['staff', 'Сотрудники'], ['params', 'Параметры'], ['hw', 'Лампы и оборудование'], ['audit', 'Журнал']];
const KIND_OPTS = [['pool', 'Пул'], ['pyramid', 'Пирамида'], ['snooker', 'Снукер'], ['carom', 'Карамболь']].map(([v, l]) => ({ v, l }));

function tableForm(t, ctx) {
  const cfg = t ? JSON.parse(t.lamp_config || '{}') : { type: 'mock' };
  return formDialog({
    title: t ? `Стол · ${t.name}` : 'Новый стол', size: '',
    fields: [
      { name: 'name', label: 'Название', type: 'text', value: t?.name },
      { name: 'kind', label: 'Тип', type: 'select', value: t?.kind || 'pool', options: KIND_OPTS },
      { name: 'rate', label: 'Тариф, ₽ в час', type: 'money', value: t ? rubInput(t.rate_kop) : '' },
      { name: 'lamp_type', label: 'Управление лампой', type: 'select', value: cfg.type || 'mock', options: [{ v: 'mock', l: 'Вручную / не подключено' }, { v: 'http', l: 'HTTP-реле (URL включения/выключения)' }] },
      { name: 'on_url', label: 'URL включения лампы', type: 'text', value: cfg.on_url || '', placeholder: 'http://192.168.1.50/relay/1/on', hint: 'Только для HTTP-реле' },
      { name: 'off_url', label: 'URL выключения лампы', type: 'text', value: cfg.off_url || '', placeholder: 'http://192.168.1.50/relay/1/off' },
      ...(t ? [{ name: 'active', label: 'Стол используется', type: 'check', value: !!t.active }] : []),
    ],
    submit: async (v) => {
      const lamp_config = v.lamp_type === 'http' ? { type: 'http', on_url: v.on_url.trim(), off_url: v.off_url.trim() } : { type: 'mock' };
      const body = { name: v.name, kind: v.kind, rate_kop: v.rate, lamp_config };
      if (t) await patch(`/api/tables/${t.id}`, { ...body, active: v.active });
      else await post('/api/tables', body);
      await loadState();
      ctx.rerender();
    },
  });
}

function userForm(u, ctx) {
  return formDialog({
    title: u ? `Сотрудник · ${u.name}` : 'Новый сотрудник',
    fields: [
      { name: 'name', label: 'Имя', type: 'text', value: u?.name },
      { name: 'role', label: 'Роль', type: 'select', value: u?.role || 'worker', options: [{ v: 'worker', l: 'Сотрудник' }, { v: 'admin', l: 'Администратор' }] },
      ...(u ? [{ name: 'active', label: 'Работает', type: 'check', value: !!u.active }]
        : [{ name: 'pin', label: 'Временный PIN (4–6 цифр)', type: 'password', maxlength: 6, hint: 'При первом входе сотрудник задаст свой PIN' }]),
    ],
    submit: async (v) => {
      if (u) await patch(`/api/users/${u.id}`, { name: v.name, role: v.role, active: v.active });
      else await post('/api/users', { name: v.name, role: v.role, pin: v.pin });
      await loadState();
      ctx.rerender();
    },
  });
}

function resetPin(u) {
  return formDialog({
    title: `Сброс PIN · ${u.name}`, submitText: 'Сбросить',
    fields: [{ name: 'pin', label: 'Временный PIN (4–6 цифр)', type: 'password', maxlength: 6, hint: 'Сотрудник сменит его при следующем входе. Текущие сессии будут завершены.' }],
    submit: async (v) => { await post(`/api/users/${u.id}/pin`, { pin: v.pin }); toast('PIN сброшен'); },
  });
}

async function tablesTab(ctx) {
  const { tables } = store.state;
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('div', { class: 'muted grow' }, 'Тариф фиксируется в момент старта игры: смена цены не влияет на уже идущие столы.'),
      h('button', { class: 'btn primary', onclick: () => tableForm(null, ctx) }, icon('plus'), 'Стол')),
    h('div', { class: 'card scroll-x' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['№', 'Стол', 'Тип', 'Тариф', 'Лампа', ''].map((t, i) => h('th', { class: i === 3 ? 'r' : '' }, t)))),
      h('tbody', null, tables.map((t) => {
        const cfg = JSON.parse(t.lamp_config || '{}');
        return h('tr', { style: t.active ? null : { opacity: .45 } }, h('td', { class: 'num muted' }, t.id), h('td', null, t.name), h('td', null, kindLabel(t.kind)),
          h('td', { class: 'r num' }, `${money(t.rate_kop)}/ч`), h('td', null, cfg.type === 'http' ? h('span', { class: 'chip ok' }, 'HTTP-реле') : h('span', { class: 'chip' }, 'вручную')),
          h('td', { class: 'r' }, h('button', { class: 'btn sm ghost', onclick: () => tableForm(t, ctx) }, icon('edit'))));
      })))));
}

async function staffTab(ctx) {
  const users = await get('/api/users');
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('div', { class: 'muted grow' }, 'Администраторы видят отчёты, настройки, возвраты и склад. Сотрудники работают со столами, баром и сменами.'),
      h('button', { class: 'btn primary', onclick: () => userForm(null, ctx) }, icon('plus'), 'Сотрудник')),
    h('div', { class: 'card scroll-x' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Имя', 'Роль', 'Статус', ''].map((t) => h('th', null, t)))),
      h('tbody', null, users.map((u) => h('tr', { style: u.active ? null : { opacity: .5 } },
        h('td', null, u.name), h('td', null, u.role === 'admin' ? 'Администратор' : 'Сотрудник'),
        h('td', null, !u.active ? h('span', { class: 'chip' }, 'отключён') : u.must_change ? h('span', { class: 'chip warn' }, 'ещё не сменил PIN') : h('span', { class: 'chip ok' }, 'активен')),
        h('td', { class: 'r nowrap' }, h('button', { class: 'btn sm', onclick: () => resetPin(u) }, 'Сбросить PIN'), ' ', h('button', { class: 'btn sm ghost', onclick: () => userForm(u, ctx) }, icon('edit')))))))));
}

async function paramsTab(ctx) {
  const s = await get('/api/settings');
  let qr = s.sbp_qr;
  const f = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const name = h('input', { type: 'text', value: s.club_name });
  const step = h('input', { type: 'number', min: 1, max: 60, value: s.step_min });
  const min = h('input', { type: 'number', min: 0, max: 240, value: s.min_minutes });
  const disc = h('input', { type: 'number', min: 0, max: 100, value: s.max_discount_pct });
  const note = h('input', { type: 'text', value: s.sbp_note, placeholder: 'Например: СБП по номеру +7 900 000-00-00, SunClub' });
  const preview = h('div');
  const drawQr = () => preview.replaceChildren(qr ? h('div', { class: 'row' }, h('img', { src: qr, alt: 'QR', style: { width: '120px', background: '#fff', borderRadius: '10px', padding: '6px' } }), h('button', { class: 'btn sm danger', onclick: () => { qr = ''; drawQr(); } }, 'Убрать')) : h('span', { class: 'muted' }, 'QR не загружен'));
  drawQr();
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/svg+xml', onchange: async () => {
    const fl = file.files[0];
    if (!fl) return;
    if (fl.size > 1_500_000) return toast('Файл больше 1,5 МБ', 'err');
    qr = await readFileAsDataUrl(fl);
    drawQr();
  } });
  return h('div', { class: 'card stack', style: { maxWidth: '640px' } },
    f('Название клуба', name),
    f('Шаг тарификации, минут', step, 'Время округляется вверх до шага: при шаге 1 — поминутно, при 15 — по четверти часа.'),
    f('Минимальное время к оплате, минут', min, '0 — без минимума. Применяется к каждой игре (и к каждому столу при переносе).'),
    f('Максимальная скидка для сотрудника, %', disc, 'Администратор может дать любую скидку.'),
    f('QR-код СБП (картинка)', h('div', { class: 'stack' }, file, preview), 'Показывается кассиру при оплате «QR / СБП». На первом этапе оплата подтверждается вручную.'),
    f('Подпись под QR', note),
    h('div', null, h('button', { class: 'btn primary', onclick: async () => {
      try {
        await put('/api/settings', { club_name: name.value, step_min: +step.value, min_minutes: +min.value, max_discount_pct: +disc.value, sbp_note: note.value, sbp_qr: qr });
        toast('Настройки сохранены');
        await loadState();
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Сохранить')));
}

async function hwTab(ctx) {
  const s = await get('/api/settings');
  const url = `${location.origin}/api/hw/lamp`;
  return h('div', { class: 'stack', style: { maxWidth: '760px' } },
    h('div', { class: 'card stack' },
      h('h3', null, 'Как это работает'),
      h('p', { style: { margin: 0 } }, 'Свет над столом горит — идёт игра, начисляется оплата. Программа сама включает лампу при старте игры и гасит на паузе и при остановке (для столов с «HTTP-реле»). В обратную сторону: контроллер может сообщать программе о состоянии света — тогда игра стартует/ставится на паузу по сигналу лампы.'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Если команда не дошла до реле, учёт времени не ломается: программа покажет предупреждение, лампу нужно переключить вручную.')),
    h('div', { class: 'card stack' },
      h('h3', null, 'Сигнал от контроллера → программа'),
      h('div', { class: 'muted' }, 'Адрес и ключ для контроллера (POST, JSON):'),
      h('pre', { class: 'mono' }, `POST ${url}\nX-Device-Key: ${s.hw_key}\nContent-Type: application/json\n\n{"table_id": 1, "on": true}`),
      h('div', { class: 'muted' }, 'Номера столов: ' + store.state.tables.map((t) => `${t.id} — ${t.name}`).join(', ')),
      h('div', null, h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Старый ключ перестанет работать — контроллерам нужно будет прописать новый.', { danger: true, okText: 'Создать новый ключ' }))) return;
        await put('/api/settings', { regen_hw_key: true });
        ctx.rerender();
      } }, 'Перевыпустить ключ'))),
    h('div', { class: 'card stack' },
      h('h3', null, 'Программа → лампа'),
      h('p', { style: { margin: 0 } }, 'Для каждого стола во вкладке «Столы» можно указать два адреса: включить и выключить лампу (реле с HTTP-API, например Shelly, Sonoff в режиме DIY, ESP-контроллер). Другие протоколы (MQTT, Modbus) подключаются добавлением драйвера в server/lamps.js.')));
}

async function auditTab() {
  const rows = await get('/api/audit');
  return h('div', { class: 'card scroll-x' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Время', 'Кто', 'Действие', 'Детали'].map((t) => h('th', null, t)))),
    h('tbody', null, rows.map((a) => h('tr', null, h('td', { class: 'nowrap' }, fmtDateTime(a.ts)), h('td', null, a.user_name || 'система'), h('td', { class: 'mono' }, a.action), h('td', { class: 'mono muted' }, (a.details || '').slice(0, 140)))))));
}

export const adminView = {
  live: false,
  async render(state, ctx) {
    const content = await ({ tables: tablesTab, staff: staffTab, params: paramsTab, hw: hwTab, audit: auditTab }[tab])(ctx);
    return h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('h1', null, 'Настройки'),
        h('div', { class: 'seg' }, TABS.map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; ctx.rerender(); } }, l)))),
      content);
  },
};
