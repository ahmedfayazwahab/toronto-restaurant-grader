// The Restaurant Grader app, independent of where it runs (local Node server or AWS Lambda).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, redact } from './lib/analyze.js';
import { ENV } from './lib/env.js';
import { buildIndex, fuzzy } from './lib/fuzzy.js';
import { gradeOf, gradeCutoffs } from './lib/grade.js';
import * as store from './lib/store.js';
import { checkScan, refundScan, softLimit, limits } from './lib/limits.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const TTL_MS = 24 * 3600 * 1000;
const VERSION = 3;
const BASE = (ENV.BASE_PATH || '').replace(/\/+$/, '');

const est = JSON.parse(fs.readFileSync(path.join(root, 'data', 'establishments.json'), 'utf8'));
const estById = new Map(est.map((e) => [e.id, e]));
const idx = est.map((e) => ({ e, n: e.name.toLowerCase() }));
const fz = buildIndex(est);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function search(q, limit, all) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  for (const { e, n } of idx) {
    if (!all && !e.likelyRestaurant) continue;
    let s = 0;
    if (n.startsWith(q)) s = 3; else if (n.includes(' ' + q)) s = 2; else if (n.includes(q)) s = 1;
    if (s) out.push([s, e]);
  }
  out.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
  const res = out.slice(0, limit).map(([, e]) => ({ id: e.id, name: e.name, address: e.address, similar: false }));
  if (res.length < limit) {
    const seen = new Set(res.map((r) => r.id));
    for (const { e } of fuzzy(fz, q, limit + 4, all)) {
      if (seen.has(e.id) || res.length >= limit) continue;
      res.push({ id: e.id, name: e.name, address: e.address, similar: true });
    }
  }
  return res;
}

// ---- report cache + "recent reports" list ----
const safeId = (id) => id.replace(/[^A-Za-z0-9_-]/g, '');
const reportKey = (id) => `reports/${safeId(id)}.json`;
const readCache = async (id) => { const c = await store.get(reportKey(id)).catch(() => null); return c && c.version === VERSION ? c : null; };
const fresh = (c) => c && Date.now() - Date.parse(c.scannedAt) < TTL_MS;

async function recordRecent(rep) {
  const list = (await store.get('recent.json').catch(() => null)) || [];
  const row = { placeId: rep.meta.placeId, name: rep.meta.name, rating: rep.meta.rating, overall: rep.scores.overall, incomplete: !!rep.scores.incomplete, at: rep.scannedAt };
  await store.put('recent.json', [row, ...list.filter((r) => r.placeId !== row.placeId)].slice(0, 10)).catch(() => {});
}
const ago = (t) => { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };

// ---- scans ----
const inflight = new Map();

function resolveKey({ placeId, estId }) {
  const e = estId ? estById.get(estId) : null;
  if (estId && !e) throw Object.assign(new Error('Unknown restaurant'), { code: 404 });
  const key = placeId || (e && 'est-' + e.id);
  if (!key) throw Object.assign(new Error('placeId or estId required'), { code: 400 });
  return { e, key };
}

/** Run (or join) a scan. Viewing a cached report is free; only a NEW scan counts against the visitor's limit. */
async function startScan({ placeId, estId, refresh }, ip) {
  const { e, key } = resolveKey({ placeId, estId });
  if (!refresh) { const c = await readCache(key); if (fresh(c)) return { cached: c }; }
  let job = inflight.get(key);
  if (!job) {
    await checkScan(ip);
    const events = [];
    const subs = new Set();
    const emit = (ev) => { events.push(ev); for (const f of subs) f(ev); };
    const promise = (async () => {
      const rep = await analyze({ placeId, name: e?.name, address: e?.address }, emit);
      await store.put(reportKey(rep.meta.placeId), rep);
      if (e) await store.put(reportKey('est-' + e.id), rep);
      await recordRecent(rep);
      return rep;
    })().catch(async (err) => { await refundScan(ip).catch(() => {}); throw err; }).finally(() => setTimeout(() => inflight.delete(key), 1000));
    job = { events, subs, promise };
    inflight.set(key, job);
  }
  return { job };
}

