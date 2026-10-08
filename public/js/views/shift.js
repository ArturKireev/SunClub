import { h, icon, formDialog, openModal, confirmDialog, fmtDateTime, fmtTime, rubInput, toast } from '../ui.js';
import { get, post } from '../api.js';
import { store, act, loadState, isAdmin, now } from '../store.js';
import { downloadBackup } from '../backup.js';
import { getLocal } from '../api.js';
import { money, durationHuman } from '../core/billing.js';

const METHOD = { cash: 'Наличные', card: 'Карта', sbp: 'QR / СБП' };

function methodRows(s) {
  return ['cash', 'card', 'sbp'].map((k) => h('div', { class: 'sumrow' }, METHOD[k], h('b', { class: 'num' }, money(s.by_method[k]))));
}

export function shiftDetails(s) {
  const diff = s.closed_at ? s.counted_cash_kop - s.expected_cash_kop : null;
  return h('div', { class: 'stack' },
    h('div', { class: 'row wrap' }, h('span', { class: `chip ${s.closed_at ? '' : 'ok'}` }, s.closed_at ? 'Закрыта' : 'Открыта'),
      h('span', { class: 'muted' }, `${s.user_name} · ${fmtDateTime(s.opened_at)} — ${s.closed_at ? fmtDateTime(s.closed_at) : 'сейчас'} · ${durationHuman(((s.closed_at ?? now()) - s.opened_at) / 1000)}`)),
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Выручка'), h('div', { class: 'v num' }, money(s.total_kop)), h('div', { class: 's' }, `чеков: ${s.checks_count}${s.refunds_kop ? ` · возвраты ${money(s.refunds_kop)}` : ''}`)),
      h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Наличных в кассе'), h('div', { class: 'v num' }, money(s.expected_cash_kop)), h('div', { class: 's' }, `на начало ${money(s.opening_cash_kop)}`))),
    h('div', { class: 'card' }, h('h3', null, 'По способам оплаты'), methodRows(s)),
    s.cash_ops.length ? h('div', { class: 'card' }, h('h3', null, 'Внесения и изъятия'), s.cash_ops.map((o) => h('div', { class: 'sumrow' }, h('span', null, `${fmtTime(o.created_at)} · ${o.note}`, h('span', { class: 'muted' }, ` · ${o.user_name}`)), h('b', { class: 'num', style: o.amount_kop < 0 ? { color: 'var(--danger)' } : null }, money(o.amount_kop))))) : null,
    s.closed_at ? h('div', { class: 'card' }, h('h3', null, 'Итог по кассе'),
      h('div', { class: 'sumrow' }, 'Ожидалось', money(s.expected_cash_kop)), h('div', { class: 'sumrow' }, 'Пересчитано', money(s.counted_cash_kop)),
      h('div', { class: 'sumrow big', style: { color: diff === 0 ? 'var(--ok)' : 'var(--danger)' } }, diff === 0 ? 'Сходится' : diff < 0 ? 'Недостача' : 'Излишек', diff === 0 ? '' : money(Math.abs(diff))),
      s.note ? h('div', { class: 'muted' }, s.note) : null) : null);
}

function openShift() {
  return formDialog({
    title: 'Открыть смену', submitText: 'Открыть смену',
    fields: [
      { name: 'cash', label: 'Наличных в кассе на начало смены, ₽', type: 'money', value: rubInput(store.state.last_closing_cash_kop), hint: 'По умолчанию — остаток после прошлой смены. Пересчитайте и исправьте при расхождении.' },
    ],
    submit: async (v) => { await post('/api/shifts/open', { opening_cash_kop: v.cash }); toast('Смена открыта'); await loadState(); },
  });
}

