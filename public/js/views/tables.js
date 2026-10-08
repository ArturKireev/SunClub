import { h, icon, openModal, closeAllModals, formDialog, toast } from '../ui.js';
import { post, patch } from '../api.js';
import { store, act, loadState, tableCheck, liveSessionOf, liveTotals, isAdmin } from '../store.js';
import { money, duration } from '../core/billing.js';
import { openPayDialog } from './pay.js';

const KINDS = { pool: 'Пул', pyramid: 'Пирамида', snooker: 'Снукер', carom: 'Карамболь' };
export const kindLabel = (k) => KINDS[k] || k;

function status(table, check) {
  if (!check) return 'free';
  const s = liveSessionOf(check);
  if (!s) return 'pay';
  return s.status === 'active' ? 'playing' : 'paused';
}

const STATUS_TEXT = { free: 'Свободен', playing: 'Идёт игра', paused: 'Пауза', pay: 'Ожидает оплаты' };

function felt() {
  const el = h('div', { class: 'felt' });
  [[24, 40], [34, 52], [58, 30], [70, 62]].forEach(([x, y]) => el.append(h('i', { class: 'ball', style: { left: `${x}%`, top: `${y}%` } })));
  return el;
}

function tableCard(table) {
  const check = tableCheck(table.id);
  const st = status(table, check);
  const s = check && liveSessionOf(check);
  return h('button', { class: `tcard ${st} ${table.kind} ${table.active ? '' : 'off'}`, onclick: () => table.active && openTableModal(table.id) },
    felt(),
    h('div', { class: 'head' },
      h('div', null, h('div', { class: 'name' }, table.name), h('div', { class: 'kind' }, `${kindLabel(table.kind)} · ${money(table.rate_kop)}/ч`)),
      h('span', { class: 'bulb', title: table.lamp_on ? 'Лампа включена' : 'Лампа выключена' }, icon('bulb'))),
    h('div', { class: 'meta' },
      st === 'free'
        ? h('span', { class: 'status' }, table.active ? STATUS_TEXT.free : 'Отключён')
        : [
          s ? h('div', null, h('div', { class: 'timer num', 'data-live': 'timer', 'data-sid': s.id }, '0:00:00'), h('div', { class: 'status' }, STATUS_TEXT[st]))
            : h('div', null, h('div', { class: 'timer', style: { fontSize: '22px' } }, 'Игра окончена'), h('div', { class: 'status' }, STATUS_TEXT.pay)),
          h('div', { class: 'amount num', 'data-live': 'total', 'data-cid': check.id }, money(liveTotals(check).total_kop)),
        ]));
}

export const tablesView = {
  live: true,
  render(state) {
    const counts = { free: 0, playing: 0, paused: 0, pay: 0 };
    for (const t of state.tables.filter((x) => x.active)) counts[status(t, tableCheck(t.id))]++;
    return h('div', null,
      h('div', { class: 'page-head' }, h('h1', null, 'Столы'),
        h('div', { class: 'legend' },
          h('span', null, h('i', { style: { background: 'var(--lamp)' } }), `Играют: ${counts.playing}`),
          h('span', null, h('i', { style: { background: '#8a7d67' } }), `Пауза: ${counts.paused}`),
          h('span', null, h('i', { style: { background: 'var(--danger)' } }), `К оплате: ${counts.pay}`),
          h('span', null, h('i', { style: { background: 'var(--felt)' } }), `Свободно: ${counts.free}`))),
      !state.shift ? h('div', { class: 'banner' }, 'Смена не открыта — столы и бар недоступны.', h('a', { class: 'btn sm primary', href: '#/shift' }, 'Открыть смену')) : null,
      h('div', { class: 'tables' }, state.tables.filter((t) => t.active || isAdmin()).map(tableCard)));
  },
};

// ---------- карточка стола ----------

let pickCategory = null;

export function openTableModal(tableId) {
  openModal({
    title: () => store.state.tables.find((t) => t.id === tableId)?.name ?? 'Стол',
    live: true,
    size: 'wide',
    render: () => tableBody(tableId),
    footer: () => tableFooter(tableId),
  });
}

