// Адаптер sql.js под интерфейс node:sqlite (exec / prepare().run/get/all), чтобы ядро работало в браузере.
const norm = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

export function wrapSqlJs(sql) {
  return {
    raw: sql,
    exec(text) { sql.exec(text); },
    prepare(text) {
      return {
        run(...args) {
          const st = sql.prepare(text);
          try { st.run(norm(args)); } finally { st.free(); }
          return { changes: sql.getRowsModified(), lastInsertRowid: sql.exec('SELECT last_insert_rowid()')[0].values[0][0] };
        },
        get(...args) {
          const st = sql.prepare(text);
          try {
            st.bind(norm(args));
            return st.step() ? st.getAsObject() : undefined;
          } finally { st.free(); }
        },
        all(...args) {
          const st = sql.prepare(text);
          try {
            st.bind(norm(args));
            const rows = [];
            while (st.step()) rows.push(st.getAsObject());
            return rows;
          } finally { st.free(); }
        },
      };
    },
  };
}
