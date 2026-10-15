import * as cheerio from 'cheerio';

const UA = 'RestaurantGraderBot/1.0';
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|avif|ico|pdf|zip|mp4|mp3|css|js|xml|json|docx?|xlsx?)(\?|$)/i;
const bare = (h) => h.replace(/^www\./, '');

async function get(url, ms = 8000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    const ct = r.headers.get('content-type') || '';
    let html = '';
    if (ct.includes('text/html')) html = await r.text(); else await r.body?.cancel();
    return { status: r.status, ms: Date.now() - t0, html, ct, url: r.url };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, html: '', error: String(e.cause?.code || e.message), url };
  }
}

async function head(url) {
  try {
    let r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (r.status === 405 || r.status === 403 || r.status === 400) r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    await r.body?.cancel();
    return r.status;
  } catch { return 0; }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function pageFacts(html) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const h1 = $('h1').length;
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  $('script,style,noscript,svg').remove();
  const words = $('body').text().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  return { title: !!title, h1: h1 > 0, desc: !!desc, words };
}

/** Crawl the homepage's internal links (up to `max` pages) and check what is broken. */
export async function crawl(startUrl, homeHtml, { max = 20 } = {}) {
  const base = new URL(startUrl);
  const $ = cheerio.load(homeHtml);
  const pages = new Map();
  $('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href'), startUrl);
      if (!/^https?:$/.test(u.protocol) || bare(u.host) !== bare(base.host) || SKIP_EXT.test(u.pathname)) return;
      u.hash = '';
      const key = u.pathname.replace(/\/+$/, '') + u.search;
      if (key === '' || key === base.pathname.replace(/\/+$/, '')) return;
      if (!pages.has(key) && pages.size < max) pages.set(key, u.href);
    } catch { /* ignore bad link */ }
  });
  const urls = [...pages.values()];
  const results = await pool(urls, 6, async (u) => {
    const r = await get(u);
    const f = r.html ? pageFacts(r.html) : null;
    return { url: u, status: r.status, ms: r.ms, error: r.error, ...f };
  });

  const imgs = [...new Set($('img[src]').toArray().map((i) => { try { return new URL($(i).attr('src'), startUrl).href; } catch { return null; } }).filter((s) => s && /^https?:/.test(s)))].slice(0, 12);
  const imgStatus = await pool(imgs, 6, async (u) => ({ url: u, status: await head(u) }));

  let mixed = 0;
  if (base.protocol === 'https:') {
    $('img[src],script[src],iframe[src],link[rel=stylesheet][href]').each((_, e) => { if (/^http:\/\//i.test($(e).attr('src') || $(e).attr('href') || '')) mixed++; });
  }
  const broken = results.filter((r) => r.status === 0 || r.status >= 400);
  return {
    crawled: results.length,
    broken: broken.map((r) => ({ url: r.url, status: r.status || 'no response' })),
    missingTitle: results.filter((r) => r.status === 200 && r.title === false).length,
    missingH1: results.filter((r) => r.status === 200 && r.h1 === false).length,
    missingDesc: results.filter((r) => r.status === 200 && r.desc === false).length,
    thin: results.filter((r) => r.status === 200 && r.words < 80).length,
    slow: results.filter((r) => r.status === 200 && r.ms > 3000).map((r) => ({ url: r.url, ms: r.ms })),
    brokenImages: imgStatus.filter((i) => i.status === 0 || i.status >= 400).map((i) => i.url),
    imagesChecked: imgStatus.length,
    mixed,
  };
}

/** Is the menu readable text, or locked in a PDF / images? */
export async function checkMenu(startUrl, homeHtml) {
  const $ = cheerio.load(homeHtml);
  const links = $('a[href]').toArray().map((a) => ({ text: $(a).text().replace(/\s+/g, ' ').trim(), href: $(a).attr('href') }));
  const m = links.find((l) => /\bmenus?\b/i.test(l.text) || /menu/i.test(l.href || ''));
  const homeText = $('body').text();
  const homePrices = (homeText.match(/\$\s?\d{1,3}(\.\d\d)?/g) || []).length;
  if (!m) return homePrices >= 4 ? { found: true, kind: 'text', where: 'homepage' } : { found: false, kind: 'none' };
  let url;
  try { url = new URL(m.href, startUrl).href; } catch { return { found: true, kind: 'unknown' }; }
  if (/\.pdf(\?|$)/i.test(url)) return { found: true, kind: 'pdf', url };
  if (bare(new URL(url).host) !== bare(new URL(startUrl).host)) return { found: true, kind: 'external', url };
  const r = await get(url);
  if (!r.html) return { found: true, kind: 'unknown', url };
  const p = cheerio.load(r.html);
  const imgCount = p('img').length;
  p('script,style,noscript,svg').remove();
  const words = p('body').text().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  const prices = (p('body').text().match(/\$\s?\d{1,3}(\.\d\d)?/g) || []).length;
  if (words >= 150 || prices >= 4) return { found: true, kind: 'text', url };
  if (/\.pdf/i.test(r.html) && words < 150) return { found: true, kind: 'pdf', url };
  return { found: true, kind: imgCount >= 2 ? 'image' : 'thin', url };
}

/** schema.org types present in JSON-LD. */
export function structuredData(html) {
  const $ = cheerio.load(html);
  const types = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = n['@type'];
    if (t) [].concat(t).forEach((x) => types.add(String(x)));
    if (n['@graph']) walk(n['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, s) => { try { walk(JSON.parse($(s).contents().text())); } catch { /* invalid JSON-LD */ } });
  const ok = [...types].filter((t) => /Restaurant|FoodEstablishment|LocalBusiness|CafeOrCoffeeShop|Bakery|BarOrPub|FastFoodRestaurant/i.test(t));
  return { types: [...types].slice(0, 8), restaurant: ok.length > 0 };
}
