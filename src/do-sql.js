// Адаптер SQLite Durable Object (ctx.storage.sql) под интерфейс node:sqlite, который ждёт ядро.
const norm = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

export function wrapDoSql(ctx) {
  const sql = ctx.storage.sql;
  const rows = (text, args) => sql.exec(text, ...norm(args)).toArray();
  return {
    exec(text) { sql.exec(text); },
    transactionSync(fn) { return ctx.storage.transactionSync(fn); },
    prepare(text) {
      return {
        run(...args) {
          rows(text, args);
          return { changes: rows('SELECT changes() c', [])[0].c, lastInsertRowid: rows('SELECT last_insert_rowid() r', [])[0].r };
        },
        get(...args) { return rows(text, args)[0]; },
        all(...args) { return rows(text, args); },
      };
    },
  };
}
