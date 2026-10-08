import { h, openModal, formDialog, fmtDateTime, closeAllModals, toast } from '../ui.js';
import { get, post } from '../api.js';
import { store, loadState, isAdmin, liveTotals } from '../store.js';
import { money, durationHuman } from '../core/billing.js';
import { openTableModal, openCheckPayment } from './tables.js';

const METHOD = { cash: 'Наличные', card: 'Карта', sbp: 'QR / СБП' };
const STATUS = { open: ['Открыт', 'warn'], paid: ['Оплачен', 'ok'], void: ['Отменён', 'bad'] };

let period = '7d';
let statusFilter = 'all';

const PERIODS = { today: 'Сегодня', '7d': '7 дней', '30d': '30 дней' };
function range() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = 86400000;
  const from = period === 'today' ? d.getTime() : period === '7d' ? d.getTime() - 6 * day : d.getTime() - 29 * day;
  return `?from=${from}`;
}

export const checksView = {
  live: true,
  async render(state, ctx) {
    const all = await get('/api/checks' + (isAdmin() ? range() : ''));
    const rows = all.filter((c) => statusFilter === 'all' || c.status === statusFilter);
    return h('div', null,
      h('div', { class: 'page-head' }, h('h1', null, 'Чеки'),
        h('div', { class: 'seg' }, [['all', 'Все'], ['open', 'Открытые'], ['paid', 'Оплаченные'], ['void', 'Отменённые']].map(([k, l]) => h('button', { class: statusFilter === k ? 'on' : '', onclick: () => { statusFilter = k; ctx.rerender(); } }, l))),
        isAdmin() ? h('div', { class: 'seg' }, Object.entries(PERIODS).map(([k, l]) => h('button', { class: period === k ? 'on' : '', onclick: () => { period = k; ctx.rerender(); } }, l))) : h('span', { class: 'muted' }, 'За текущую смену')),
      h('div', { class: 'card scroll-x' }, rows.length ? h('table', { class: 't' },
        h('thead', null, h('tr', null, ['№', 'Время', 'Стол / тип', 'Статус', 'Оплата', 'Сумма'].map((t, i) => h('th', { class: i === 5 ? 'r' : '' }, t)))),
        h('tbody', null, rows.map((c) => {
          const [label, kind] = STATUS[c.status];
          const methods = [...new Set(c.payments.filter((p) => p.amount_kop > 0).map((p) => METHOD[p.method]))].join(', ');
          return h('tr', { class: 'click', onclick: () => openCheckModal(c.id) },
            h('td', { class: 'num' }, c.id), h('td', { class: 'nowrap' }, fmtDateTime(c.created_at)),
            h('td', null, c.table_name || 'Бар'), h('td', null, h('span', { class: `chip ${kind}` }, label)),
            h('td', { class: 'muted' }, methods || '—'),
            h('td', { class: 'r num' }, money(c.status === 'open' ? liveTotals(c).total_kop : c.total_kop)));
        }))) : h('div', { class: 'empty' }, 'Чеков нет')));
  },
};

export function openCheckModal(id) {
  let data = null;
  const m = openModal({
    title: `Чек №${id}`,
    size: 'wide',
    render: () => data ? body(data) : h('div', { class: 'empty' }, 'Загрузка…'),
    footer: () => (data ? footer(data, m) : []),
  });
  get(`/api/checks/${id}`).then((d) => { data = d; m.rerender(); }).catch((e) => toast(e.message, 'err'));
}

function body(c) {
  const [label, kind] = STATUS[c.status];
  return h('div', { class: 'stack' },
    h('div', { class: 'row wrap' }, h('span', { class: `chip ${kind}` }, label), h('span', { class: 'muted' }, c.table_name ? `${c.table_name}` : 'Бар'),
      h('span', { class: 'muted' }, `создан ${fmtDateTime(c.created_at)} · ${c.created_by_name || ''}`),
      c.closed_at ? h('span', { class: 'muted' }, `закрыт ${fmtDateTime(c.closed_at)} · ${c.closed_by_name || ''}`) : null),
    c.status === 'void' ? h('div', { class: 'banner' }, `Причина: ${c.void_reason}`) : null,
    h('div', { class: 'lines' }, c.lines.map((l) => h('div', { class: 'line' }, h('div', { class: 'n' }, l.name), l.qty > 1 ? h('span', { class: 'muted' }, `× ${l.qty}`) : null, h('div', { class: 'p num' }, money(l.price_kop * l.qty))))),
    c.discount_kop ? h('div', { class: 'sumrow' }, h('span', null, 'Скидка', c.discount_note ? h('span', { class: 'muted' }, ` · ${c.discount_note}`) : null), `− ${money(c.discount_kop)}`) : null,
    h('div', { class: 'sumrow big' }, 'Итого', money(c.status === 'open' ? c.total_kop : c.total_kop ?? 0)),
    c.payments.length ? h('div', null, h('h3', { class: 'muted', style: { fontSize: '13px', textTransform: 'uppercase', letterSpacing: '.1em', margin: '6px 0' } }, 'Платежи'),
      c.payments.map((p) => h('div', { class: 'sumrow' }, h('span', null, METHOD[p.method], h('span', { class: 'muted' }, ` · ${fmtDateTime(p.created_at)}`)), h('span', { style: p.amount_kop < 0 ? { color: 'var(--danger)' } : null }, money(p.amount_kop))))) : null);
}

function footer(c, m) {
  const btns = [];
  if (c.status === 'open') {
    if (c.table_id) btns.push(h('button', { class: 'btn primary', onclick: () => { closeAllModals(); openTableModal(c.table_id); } }, 'Открыть стол'));
    else btns.push(h('button', { class: 'btn primary', onclick: () => { closeAllModals(); openCheckPayment(c.id); } }, 'Оплатить'));
  }
  if (c.status === 'paid' && isAdmin()) {
    btns.push(h('button', { class: 'btn danger', onclick: async () => {
      const ok = await formDialog({
        title: `Возврат по чеку №${c.id}`, danger: true, submitText: 'Оформить возврат',
        fields: [{ type: 'note', label: `Будет возвращено ${money(c.total_kop)} теми же способами, товар вернётся на склад. Возврат учитывается в текущей смене.` }, { name: 'reason', label: 'Причина', type: 'text' }],
        submit: (v) => post(`/api/checks/${c.id}/void`, { reason: v.reason }),
      });
      if (ok) { m.close(); toast('Возврат оформлен'); await loadState(); }
    } }, 'Возврат'));
  }
  return btns;
}
