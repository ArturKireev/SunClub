import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDb, seedIfEmpty } from './db.js';
import { createLamps } from './lamps.js';
import { createApp } from './app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const db = openDb(join(dataDir, 'club.db'));
const hadUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
if (!hadUsers) console.log('Первый запуск. Созданы сотрудники (PIN нужно сменить при первом входе):');
seedIfEmpty(db, console.log);

const app = createApp({ db, lamps: createLamps(db), publicDir: join(root, 'public') });
const server = createServer(app.handle);
server.listen(port, host, () => console.log(`SunClub Billiard: http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { app.close(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); });
}
