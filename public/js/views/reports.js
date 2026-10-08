import { h, fmtDay } from '../ui.js';
import { get } from '../api.js';
import { money, durationHuman } from '../core/billing.js';

let preset = '7d';
let custom = { from: '', to: '' };
const PRESETS = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['7d', '7 дней'], ['30d', '30 дней'], ['month', 'Месяц'], ['custom', 'Период']];
const METHOD = { cash: 'Наличные', card: 'Карта', sbp: 'QR / СБП' };
const DAY = 86400000;

function bounds() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  switch (preset) {
    case 'today': return [today, today + DAY];
    case 'yesterday': return [today - DAY, today];
    case '30d': return [today - 29 * DAY, today + DAY];
    case 'month': return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), today + DAY];
    case 'custom': {
      const f = custom.from ? new Date(custom.from + 'T00:00:00').getTime() : today - 6 * DAY;
      const t = custom.to ? new Date(custom.to + 'T00:00:00').getTime() + DAY : today + DAY;
      return [f, Math.max(t, f + DAY)];
    }
    default: return [today - 6 * DAY, today + DAY];
  }
}

const share = (v, max) => h('div', { class: 'hbar' }, h('i', { style: { width: `${max && v > 0 ? Math.max(2, (v / max) * 100) : 0}%` } }));

function listCard(title, rows, cols) {
  return h('div', { class: 'card scroll-x' }, h('h3', null, title),
    rows.length ? h('table', { class: 't' }, h('tbody', null, rows.map((r) => h('tr', null, cols(r).map((c, i) => h('td', { class: i ? 'r num' : '' }, c)))))) : h('div', { class: 'empty' }, 'Нет данных'));
}

export const reportsView = {
  live: false,
  async render(state, ctx) {
    const [from, to] = bounds();
    const r = await get(`/api/reports?from=${from}&to=${to}&tz=${-new Date().getTimezoneOffset()}`);
    const maxDay = Math.max(1, ...r.by_day.map((d) => d.sum_kop));
    const maxTable = Math.max(1, ...r.by_table.map((t) => t.sum_kop));
    const maxCat = Math.max(1, ...r.by_category.map((t) => t.sum_kop));
    const totalSec = r.by_table.reduce((s, t) => s + t.seconds, 0);
    const avg = r.checks_count ? Math.round(r.total_kop / r.checks_count / 100) * 100 : 0;
    return h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('h1', null, 'Отчёты'),
        h('div', { class: 'seg' }, PRESETS.map(([k, l]) => h('button', { class: preset === k ? 'on' : '', onclick: () => { preset = k; ctx.rerender(); } }, l))),
        preset === 'custom' ? h('div', { class: 'row' },
          h('input', { type: 'date', value: custom.from, style: { width: '160px' }, onchange: (e) => { custom.from = e.target.value; ctx.rerender(); } }),
          h('span', { class: 'muted' }, '—'),
          h('input', { type: 'date', value: custom.to, style: { width: '160px' }, onchange: (e) => { custom.to = e.target.value; ctx.rerender(); } })) : null),
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Выручка'), h('div', { class: 'v num' }, money(r.total_kop)), h('div', { class: 's' }, 'по оплатам, за вычетом возвратов')),
        h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Игра'), h('div', { class: 'v num' }, money(r.time_kop)), h('div', { class: 's' }, `наиграно ${durationHuman(totalSec)}`)),
        h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Бар'), h('div', { class: 'v num' }, money(r.items_kop)), h('div', { class: 's' }, 'снеки и напитки')),
        h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Чеков'), h('div', { class: 'v num' }, r.checks_count), h('div', { class: 's' }, `средний ${money(avg)}${r.discounts_kop ? ` · скидки ${money(r.discounts_kop)}` : ''}`))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('h3', null, 'Способы оплаты'),
          ['cash', 'card', 'sbp'].map((k) => h('div', { style: { marginBottom: '12px' } }, h('div', { class: 'sumrow' }, METHOD[k], h('b', { class: 'num' }, money(r.by_method[k]))), share(r.by_method[k], Math.max(1, r.total_kop))))),
        h('div', { class: 'card' }, h('h3', null, 'Выручка по дням'),
          r.by_day.length ? h('div', { class: 'bars' }, r.by_day.map((d) => {
            const [, mm, dd] = d.day.split('-');
            return h('div', { class: 'bar', title: money(d.sum_kop) }, h('b', { class: 'num' }, money(d.sum_kop).replace(' ₽', '')), h('i', { style: { height: `${Math.max(2, (d.sum_kop / maxDay) * 100)}px` } }), h('span', null, `${dd}.${mm}`));
          })) : h('div', { class: 'empty' }, 'Нет данных'))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card scroll-x' }, h('h3', null, 'Столы'),
          r.by_table.length ? h('table', { class: 't' }, h('thead', null, h('tr', null, ['Стол', 'Время', 'Сумма'].map((t, i) => h('th', { class: i ? 'r' : '' }, t)))),
            h('tbody', null, r.by_table.map((t) => h('tr', null, h('td', null, t.name, share(t.sum_kop, maxTable)), h('td', { class: 'r num nowrap' }, durationHuman(t.seconds)), h('td', { class: 'r num' }, money(t.sum_kop)))))) : h('div', { class: 'empty' }, 'Нет данных')),
        h('div', { class: 'card scroll-x' }, h('h3', null, 'Бар по категориям'),
          r.by_category.length ? h('table', { class: 't' }, h('tbody', null, r.by_category.map((c) => h('tr', null, h('td', null, c.name, share(c.sum_kop, maxCat)), h('td', { class: 'r num muted' }, `${c.qty} шт`), h('td', { class: 'r num' }, money(c.sum_kop)))))) : h('div', { class: 'empty' }, 'Нет данных'))),
      h('div', { class: 'grid-2' },
        listCard('Топ товаров', r.top_products, (p) => [p.name, `${p.qty} шт`, money(p.sum_kop)]),
        h('div', { class: 'card scroll-x' }, h('h3', null, 'Сотрудники'),
          r.staff.length ? h('table', { class: 't' }, h('thead', null, h('tr', null, ['Сотрудник', 'Смен', 'Часов', 'Выручка'].map((t, i) => h('th', { class: i ? 'r' : '' }, t)))),
            h('tbody', null, r.staff.map((s) => h('tr', null, h('td', null, s.name), h('td', { class: 'r num' }, s.shifts), h('td', { class: 'r num nowrap' }, durationHuman(s.seconds)), h('td', { class: 'r num' }, money(s.revenue_kop)))))) : h('div', { class: 'empty' }, 'Нет смен за период'))));
  },
};