const PHOTO = /^places\/[A-Za-z0-9_-]{10,200}\/photos\/[A-Za-z0-9_-]{10,600}$/;
async function photoProxy(url, res) {
  const name = url.searchParams.get('name') || '';
  if (!PHOTO.test(name) || !ENV.GOOGLE_API_KEY) return send(res, 400, 'bad photo', 'text/plain');
  const r = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${Math.min(1000, +url.searchParams.get('w') || 640)}&key=${ENV.GOOGLE_API_KEY}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return send(res, 502, 'photo unavailable', 'text/plain');
  res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

/** Best-effort visitor IP. Behind CloudFront the real viewer address is in cloudfront-viewer-address or x-forwarded-for. */
export function clientIp(req) {
  const h = req.headers || {};
  const cf = h['cloudfront-viewer-address'];
  if (cf) return String(cf).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const xff = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return req.socket?.remoteAddress || 'unknown';
}

export function createApp({ serveStatic = true } = {}) {
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    if (BASE && (p === BASE || p.startsWith(BASE + '/'))) p = p.slice(BASE.length) || '/';
    const ip = clientIp(req);
    try {
      // On AWS, only CloudFront (which adds this secret header) may call the function.
      if (ENV.ORIGIN_SECRET && req.headers['x-origin-verify'] !== ENV.ORIGIN_SECRET) return send(res, 403, { error: 'Forbidden' });

      if (p === '/api/search') {
        if (!softLimit(ip, 'search', 1500)) return send(res, 429, { error: 'Too many searches. Please slow down.' });
        return send(res, 200, search(url.searchParams.get('q') || '', 8, url.searchParams.get('all') === '1'));
      }
      if (p === '/api/photo') {
        if (!softLimit(ip, 'photo', 600)) return send(res, 429, 'Too many photo requests', 'text/plain');
        return await photoProxy(url, res);
      }
      if (p === '/api/scan') {
        const q = { placeId: url.searchParams.get('placeId'), estId: url.searchParams.get('estId'), refresh: url.searchParams.get('refresh') === '1' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const out = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        let s;
        try { s = await startScan(q, ip); } catch (e) { out('fail', { error: redact(e.message), limit: e.code === 429 }); return res.end(); }
        if (s.cached) { out('done', s.cached); return res.end(); }
        const { job } = s;
        for (const ev of job.events) out('progress', ev);
        const sub = (ev) => out('progress', ev);
        job.subs.add(sub);
        req.on?.('close', () => job.subs.delete(sub));
        // Keep-alive comments stop proxies (CloudFront) from closing the connection during long steps.
        const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* connection already closed */ } }, 8000);
        try { out('done', await job.promise); } catch (e) { console.error('scan error:', redact(e.message)); out('fail', { error: redact(e.message) }); }
        clearInterval(hb);
        job.subs.delete(sub);
        return res.end();
      }
      if (p === '/api/report') {
        const q = { placeId: url.searchParams.get('placeId'), estId: url.searchParams.get('estId'), refresh: url.searchParams.get('refresh') === '1' };
        const s = await startScan(q, ip);
        return send(res, 200, s.cached || (await s.job.promise));
      }
      if (p === '/api/recent') {
        const rows = (await store.get('recent.json').catch(() => null)) || [];
        return send(res, 200, rows.slice(0, 10).map((r) => ({ ...r, grade: gradeOf(r.overall), when: ago(r.at) })));
      }
      if (p === '/api/config') return send(res, 200, { ...gradeCutoffs(), contactEmail: ENV.CONTACT_EMAIL || null, limits: limits() });
      if (p === '/api/stats') return send(res, 200, { total: est.length, restaurants: est.filter((e) => e.likelyRestaurant).length });
      if (!serveStatic) return send(res, 404, { error: 'Not found' });

      const f = p === '/' ? '/index.html' : p.startsWith('/report') ? '/report.html' : p;
      const fp = path.join(root, 'public', path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
      if (!fp.startsWith(path.join(root, 'public')) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(fp), types[path.extname(fp)] || 'application/octet-stream');
    } catch (e) {
      console.error('error:', redact(e.message));
      if (!res.headersSent) send(res, e.code || 500, { error: redact(e.message) }); else res.end();
    }
  }
  return { handle };
}
