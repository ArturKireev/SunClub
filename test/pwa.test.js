import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const pub = new URL('../public', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [relative(pub, p)];
});

test('service worker кэширует все файлы приложения (иначе офлайн-режим сломается)', () => {
  const sw = readFileSync(join(pub, 'sw.js'), 'utf8');
  const listed = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));
  const skip = new Set(['sw.js', 'vendor/package.json', 'vendor/sql.js.LICENSE']);
  const missing = walk(pub).filter((f) => !skip.has(f) && !listed.has(f));
  assert.deepEqual(missing, [], 'добавьте файлы в PRECACHE в public/sw.js');
  for (const f of listed) assert.ok(statSync(join(pub, f)).isFile(), `${f} не существует`);
});

test('все пути в приложении относительные (работает из подпапки GitHub Pages)', () => {
  const bad = [];
  for (const f of walk(pub).filter((x) => /\.(js|html|css)$/.test(x) && !x.startsWith('vendor/'))) {
    const src = readFileSync(join(pub, f), 'utf8');
    for (const m of src.matchAll(/(?:src|href|fetch\()\s*=?\s*['"]\/(?!\/)[^'"]*['"]/g)) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});
