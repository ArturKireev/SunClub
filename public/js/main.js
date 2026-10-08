import { h, icon, toast, refreshModals, closeAllModals, fmtTime } from './ui.js';
import { get, post, setUnauthorizedHandler, initBackend, getMode, subscribeChanges, startChangeFeed, stopChangeFeed } from './api.js';
import { store, loadState, now, liveTotals, liveSeconds } from './store.js';
import { money, duration } from './core/billing.js';
import { renderLogin } from './views/login.js';
import { getLocal } from './api.js';
import { STATUS_TEXT, STATUS_KIND, conflictBanner, statusModal } from './views/cloud.js';
import { tablesView } from './views/tables.js';
import { barView } from './views/bar.js';
import { checksView } from './views/checks.js';
import { shiftView } from './views/shift.js';
import { menuView } from './views/menu.js';
import { reportsView } from './views/reports.js';
import { adminView } from './views/admin.js';

const app = document.getElementById('app');

const ROUTES = {
  tables: { label: 'Столы', icon: 'table', view: tablesView },
  bar: { label: 'Бар', icon: 'bar', view: barView },
  checks: { label: 'Чеки', icon: 'receipt', view: checksView },
  shift: { label: 'Смена', icon: 'clock', view: shiftView },
  menu: { label: 'Меню и склад', icon: 'box', view: menuView, admin: true },
  reports: { label: 'Отчёты', icon: 'chart', view: reportsView, admin: true },
  admin: { label: 'Настройки', icon: 'gear', view: adminView, admin: true },
};

let shell = null;
let currentRoute = null;
let renderToken = 0;
let frame = 0;

function currentKey() {
  const k = location.hash.replace(/^#\//, '');
  const r = ROUTES[k];
  return r && (!r.admin || store.state.user.role === 'admin') ? k : 'tables';
}

// ---------- оболочка ----------

function buildShell() {
  const topbar = h('div', { class: 'topbar' });
  const nav = h('nav', { class: 'nav' });
  const alert = h('div', { class: 'alerts' });
  const view = h('main');
  shell = { topbar, nav, alert, view };
  app.replaceChildren(h('div', { class: 'shell' }, topbar, nav, alert, view));
}

function renderChrome() {
  const { state } = store;
  renderAlerts();
  document.title = `${state.settings.club_name} · Бильярд`;
  const s = state.shift;
  shell.topbar.replaceChildren(
    h('div', { class: 'brand' }, h('span', { class: 'dot' }), state.settings.club_name),
    h('div', { class: 'right row' },
      syncChip(),
      s ? h('a', { class: 'chip ok btnlike', href: '#/shift', style: { textDecoration: 'none' } }, 'Смена', h('span', { class: 'hide-sm' }, ` · ${s.user_name}`), ` · с ${fmtTime(s.opened_at)}`)
        : h('a', { class: 'chip warn btnlike', href: '#/shift', style: { textDecoration: 'none' } }, 'Смена закрыта'),
      h('span', { class: 'chip hide-sm' }, h('span', null, state.user.name), state.user.role === 'admin' ? ' · админ' : ''),
      h('button', { class: 'btn sm ghost', onclick: logout, title: 'Выйти' }, icon('logout'))));
  const key = currentKey();
  shell.nav.replaceChildren(...Object.entries(ROUTES).filter(([, r]) => !r.admin || state.user.role === 'admin')
    .map(([k, r]) => h('a', { href: `#/${k}`, class: k === key ? 'on' : '' }, icon(r.icon), r.label)));
}

function syncChip() {
  const sync = getLocal()?.sync;
  if (!sync || !sync.configured) return null;
  const st = sync.status;
  const short = { synced: 'Облако', pending: 'Отправка…', offline: 'Нет связи', conflict: 'Конфликт', error: 'Ошибка облака', off: 'Облако' }[st];
  return h('button', { class: `chip btnlike ${STATUS_KIND[st]}`, title: STATUS_TEXT[st], onclick: statusModal, style: { cursor: 'pointer' } }, '☁ ', short);
}

const toMin = (t) => { const [hh, mm] = String(t).split(':').map(Number); return hh * 60 + mm; };

/** Предупреждения: смена затянулась сверх плана, облако не подключено или в конфликте. */
function renderAlerts() {
  const { state } = store;
  const items = [];
  const sh = state.shift;
  if (sh) {
    const d = new Date(sh.opened_at);
    d.setHours(0, 0, 0, 0);
    const start = toMin(state.settings.shift_start);
    let end = toMin(state.settings.shift_end);
    if (end <= start) end += 1440;
    if (now() > d.getTime() + (end + 15) * 60000) {
      items.push(h('div', { class: 'banner' }, `Плановое время смены закончилось в ${state.settings.shift_end}. Закройте смену и пересчитайте кассу.`,
        h('a', { class: 'btn sm primary', href: '#/shift' }, 'Закрыть смену')));
    }
  }
  const sync = getLocal()?.sync;
  if (sync?.status === 'conflict') items.push(conflictBanner());
  if (sync && !sync.configured && state.user.role === 'admin') {
    items.push(h('div', { class: 'banner' }, 'Облако не подключено: данные клуба лежат только на этом устройстве и недоступны с других.',
      h('a', { class: 'btn sm primary', href: '#/admin' }, 'Подключить облако')));
  }
  shell.alert.replaceChildren(...items);
}

async function renderView(keepScroll) {
  const key = currentKey();
  const token = ++renderToken;
  const route = ROUTES[key];
  const scroll = window.scrollY;
  try {
    const el = await route.view.render(store.state, { rerender: () => renderView(true) });
    if (token !== renderToken) return;
    shell.view.replaceChildren(el);
    if (keepScroll && currentRoute === key) window.scrollTo(0, scroll);
    else window.scrollTo(0, 0);
    currentRoute = key;
    updateLive();
  } catch (e) {
    if (token !== renderToken) return;
    shell.view.replaceChildren(h('div', { class: 'empty' }, `Ошибка: ${e.message}`));
  }
}

function onRoute() {
  if (!shell) return;
  renderChrome();
  renderView(false);
}

// Обновления состояния объединяем в один кадр.
store.onChange = () => {
  if (!shell || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderChrome();
    if (ROUTES[currentKey()].view.live) renderView(true);
    refreshModals();
  });
};

