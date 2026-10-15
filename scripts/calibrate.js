// Scan a random sample of Toronto restaurants and look at how scores are spread.
// Usage: node scripts/calibrate.js [count]   -> writes data/calibration.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, redact } from '../lib/analyze.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const want = +process.argv[2] || 30;
const list = JSON.parse(fs.readFileSync(path.join(dir, 'establishments.json'), 'utf8')).filter((e) => e.likelyRestaurant);

let seed = 20261013;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const seenNames = new Set();
const pool = [];
while (pool.length < want * 3) {
  const e = list[Math.floor(rnd() * list.length)];
  const k = e.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);   // one entry per chain/name
  if (seenNames.has(k)) continue;
  seenNames.add(k); pool.push(e);
}
const out = [];
let next = 0;
const save = () => fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify(out, null, 1));
async function worker() {
  while (out.filter((r) => r.ok).length < want && next < pool.length) {
    const e = pool[next++];
    const t0 = Date.now();
    try {
      const r = await analyze({ name: e.name, address: e.address });
      out.push({ ok: true, dine: e.name, name: r.meta.name, overall: r.scores.overall, incomplete: r.scores.incomplete, website: !!r.meta.website, search: r.scores.search.score, guest: r.scores.guest.score, local: r.scores.local.score });
      console.log(`✓ ${r.meta.name.padEnd(38).slice(0, 38)} ${String(r.scores.overall).padStart(3)} ${r.scores.incomplete ? 'incomplete' : ''} ${r.meta.website ? '' : 'no-website'} (${((Date.now() - t0) / 1000) | 0}s)`);
    } catch (err) { out.push({ ok: false, dine: e.name }); console.log(`✗ ${e.name}: ${redact(err.message).slice(0, 80)}`); }
    save();
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log('done', out.filter((r) => r.ok).length, 'scored');
