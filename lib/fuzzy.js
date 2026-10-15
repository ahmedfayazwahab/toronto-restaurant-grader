// Typo- and sound-tolerant restaurant name search.

/** Collapse spelling variants so "sooper", "souper" and "super" look alike. */
export function phon(s) {
  s = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return s
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/wh/g, 'w').replace(/th/g, 't').replace(/gh/g, 'g').replace(/kn/g, 'n').replace(/wr/g, 'r')
    .replace(/oo|ou|ew|ue|oe/g, 'u').replace(/ee|ea|ie|ey|y/g, 'i').replace(/ai|ay/g, 'a')
    .replace(/(.)\1+/g, '$1');
}

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const win = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const am = new Array(la).fill(false), bm = new Array(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    for (let j = Math.max(0, i - win); j < Math.min(lb, i + win + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true; m++; break;
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) { if (!am[i]) continue; while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  return (m / la + m / lb + (m - t / 2) / m) / 3;
}
export function jaroWinkler(a, b) {
  const j = jaro(a, b);
  let p = 0;
  while (p < 4 && a[p] && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

const grams = (s) => {
  const p = `  ${s} `, out = new Set();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
};

export function buildIndex(list) {
  const entries = list.map((e) => { const p = phon(e.name); return { e, p, tokens: p.split(' ') }; });
  const tri = new Map();
  entries.forEach((en, i) => { for (const g of grams(en.p)) { let a = tri.get(g); if (!a) tri.set(g, (a = [])); a.push(i); } });
  return { entries, tri };
}

/** Best fuzzy matches for q. Returns [{e, score}] with score 0..1. */
export function fuzzy(index, q, limit = 8, all = false) {
  const qp = phon(q);
  if (qp.length < 3) return [];
  const qt = qp.split(' ');
  const qg = grams(qp);
  const hits = new Map();
  for (const g of qg) { const a = index.tri.get(g); if (a && a.length < 6000) for (const i of a) hits.set(i, (hits.get(i) || 0) + 1); }
  const need = Math.max(1, Math.floor(qg.size * 0.3));
  const out = [];
  for (const [i, c] of hits) {
    if (c < need) continue;
    const en = index.entries[i];
    if (!all && !en.e.likelyRestaurant) continue;
    const whole = jaroWinkler(qp, en.p);
    const prefix = en.p.startsWith(qp) ? 1 : jaroWinkler(qp, en.p.slice(0, qp.length + 2));
    // each query word against its best name word
    const tok = qt.reduce((s, w) => s + Math.max(...en.tokens.map((t) => jaroWinkler(w, t))), 0) / qt.length;
    const score = Math.max(whole, tok * 0.97, prefix * 0.95);
    if (score >= 0.84) out.push({ e: en.e, score });
  }
  out.sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length);
  return out.slice(0, limit);
}