// ---------- живые таймеры ----------

function updateLive() {
  if (!store.state) return;
  for (const el of document.querySelectorAll('[data-live]')) {
    const kind = el.dataset.live;
    if (kind === 'timer') {
      const s = store.sessions.get(+el.dataset.sid);
      if (s) el.textContent = duration(liveSeconds(s));
    } else {
      const c = store.checks.get(+el.dataset.cid);
      if (!c) continue;
      const t = liveTotals(c);
      el.textContent = money(kind === 'live' ? t.live_kop : t.total_kop);
    }
  }
}
setInterval(updateLive, 1000);

// ---------- вход / выход ----------

let changeTimer = 0;
subscribeChanges(() => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { if (shell) loadState().catch(() => {}); }, 80);
});

async function start() {
  getLocal()?.onSyncStatus(() => { if (shell) { renderChrome(); } });
  await loadState();
  closeAllModals();
  buildShell();
  startChangeFeed();
  renderChrome();
  renderView(false);
}

async function showLogin() {
  stopChangeFeed();
  shell = null;
  store.state = null;
  closeAllModals();
  await renderLogin(app, start);
}

async function logout() {
  try { await post('/api/logout'); } catch { /* уже вышли */ }
  showLogin();
}

setUnauthorizedHandler(() => { if (shell) { toast('Сессия завершена, войдите снова', 'warn'); showLogin(); } });
window.addEventListener('hashchange', onRoute);
window.addEventListener('sunclub-backup', () => { if (shell) renderAlerts(); });
// Подстраховка на случай потери SSE-соединения.
setInterval(() => { if (shell && !document.hidden && getMode() === 'server') loadState().catch(() => {}); }, 20000);
document.addEventListener('visibilitychange', () => { if (shell && !document.hidden) loadState().catch(() => {}); });

(async () => {
  try {
    await initBackend();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'login-box' }, h('div', { class: 'brand' }, h('span', { class: 'dot' }), 'SunClub'), h('p', null, e.message))));
    return;
  }
  try {
    const { user } = await get('/api/me');
    if (user.must_change) { await post('/api/logout'); return showLogin(); }
    await start();
  } catch {
    showLogin();
  }
})();

// Установка как приложение и работа без интернета.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
