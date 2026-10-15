// Merge duplicate DineSafe rows (same name + same address, differing only in case/format).
// Safe to re-run: the untouched original is kept in data/establishments.raw.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const rawPath = path.join(dir, 'establishments.raw.json');
const outPath = path.join(dir, 'establishments.json');
if (!fs.existsSync(rawPath)) fs.copyFileSync(outPath, rawPath);
// Names that are clearly not restaurants (schools, childcare, seniors' homes, convenience stores).
const NOT_FOOD = /\b(collegiate|institute|school|daycare|day care|child ?care|academy|nursery|preschool|montessori|seniors?|retirement|living|manor|convenience|7-?eleven|cultural cent(re|er)|yacht club|church|temple|mosque|synagogue|congregation)\b/i;
const list = JSON.parse(fs.readFileSync(rawPath, 'utf8')).map((e) => ({ ...e, likelyRestaurant: e.likelyRestaurant && !NOT_FOOD.test(e.name) }));

const nk = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ak = (s) => nk(s
  .toLowerCase()
  .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd').replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
  .replace(/\b(unit|suite|ste|rm|room)[\s-]*[a-z0-9-]+\b/g, ''));
const isShouting = (s) => s === s.toUpperCase() && /[A-Z]/.test(s);
const score = (e) => (e.phone ? 4 : 0) + (e.lat != null ? 2 : 0) + (isShouting(e.address) ? 0 : 1) + (isShouting(e.name) ? 0 : 1);

const groups = new Map();
for (const e of list) {
  const k = nk(e.name) + '|' + ak(e.address);
  (groups.get(k) || groups.set(k, []).get(k)).push(e);
}
const out = [];
for (const g of groups.values()) {
  g.sort((a, b) => score(b) - score(a));
  const best = { ...g[0] };
  for (const o of g.slice(1)) {
    best.phone ||= o.phone;
    if (best.lat == null) { best.lat = o.lat; best.lng = o.lng; }
    best.likelyRestaurant = best.likelyRestaurant && o.likelyRestaurant;
  }
  out.push(best);
}
// Pass 2: same address, and the longer name only adds filler words ("Diwan" vs "Diwan Restaurant").
const FILLER = new Set(['restaurant', 'restaurants', 'inc', 'co', 'ltd', 'limited', 'company', 'corp', 'the', 'and', 'bar', 'grill', 'lounge', 'food', 'truck', 'sandwiches', 'salads', 'coffee', 'pho']);
const words = (n) => n.toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const byAddr = new Map();
for (const e of out) (byAddr.get(ak(e.address)) || byAddr.set(ak(e.address), []).get(ak(e.address))).push(e);
const drop = new Set();
const merged = [];
for (const g of byAddr.values()) {
  if (g.length < 2) continue;
  for (const a of g) for (const b of g) {
    if (a === b || drop.has(a) || drop.has(b)) continue;
    const wa = words(a.name), wb = words(b.name);
    if (!wa.length || wa.length >= wb.length) continue;            // a is the shorter name
    if (!wa.every((w) => wb.includes(w))) continue;                // b contains all of a's words
    const extra = wb.filter((w) => !wa.includes(w));
    if (!extra.every((w) => FILLER.has(w))) continue;              // and adds only filler
    const keep = score(b) > score(a) ? b : a;                      // keep the more complete record, shorter name
    const gone = keep === a ? b : a;
    keep.phone ||= gone.phone;
    if (keep.lat == null) { keep.lat = gone.lat; keep.lng = gone.lng; }
    if (keep === b) keep.name = a.name;
    drop.add(gone);
    merged.push(`${a.name}  +  ${b.name}  (${a.address})`);
  }
}
// Pass 3: same address, one name contains the other, and the phone number is identical.
const digits = (p) => (p || '').replace(/\D/g, '');
for (const g of byAddr.values()) {
  const live = g.filter((e) => !drop.has(e));
  for (const a of live) for (const b of live) {
    if (a === b || drop.has(a) || drop.has(b)) continue;
    const na = nk(a.name), nb = nk(b.name);
    if (na === nb || !nb.includes(na) || !digits(a.phone) || digits(a.phone) !== digits(b.phone)) continue;   // a is the shorter name
    a.lat ??= b.lat; a.lng ??= b.lng;
    a.likelyRestaurant = a.likelyRestaurant && b.likelyRestaurant;
    drop.add(b);
    merged.push(`${a.name}  +  ${b.name}  (same phone ${a.phone}; ${a.address})`);
  }
}
const final = out.filter((e) => !drop.has(e));
fs.writeFileSync(path.join(dir, 'merged-near-duplicates.txt'), merged.join('\n'));
out.length = 0; out.push(...final);
out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`${list.length} rows -> ${out.length} unique restaurants (${list.length - out.length} duplicates merged, ${merged.length} of them same-address name variants, incl. matching phone)`);
