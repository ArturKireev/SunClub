import { h, openModal, formDialog, confirmDialog, fmtDateTime, toast } from '../ui.js';
import { getLocal } from '../api.js';

export const STATUS_TEXT = {
  off: 'Только на этом устройстве',
  synced: 'Облако синхронизировано',
  pending: 'Отправка в облако…',
  offline: 'Нет связи, данные сохранены на устройстве',
  conflict: 'Конфликт данных',
  error: 'Ошибка облака',
};
export const STATUS_KIND = { off: 'warn', synced: 'ok', pending: '', offline: 'warn', conflict: 'bad', error: 'bad' };

const sync = () => getLocal()?.sync;

/** Подключение к облаку: адрес веб-приложения и ключ. Вызывается из настроек и с экрана входа. */
export function connectDialog() {
  const s = sync();
  const cur = s.config;
  return formDialog({
    title: 'Подключить облако', submitText: 'Подключить', size: '',
    fields: [
      { name: 'url', label: 'URL веб-приложения (Google Apps Script)', type: 'text', value: cur?.url || '', placeholder: 'https://script.google.com/macros/s/…/exec' },
      { name: 'key', label: 'Ключ (SECRET из Code.gs)', type: 'password', value: cur?.key || '' },
      { name: 'deviceName', label: 'Название этого устройства', type: 'text', value: cur?.deviceName || '', placeholder: 'Например: Планшет в клубе / Телефон владельца' },
    ],
    submit: async (v) => {
      if (!/^(https:\/\/script\.google(usercontent)?\.com\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(v.url.trim())) throw new Error('Адрес должен начинаться с https://script.google.com/…');
      s.configure(v);
      let r;
      try { r = await s.connect(); } catch (e) { s.disconnect(); throw e; }
      if (r === 'pushed') return toast('Облако подключено, данные клуба загружены в облако');
      const when = r.updated_at ? fmtDateTime(r.updated_at) : '';
      const ok = await confirmDialog(`В облаке уже есть данные клуба (последняя запись: ${r.device_name || 'устройство'}${when ? `, ${when}` : ''}). Загрузить их на это устройство? Данные, которые сейчас лежат на этом устройстве, будут заменены.`, { okText: 'Загрузить из облака', danger: true });
      if (!ok) { s.disconnect(); throw new Error('Подключение отменено'); }
      await s.pull();
      toast('Данные из облака загружены');
    },
  });
}

async function resolveConflict(how) {
  const s = sync();
  const ok = await confirmDialog(how === 'cloud'
    ? 'Данные на этом устройстве, внесённые после последней синхронизации, будут потеряны. Взять версию из облака?'
    : 'Данные из облака, которых нет на этом устройстве, будут перезаписаны. Записать версию этого устройства?', { danger: true, okText: how === 'cloud' ? 'Взять из облака' : 'Записать моё' });
  if (!ok) return false;
  try { await (how === 'cloud' ? s.pull() : s.forcePush()); toast('Готово'); return true; } catch (e) { toast(e.message, 'err'); return false; }
}

/** Баннер конфликта для верхней панели. */
export function conflictBanner() {
  const s = sync();
  const c = s?.info.cloud;
  return h('div', { class: 'banner' },
    `Данные изменены на другом устройстве${c?.device_name ? ` («${c.device_name}»${c.updated_at ? `, ${fmtDateTime(c.updated_at)}` : ''})` : ''}, пока здесь были свои изменения. Выберите, какую версию оставить.`,
    h('button', { class: 'btn sm primary', onclick: () => resolveConflict('cloud') }, 'Взять из облака'),
    h('button', { class: 'btn sm', onclick: () => resolveConflict('local') }, 'Оставить мою'));
}

export function statusModal() {
  openModal({ title: 'Облако', live: true, size: '', render: () => statusBody() });
}

function statusBody() {
  const s = sync();
  if (!s) return h('p', null, 'Облако доступно только в локальном режиме.');
  const i = s.info;
  return h('div', { class: 'stack' },
    h('div', { class: 'row wrap' }, h('span', { class: `chip ${STATUS_KIND[s.status]}` }, STATUS_TEXT[s.status]), i.version ? h('span', { class: 'muted' }, `версия ${i.version}${i.at ? `, ${fmtDateTime(i.at)}` : ''}`) : null),
    i.error ? h('div', { class: 'banner' }, i.error) : null,
    s.status === 'offline' ? h('p', { class: 'muted', style: { margin: 0 } }, 'Работать можно как обычно: изменения сохраняются на устройстве и уйдут в облако, когда появится интернет.') : null,
    s.status === 'conflict' ? conflictBanner() : null,
    h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => s.check().catch((e) => toast(e.message, 'err')) }, 'Проверить сейчас')));
}

