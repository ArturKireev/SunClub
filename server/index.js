// Серверный режим (для подключения ламп по локальной сети): та же программа, но данные хранятся в файле на сервере.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { initDb, seedIfEmpty } from '../public/js/core/db.js';
import { createLamps } from '../public/js/core/lamps.js';
import { createCore } from '../public/js/core/api.js';
import { createHttpApp } from './http.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'club.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
initDb(db);
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) console.log('Первый запуск. Созданы сотрудники (PIN нужно сменить при первом входе):');
await seedIfEmpty(db, console.log);

const core = createCore({ db, lamps: createLamps(db) });
const app = createHttpApp({ core, publicDir: join(root, 'public') });
const server = createServer(app.handle);
server.listen(port, host, () => console.log(`SunClub Billiard: http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { app.close(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); });
}
