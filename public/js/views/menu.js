import { h, icon, formDialog, openModal, fmtDateTime, rubInput, toast } from '../ui.js';
import { get, post, patch } from '../api.js';
import { store, loadState } from '../store.js';
import { money } from '../shared/billing.js';

const REASONS = { receipt: 'Приход', writeoff: 'Списание', inventory: 'Инвентаризация', sale: 'Продажа', return: 'Возврат в чек', cancel: 'Отмена чека', refund: 'Возврат', initial: 'Начальный остаток' };

function productForm(p) {
  const cats = store.state.categories;
  if (!cats.length) return toast('Сначала создайте категорию', 'warn');
  return formDialog({
    title: p ? 'Изменить товар' : 'Новый товар', submitText: 'Сохранить',
    fields: [
      { name: 'name', label: 'Название', type: 'text', value: p?.name },
      { name: 'category_id', label: 'Категория', type: 'select', value: p?.category_id, options: cats.map((c) => ({ v: c.id, l: c.name })) },
      { name: 'price', label: 'Цена, ₽', type: 'money', value: p ? rubInput(p.price_kop) : '' },
      { name: 'track_stock', label: 'Вести складской учёт', type: 'check', value: p ? !!p.track_stock : true },
      { name: 'min_stock', label: 'Минимальный остаток (предупреждение)', type: 'int', value: p?.min_stock ?? 0 },
      ...(p ? [{ name: 'active', label: 'Показывать в продаже', type: 'check', value: !!p.active }] : [{ name: 'stock', label: 'Начальный остаток', type: 'int', value: 0 }]),
    ],
    submit: async (v) => {
      const body = { name: v.name, category_id: Number(v.category_id), price_kop: v.price, track_stock: v.track_stock, min_stock: v.min_stock };
      if (p) await patch(`/api/products/${p.id}`, { ...body, active: v.active });
      else await post('/api/products', { ...body, stock: v.stock });
      await loadState();
    },
  });
}

function stockForm(p) {
  return formDialog({
    title: `Склад · ${p.name}`, submitText: 'Записать',
    fields: [
      { type: 'note', label: `Сейчас на складе: ${p.stock}` },
      { name: 'reason', label: 'Операция', type: 'select', options: [{ v: 'receipt', l: 'Приход (+)' }, { v: 'writeoff', l: 'Списание (−)' }, { v: 'inventory', l: 'Корректировка по инвентаризации (±)' }] },
      { name: 'qty', label: 'Количество (для списания — положительное число)', type: 'int', value: 1 },
    ],
    submit: async (v) => {
      const delta = v.reason === 'writeoff' ? -Math.abs(v.qty) : v.reason === 'receipt' ? Math.abs(v.qty) : v.qty;
      await post(`/api/products/${p.id}/stock`, { delta, reason: v.reason });
      await loadState();
    },
  });
}

async function movesModal() {
  const rows = await get('/api/stock-moves?limit=200');
  openModal({ title: 'Движение товара', size: 'wide', render: () => h('div', { class: 'scroll-x' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Время', 'Товар', 'Операция', 'Кол-во', 'Кто'].map((t) => h('th', null, t)))),
    h('tbody', null, rows.map((m) => h('tr', null, h('td', { class: 'nowrap' }, fmtDateTime(m.created_at)), h('td', null, m.product_name), h('td', null, REASONS[m.reason] || m.reason),
      h('td', { class: 'num' }, `${m.delta > 0 ? '+' : ''}${m.delta}`), h('td', { class: 'muted' }, m.user_name || '')))))) });
}

export const menuView = {
  live: true,
  render(state) {
    const low = state.products.filter((p) => p.active && p.track_stock && p.stock <= p.min_stock);
    return h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('h1', null, 'Меню и склад'),
        h('div', { class: 'row right wrap' },
          h('button', { class: 'btn', onclick: movesModal }, icon('receipt'), 'Движение'),
          h('button', { class: 'btn', onclick: () => formDialog({ title: 'Новая категория', fields: [{ name: 'name', label: 'Название', type: 'text' }], submit: async (v) => { await post('/api/categories', { name: v.name }); await loadState(); } }) }, 'Категория'),
          h('button', { class: 'btn primary', onclick: () => productForm(null) }, icon('plus'), 'Товар'))),
      low.length ? h('div', { class: 'banner' }, `Заканчивается: ${low.map((p) => `${p.name} (${p.stock})`).join(', ')}`) : null,
      state.categories.map((c) => {
        const items = state.products.filter((p) => p.category_id === c.id);
        return h('div', { class: 'card scroll-x' },
          h('div', { class: 'row sp-b' }, h('h3', { style: { margin: 0 } }, c.name),
            h('button', { class: 'btn sm ghost', onclick: () => formDialog({ title: 'Переименовать категорию', fields: [{ name: 'name', label: 'Название', type: 'text', value: c.name }], submit: async (v) => { await patch(`/api/categories/${c.id}`, { name: v.name }); await loadState(); } }) }, icon('edit'))),
          items.length ? h('table', { class: 't fixed' },
            h('thead', null, h('tr', null, ['Товар', 'Цена', 'Остаток', ''].map((t, i) => h('th', { class: i === 1 || i === 2 ? 'r' : '' }, t)))),
            h('tbody', null, items.map((p) => h('tr', { style: p.active ? null : { opacity: .45 } },
              h('td', null, p.name, p.active ? null : h('span', { class: 'chip', style: { marginLeft: '8px' } }, 'скрыт')),
              h('td', { class: 'r num' }, money(p.price_kop)),
              h('td', { class: 'r num' }, p.track_stock ? h('span', { class: p.stock <= p.min_stock ? 'chip bad' : '' }, p.stock) : h('span', { class: 'muted' }, '—')),
              h('td', { class: 'r nowrap' },
                p.track_stock ? h('button', { class: 'btn sm', onclick: () => stockForm(p) }, 'Склад') : null, ' ',
                h('button', { class: 'btn sm ghost', onclick: () => productForm(p) }, icon('edit'))))))) : h('div', { class: 'empty' }, 'Пусто'));
      }));
  },
};