function itemPicker(check) {
  const { products, categories } = store.state;
  const cats = categories.filter((c) => products.some((p) => p.category_id === c.id && p.active));
  if (!cats.some((c) => c.id === pickCategory)) pickCategory = cats[0]?.id ?? null;
  return h('div', { class: 'stack' },
    h('div', { class: 'row wrap sp-b' }, h('h3', { class: 'muted', style: { fontSize: '13px', letterSpacing: '.1em', textTransform: 'uppercase' } }, 'Добавить в чек'),
      h('div', { class: 'seg' }, cats.map((c) => h('button', { class: c.id === pickCategory ? 'on' : '', onclick: () => { pickCategory = c.id; store.onChange(); } }, c.name)))),
    h('div', { class: 'products' }, products.filter((p) => p.active && p.category_id === pickCategory).map((p) => {
      const out = p.track_stock && p.stock <= 0;
      return h('button', { class: 'prod', disabled: out, onclick: () => act(() => post(`/api/checks/${check.id}/lines`, { product_id: p.id, qty: 1 })) },
        h('span', { class: 'pn' }, p.name), h('span', { class: 'pp' }, money(p.price_kop)),
        p.track_stock ? h('span', { class: `ps ${p.stock <= p.min_stock ? 'low' : ''}` }, out ? 'нет в наличии' : `остаток ${p.stock}`) : null);
    })));
}

function lineRow(check, l) {
  const editable = l.kind === 'item' && check.status === 'open';
  return h('div', { class: 'line' },
    h('div', { class: 'n' }, l.name),
    editable
      ? h('div', { class: 'q' },
        h('button', { class: 'btn', onclick: () => act(() => patch(`/api/lines/${l.id}`, { qty: l.qty - 1 })) }, icon('minus')),
        h('b', { class: 'num' }, l.qty),
        h('button', { class: 'btn', onclick: () => act(() => patch(`/api/lines/${l.id}`, { qty: l.qty + 1 })) }, icon('plus')))
      : (l.qty > 1 ? h('span', { class: 'muted' }, `× ${l.qty}`) : null),
    h('div', { class: 'p num' }, money(l.price_kop * l.qty)));
}

function tableBody(tableId) {
  const { state } = store;
  const table = state.tables.find((t) => t.id === tableId);
  const check = tableCheck(tableId);
  if (!table) return h('div', { class: 'empty' }, 'Стол не найден');
  if (!check) {
    return h('div', { class: 'stack' },
      h('div', { class: 'hero idle' }, h('div', null, h('div', { class: 'muted' }, kindLabel(table.kind)), h('div', { class: 'serif', style: { fontSize: '30px' } }, 'Стол свободен')),
        h('div', { class: 'right center' }, h('div', { class: 'muted' }, 'Тариф'), h('div', { class: 'serif', style: { fontSize: '26px' } }, `${money(table.rate_kop)}/час`))),
      !state.shift ? h('div', { class: 'banner' }, 'Сначала откройте смену.') : null,
      h('p', { class: 'muted', style: { margin: 0 } }, 'После запуска включится лампа над столом и начнётся отсчёт времени. Свет горит — идёт игра и начисляется оплата.'));
  }
  const s = liveSessionOf(check);
  const st = status(table, check);
  const t = liveTotals(check);
  return h('div', { class: 'stack' },
    h('div', { class: 'hero' },
      h('div', null,
        h('div', { class: 'row' }, h('span', { class: `chip ${st === 'playing' ? 'warn' : st === 'pay' ? 'bad' : ''}` }, STATUS_TEXT[st]), h('span', { class: 'muted' }, `Чек №${check.id}`)),
        s ? h('div', { class: 'bigtime num', 'data-live': 'timer', 'data-sid': s.id, style: { marginTop: '8px' } }, '0:00:00')
          : h('div', { class: 'serif', style: { fontSize: '28px', marginTop: '8px' } }, 'Игра остановлена')),
      h('div', { class: 'center' }, h('div', { class: 'muted' }, 'Итого'), h('div', { class: 'bigtime num', style: { fontSize: '40px', color: 'var(--brass)' }, 'data-live': 'total', 'data-cid': check.id }, money(t.total_kop)))),
    h('div', { class: 'lines' },
      check.lines.map((l) => lineRow(check, l)),
      s ? h('div', { class: 'line' }, h('div', { class: 'n' }, `${table.name} · идёт время`, h('span', { class: 'muted' }, ` (${money(s.rate_kop)}/ч)`)), h('div', { class: 'p num', 'data-live': 'live', 'data-cid': check.id }, money(t.live_kop))) : null,
      !check.lines.length && !s ? h('div', { class: 'empty' }, 'Чек пуст') : null),
    itemPicker(check));
}

