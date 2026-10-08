import { h, icon, openModal, parseMoney, rubInput, toast } from '../ui.js';
import { money } from '../shared/billing.js';
import { store } from '../store.js';

const METHODS = [
  { key: 'cash', label: 'Наличные', icon: 'cash' },
  { key: 'card', label: 'Карта', icon: 'card' },
  { key: 'sbp', label: 'QR / СБП', icon: 'qr' },
];

/**
 * Диалог оплаты: скидка, один или несколько способов оплаты, QR СБП, сдача.
 * onPay({ payments, discount_kop, discount_note }) — async; при ошибке окно остаётся открытым.
 */
export function openPayDialog({ title = 'Оплата', subtotalKop, summary, onPay }) {
  const { settings, user } = store.state;
  const isAdmin = user.role === 'admin';
  const maxDiscount = isAdmin ? subtotalKop : Math.floor((subtotalKop * settings.max_discount_pct) / 100);

  let discount = 0;
  let method = null;
  let split = false;
  let busy = false;
  const amt = { cash: 0, card: 0, sbp: 0 };
  const total = () => subtotalKop - discount;

  const totalEl = h('div', { class: 'num' });
  const remainEl = h('div', { class: 'muted' });
  const errEl = h('div', { class: 'err', style: { minHeight: 0 } });
  const payBtn = h('button', { class: 'btn primary lg', onclick: submit });

  const tiles = METHODS.map((m) => h('button', { class: 'method', onclick: () => { split = false; method = m.key; update(); } }, icon(m.icon), m.label));
  const splitInputs = METHODS.map((m) => {
    const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', oninput: update });
    const fill = h('button', { class: 'btn sm', title: 'Остаток', onclick: () => { input.value = rubInput(Math.max(0, total() - others(m.key))); update(); } }, 'Остаток');
    return { key: m.key, input, row: h('div', { class: 'row' }, h('div', { style: { width: '110px' } }, m.label), h('div', { class: 'grow' }, input), fill) };
  });
  const others = (key) => splitInputs.filter((s) => s.key !== key).reduce((a, s) => a + (parseMoney(s.input.value) || 0), 0);
  const splitBox = h('div', { class: 'stack' }, splitInputs.map((s) => s.row));
  const splitLink = h('button', { class: 'btn ghost sm', onclick: () => {
    split = !split;
    if (split) for (const s of splitInputs) s.input.value = method === s.key ? rubInput(total()) : '';
    update();
  } });

  const discInput = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', autocomplete: 'off', oninput: () => {
    const v = parseMoney(discInput.value || '0');
    discount = Number.isNaN(v) ? 0 : Math.min(Math.max(v, 0), subtotalKop);
    update();
  } });
  const discNote = h('input', { type: 'text', placeholder: 'Причина скидки', maxlength: 200 });
  const discWarn = h('div', { class: 'hint err', style: { textAlign: 'left', minHeight: 0 } });
  const pctBtns = [5, 10, 15, 20].map((p) => h('button', { class: 'btn sm', onclick: () => {
    discInput.value = rubInput(Math.round((subtotalKop * p) / 100 / 100) * 100);
    discInput.dispatchEvent(new Event('input'));
  } }, `${p}%`));
  const discBox = h('div', { class: 'stack hidden' },
    h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: { minWidth: '120px' } }, discInput), pctBtns, h('span', { class: 'muted' }, '₽ / %')),
    discNote, discWarn);
  const discToggle = h('button', { class: 'btn ghost sm', onclick: () => discBox.classList.toggle('hidden') }, 'Скидка');

  const givenInput = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Получено наличными', autocomplete: 'off', oninput: update });
  const changeEl = h('div', { class: 'muted' });
  const cashBox = h('div', { class: 'row hidden' }, h('div', { class: 'grow' }, givenInput), changeEl);

  const qrBox = h('div', { class: 'qrbox hidden' });

  function update() {
    for (const k of Object.keys(amt)) amt[k] = 0;
    if (split) for (const s of splitInputs) amt[s.key] = Math.max(0, parseMoney(s.input.value) || 0);
    else if (method) amt[method] = total();
    const sum = amt.cash + amt.card + amt.sbp;
    const rest = total() - sum;
    tiles.forEach((t, i) => t.classList.toggle('on', !split && method === METHODS[i].key));
    splitBox.classList.toggle('hidden', !split);
    splitLink.textContent = split ? 'Одним способом' : 'Разделить оплату';
    remainEl.textContent = split ? (rest === 0 ? 'Сумма сходится' : rest > 0 ? `Осталось распределить: ${money(rest)}` : `Лишнее: ${money(-rest)}`) : '';
    totalEl.innerHTML = '';
    totalEl.append(h('div', { class: 'sumrow' }, 'Сумма чека', money(subtotalKop)));
    if (discount) totalEl.append(h('div', { class: 'sumrow' }, 'Скидка', `− ${money(discount)}`));
    totalEl.append(h('div', { class: 'sumrow big' }, 'К оплате', money(total())));

    discWarn.textContent = discount > maxDiscount ? `Максимум для вашей роли — ${money(maxDiscount)}${isAdmin ? '' : ` (${settings.max_discount_pct}%)`}` : '';
    const needSplit = total() > 0;
    for (const t of tiles) t.parentElement?.classList.toggle('hidden', !needSplit);
    splitLink.classList.toggle('hidden', !needSplit);

    cashBox.classList.toggle('hidden', amt.cash === 0);
    const given = parseMoney(givenInput.value);
    changeEl.textContent = !Number.isNaN(given) && given >= amt.cash && amt.cash > 0 ? `Сдача: ${money(given - amt.cash)}` : '';

    qrBox.classList.toggle('hidden', amt.sbp === 0);
    if (amt.sbp > 0) {
      qrBox.replaceChildren(...[
        settings.sbp_qr ? h('img', { src: settings.sbp_qr, alt: 'QR СБП' }) : h('div', { style: { padding: '16px', textAlign: 'center' } }, 'QR не загружен — администратор добавит его в настройках. Подтвердите перевод по реквизитам клуба.'),
        h('div', { style: { fontWeight: 700, fontSize: '22px' } }, money(amt.sbp)),
        settings.sbp_note ? h('div', null, settings.sbp_note) : null,
        h('div', { style: { fontSize: '13px', color: '#555' } }, 'Нажмите «Принять оплату» только после поступления перевода')].filter(Boolean));
    }

    const valid = discount <= maxDiscount && (total() === 0 || (sum === total() && sum > 0));
    payBtn.disabled = busy || !valid;
    payBtn.textContent = total() === 0 ? 'Закрыть чек' : `Принять оплату ${money(total())}`;
  }

  async function submit() {
    busy = true;
    update();
    errEl.textContent = '';
    try {
      await onPay({
        payments: METHODS.filter((m) => amt[m.key] > 0).map((m) => ({ method: m.key, amount_kop: amt[m.key] })),
        discount_kop: discount,
        discount_note: discount ? discNote.value : '',
      });
      modal.close();
    } catch (e) {
      errEl.textContent = e.message;
      toast(e.message, 'err');
      busy = false;
      update();
    }
  }

  const modal = openModal({
    title,
    size: 'wide',
    render: () => h('div', { class: 'grid-2', style: { gap: '22px' } },
      h('div', { class: 'stack' }, summary, totalEl, h('div', { class: 'row' }, discToggle), discBox),
      h('div', { class: 'stack' },
        h('div', { class: 'methods' }, tiles),
        h('div', { class: 'row sp-b' }, remainEl, splitLink),
        splitBox, cashBox, qrBox, errEl)),
    footer: (m) => [h('button', { class: 'btn', onclick: () => m.close() }, 'Назад'), payBtn],
  });
  if (subtotalKop > 0) { method = 'cash'; }
  update();
  return modal;
}
