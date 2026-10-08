import { getLocal } from './api.js';
import { toast } from './ui.js';

const KEY = 'sunclub_last_backup';

export const lastBackupAt = () => Number(localStorage.getItem(KEY)) || 0;

/** Скачивает файл резервной копии (только в локальном режиме). */
export function downloadBackup() {
  const local = getLocal();
  if (!local) return false;
  const bytes = local.exportBackup();
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `sunclub-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.sqlite`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  localStorage.setItem(KEY, String(Date.now()));
  window.dispatchEvent(new Event('sunclub-backup'));
  toast(`Резервная копия сохранена: ${name}`);
  return true;
}