function tableFooter(tableId) {
  const table = store.state.tables.find((t) => t.id === tableId);
  const check = tableCheck(tableId);
  const hasShift = !!store.state.shift;
  if (!table) return [];
  if (!check) return [h('button', { class: 'btn primary lg', disabled: !hasShift, onclick: () => act(() => post(`/api/tables/${tableId}/start`)) }, icon('play'), 'Начать игру')];
  const s = liveSessionOf(check);
  const btns = [];
  const cancel = h('button', { class: 'btn danger', onclick: () => cancelCheck(check) }, icon('x'), 'Отменить чек');
  btns.push(cancel);
  if (s) {
    btns.push(s.status === 'active'
      ? h('button', { class: 'btn', onclick: () => act(() => post(`/api/tables/${tableId}/pause`)) }, icon('pause'), 'Пауза')
      : h('button', { class: 'btn', onclick: () => act(() => post(`/api/tables/${tableId}/resume`)) }, icon('play'), 'Продолжить'));
    btns.push(h('button', { class: 'btn', onclick: () => moveTable(table) }, icon('swap'), 'Перенести'));
    btns.push(h('button', { class: 'btn primary lg', onclick: () => stopAndPay(check) }, icon('stop'), 'Стоп и оплата'));
  } else {
    btns.push(h('button', { class: 'btn primary lg', onclick: () => openCheckPayment(check.id) }, icon('cash'), 'Оплатить'));
  }
  return btns;
}

async function cancelCheck(check) {
  const ok = await formDialog({
    title: 'Отменить чек?', danger: true, submitText: 'Отменить чек',
    fields: [{ type: 'note', label: 'Игра остановится, товары вернутся на склад. Отмена доступна сотруднику только для пустого чека без игры (до 2 минут).' },
      { name: 'reason', label: 'Причина', type: 'text', placeholder: 'Например: включили по ошибке' }],
    submit: async (v) => {
      const r = await post(`/api/checks/${check.id}/cancel`, { reason: v.reason });
      (r.warnings || []).forEach((w) => toast(w, 'warn'));
    },
  });
  if (ok) { closeAllModals(); await loadState(); }
}

async function moveTable(table) {
  const free = store.state.tables.filter((t) => t.active && t.id !== table.id && !tableCheck(t.id));
  if (!free.length) return toast('Нет свободных столов', 'warn');
  const ok = await formDialog({
    title: `Перенести с «${table.name}»`, submitText: 'Перенести',
    fields: [
      { name: 'to', label: 'Новый стол', type: 'select', options: free.map((t) => ({ v: t.id, l: `${t.name} — ${money(t.rate_kop)}/ч` })) },
      { type: 'note', label: 'Время на текущем столе фиксируется по его тарифу, дальше идёт по тарифу нового стола.' },
    ],
    submit: async (v) => { await post(`/api/tables/${table.id}/move`, { to_table_id: Number(v.to) }); },
  });
  if (ok) { closeAllModals(); await loadState(); }
}

async function stopAndPay(check) {
  const r = await act(() => post(`/api/checks/${check.id}/stop`));
  if (r) openCheckPayment(check.id);
}

/** Диалог оплаты для открытого (уже остановленного) чека. */
export function openCheckPayment(checkId) {
  const check = store.checks.get(checkId);
  if (!check) return;
  const summary = h('div', { class: 'lines' }, check.lines.map((l) => lineRow({ ...check, status: 'paid' }, l)));
  openPayDialog({
    title: check.table_id ? `Оплата · ${store.state.tables.find((t) => t.id === check.table_id)?.name}` : 'Оплата',
    subtotalKop: check.frozen_kop,
    summary,
    onPay: async (payload) => {
      await post(`/api/checks/${checkId}/pay`, payload);
      closeAllModals();
      toast('Оплата принята');
      await loadState();
    },
  });
}