/** Вкладка «Облако» в настройках. */
export async function cloudTab(ctx) {
  const s = sync();
  if (!s) return h('div', { class: 'card' }, 'Облако доступно в локальном режиме (приложение на GitHub Pages).');
  const cfg = s.config;
  const steps = h('ol', { style: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '6px' } },
    h('li', null, 'Откройте script.google.com под своим Google-аккаунтом → «Новый проект».'),
    h('li', null, 'Нажмите «Скопировать код» ниже и вставьте его в редактор целиком (вместо того, что там было).'),
    h('li', null, 'В первой строке кода замените ЗАМЕНИТЕ_НА_ДЛИННЫЙ_ПАРОЛЬ на свой пароль (20+ символов). Сохраните.'),
    h('li', null, '«Начать развертывание» → «Новое развертывание» → тип «Веб-приложение», «Выполнять от имени: Я», «Доступ: Все». Разрешите доступ к Диску.'),
    h('li', null, 'Скопируйте «URL веб-приложения», нажмите «Подключить» ниже и вставьте URL и пароль.'));
  return h('div', { class: 'stack', style: { maxWidth: '760px' } },
    h('div', { class: 'card stack' },
      h('h3', null, 'Состояние'),
      h('div', { class: 'row wrap' }, h('span', { class: `chip ${STATUS_KIND[s.status]}` }, STATUS_TEXT[s.status]), cfg ? h('span', { class: 'muted' }, `устройство: ${cfg.deviceName}`) : null),
      s.status === 'conflict' ? conflictBanner() : null,
      h('p', { style: { margin: 0 } }, cfg
        ? 'Приложение работает на устройстве мгновенно, а копия базы уходит в облако через несколько секунд после каждого изменения. С другого устройства откройте ту же ссылку, нажмите «Подключить облако» на экране входа — и увидите актуальные данные клуба, даже если клубное устройство выключено.'
        : 'Облако не подключено: данные лежат только на этом устройстве. Подключите облако, чтобы видеть данные клуба с любого устройства и не потерять их при поломке.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: async () => { if (await connectDialog()) ctx.rerender(); } }, cfg ? 'Изменить подключение' : 'Подключить облако'),
        cfg ? [
          h('button', { class: 'btn', onclick: () => s.check().then(() => ctx.rerender()).catch((e) => toast(e.message, 'err')) }, 'Проверить сейчас'),
          h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Это устройство перестанет синхронизироваться. Данные в облаке останутся.', { okText: 'Отключить', danger: true })) { s.disconnect(); ctx.rerender(); } } }, 'Отключить'),
        ] : null)),
    h('div', { class: 'card stack' },
      h('h3', null, 'Как создать облако (5 минут, один раз)'),
      steps,
      h('div', null, h('button', { class: 'btn', onclick: async () => {
        try {
          const text = await (await fetch('apps-script/Code.gs')).text();
          await navigator.clipboard.writeText(text);
          toast('Код скопирован');
        } catch { toast('Не удалось скопировать: откройте apps-script/Code.gs вручную', 'err'); }
      } }, 'Скопировать код')),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Данные хранятся в вашем Google Диске (файл sunclub-db.json и предыдущая версия рядом). Пароль знают только вы и устройства, где вы его ввели.')));
}
