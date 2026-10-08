import { h, icon, toast } from '../ui.js';
import { post } from '../api.js';
import { store, loadState, productById } from '../store.js';
import { money } from '../shared/billing.js';
import { openPayDialog } from './pay.js';

const cart = new Map(); // product_id → qty
let category = 'all';

const cartLines = () => [...cart.entries()].map(([id, qty]) => ({ p: productById(id), qty })).filter((l) => l.p);
const cartTotal = () => cartLines().reduce((s, l) => s + l.p.price_kop * l.qty, 0);

function add(p, delta) {
  const cur = cart.get(p.id) || 0;
  const next = cur + delta;
  if (next <= 0) cart.delete(p.id);
  else if (p.track_stock && next > p.stock) return toast(`На складе только ${p.stock}`, 'warn') ?? store.onChange();
  else cart.set(p.id, Math.min(next, 99));
  store.onChange();
}

function pay() {
  const lines = cartLines();
  const total = cartTotal();
  openPayDialog({
    title: 'Оплата · бар',
    subtotalKop: total,
    summary: h('div', { class: 'lines' }, lines.map((l) => h('div', { class: 'line' }, h('div', { class: 'n' }, l.p.name), h('span', { class: 'muted' }, `× ${l.qty}`), h('div', { class: 'p num' }, money(l.p.price_kop * l.qty))))),
    onPay: async (payload) => {
      await post('/api/sales', { lines: lines.map((l) => ({ product_id: l.p.id, qty: l.qty })), ...payload });
      cart.clear();
      toast('Продажа оформлена');
      await loadState();
    },
  });
}

export const barView = {
  live: true,
  render(state) {
    const cats = state.categories.filter((c) => state.products.some((p) => p.category_id === c.id && p.active));
    if (category !== 'all' && !cats.some((c) => c.id === category)) category = 'all';
    const prods = state.products.filter((p) => p.active && (category === 'all' || p.category_id === category));
    const lines = cartLines();
    return h('div', null,
      h('div', { class: 'page-head' }, h('h1', null, 'Бар'),
        h('div', { class: 'seg' }, [{ id: 'all', name: 'Всё' }, ...cats].map((c) => h('button', { class: c.id === category ? 'on' : '', onclick: () => { category = c.id; store.onChange(); } }, c.name)))),
      !state.shift ? h('div', { class: 'banner' }, 'Смена не открыта — продажи недоступны.', h('a', { class: 'btn sm primary', href: '#/shift' }, 'Открыть смену')) : null,
      h('div', { class: 'pos' },
        h('div', { class: 'products' }, prods.map((p) => {
          const out = p.track_stock && p.stock <= 0;
          const inCart = cart.get(p.id);
          return h('button', { class: 'prod', disabled: out, style: inCart ? { borderColor: 'var(--brass)' } : null, onclick: () => add(p, 1) },
            h('span', { class: 'pn' }, p.name), h('span', { class: 'pp' }, money(p.price_kop)),
            p.track_stock ? h('span', { class: `ps ${p.stock <= p.min_stock ? 'low' : ''}` }, out ? 'нет в наличии' : `остаток ${p.stock}`) : h('span', { class: 'ps' }, ' '));
        })),
        h('div', { class: 'card cart' },
          h('h3', null, 'Корзина'),
          lines.length ? h('div', { class: 'lines' }, lines.map((l) => h('div', { class: 'line' },
            h('div', { class: 'n' }, l.p.name),
            h('div', { class: 'q' }, h('button', { class: 'btn', onclick: () => add(l.p, -1) }, icon('minus')), h('b', { class: 'num' }, l.qty), h('button', { class: 'btn', onclick: () => add(l.p, 1) }, icon('plus'))),
            h('div', { class: 'p num' }, money(l.p.price_kop * l.qty)))))
            : h('div', { class: 'empty' }, 'Выберите товары слева'),
          h('div', { class: 'sumrow big' }, 'Итого', money(cartTotal())),
          h('div', { class: 'row', style: { marginTop: '14px' } },
            h('button', { class: 'btn', disabled: !lines.length, onclick: () => { cart.clear(); store.onChange(); } }, 'Очистить'),
            h('button', { class: 'btn primary lg grow', disabled: !lines.length || !state.shift, onclick: pay }, icon('cash'), 'Оплатить')))));
  },
};