async function closeShift() {
  const { shift } = store.state;
  let force = false;
  if (store.state.checks.length) {
    const ok = await confirmDialog(`Есть неоплаченные чеки: ${store.state.checks.length}. Они останутся открытыми и перейдут в следующую смену. Закрыть смену?`, { okText: 'Всё равно закрыть', danger: true });
    if (!ok) return;
    force = true;
  }
  let summary = null;
  const ok = await formDialog({
    title: 'Закрыть смену', submitText: 'Закрыть смену', size: '',
    fields: [
      { type: 'note', label: `По данным программы в кассе должно быть ${money(shift.expected_cash_kop)} наличными.` },
      { name: 'counted', label: 'Пересчитано наличных, ₽', type: 'money' },
      { name: 'note', label: 'Комментарий', type: 'text', placeholder: 'Необязательно' },
    ],
    submit: async (v) => { summary = await post('/api/shifts/close', { counted_cash_kop: v.counted, note: v.note, force }); },
  });
  if (ok) {
    await loadState();
    downloadBackup();
    getLocal()?.sync.flush().catch(() => {});
    openModal({ title: 'Смена закрыта', size: 'wide', render: () => shiftDetails(summary) });
  }
}

function cashOp(sign) {
  return formDialog({
    title: sign > 0 ? 'Внесение в кассу' : 'Изъятие из кассы', submitText: 'Записать',
    fields: [
      { name: 'amount', label: 'Сумма, ₽', type: 'money' },
      { name: 'note', label: 'Комментарий', type: 'text', placeholder: sign > 0 ? 'Например: размен' : 'Например: инкассация, закупка воды' },
    ],
    submit: async (v) => { await post('/api/cash-ops', { amount_kop: sign * Math.abs(v.amount), note: v.note }); toast('Записано'); await loadState(); },
  });
}

export const shiftView = {
  live: true,
  async render(state) {
    const s = state.shift;
    const history = await get('/api/shifts');
    return h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('h1', null, 'Смена'), h('span', { class: 'chip' }, `План: ${state.settings.shift_start}–${state.settings.shift_end}`)),
      s ? h('div', { class: 'stack' },
        shiftDetails(s),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn', onclick: () => cashOp(1) }, icon('plus'), 'Внесение'),
          h('button', { class: 'btn', onclick: () => cashOp(-1) }, icon('minus'), 'Изъятие'),
          h('button', { class: 'btn danger', onclick: closeShift }, 'Закрыть смену')))
        : h('div', { class: 'card center', style: { padding: '36px' } },
          h('div', { class: 'serif', style: { fontSize: '26px', marginBottom: '8px' } }, 'Смена не открыта'),
          h('p', { class: 'muted' }, 'Откройте смену, чтобы запускать столы и продавать в баре.'),
          h('button', { class: 'btn primary lg', onclick: openShift }, 'Открыть смену')),
      h('div', { class: 'card scroll-x' }, h('h3', null, isAdmin() ? 'История смен' : 'Мои смены'),
        history.length ? h('table', { class: 't' },
          h('thead', null, h('tr', null, ['Сотрудник', 'Начало', 'Длительность', 'Выручка', 'Касса'].map((t, i) => h('th', { class: i >= 3 ? 'r' : '' }, t)))),
          h('tbody', null, history.map((x) => {
            const diff = x.closed_at ? x.counted_cash_kop - x.expected_cash_kop : null;
            return h('tr', { class: 'click', onclick: () => openModal({ title: `Смена №${x.id}`, size: 'wide', render: () => shiftDetails(x) }) },
              h('td', null, x.user_name), h('td', { class: 'nowrap' }, fmtDateTime(x.opened_at)),
              h('td', null, x.closed_at ? durationHuman((x.closed_at - x.opened_at) / 1000) : h('span', { class: 'chip ok' }, 'идёт')),
              h('td', { class: 'r num' }, money(x.total_kop)),
              h('td', { class: 'r num' }, diff == null ? '—' : diff === 0 ? h('span', { class: 'chip ok' }, 'сходится') : h('span', { class: 'chip bad' }, `${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`)));
          }))) : h('div', { class: 'empty' }, 'Смен пока нет')));
  },
};
