import * as cheerio from 'cheerio';
import { ENV, redact } from './env.js';
import { crawl, checkMenu, structuredData } from './crawl.js';
import { reviewSentiment } from './reviews.js';
import { mentions } from './websearch.js';
import { analyzeCoverage } from './coverage.js';
import { detectCuisine } from './cuisine.js';
import { estimateLoss, ASSUMPTIONS } from './estimate.js';
import { gradeOf } from './grade.js';
import * as store from './store.js';
import { weightedRating, looksNew } from './strength.js';

const PLACES_KEY = ENV.GOOGLE_API_KEY;
const PSI_KEY = ENV.PAGESPEED_API_KEY || ENV.GOOGLE_API_KEY;
export { redact };

const UA = 'RestaurantGraderBot/1.0';

// ---------- Google Places ----------
async function places(pathname, { method = 'POST', body, mask }) {
  if (!PLACES_KEY) throw new Error('GOOGLE_API_KEY is not set in .env');
  const r = await fetch('https://places.googleapis.com/v1/' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': mask },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Places API ${r.status}: ${j.error?.message || 'request failed'}`);
  return j;
}

const DETAIL_MASK = [
  'id', 'displayName', 'formattedAddress', 'addressComponents', 'location', 'rating', 'userRatingCount',
  'websiteUri', 'nationalPhoneNumber', 'priceLevel', 'priceRange', 'types', 'primaryType', 'primaryTypeDisplayName',
  'editorialSummary', 'regularOpeningHours', 'dineIn', 'takeout', 'delivery', 'reservable', 'googleMapsUri', 'businessStatus',
].join(',');
const FULL_MASK = DETAIL_MASK + ',photos,reviews';

async function findPlaceId(name, address) {
  const j = await places('places:searchText', { body: { textQuery: `${name} ${address}`, pageSize: 1 }, mask: 'places.id,places.displayName' });
  return j.places?.[0]?.id || null;
}
const getDetails = (id, mask = DETAIL_MASK) => places('places/' + id, { method: 'GET', mask });

// ---------- helpers ----------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'of', 'a', 'restaurant', 'ristorante', 'bar', 'grill', 'cafe', 'inc', 'ltd']);
function nameMatches(title, name) {
  const t = norm(title), n = norm(name);
  if (!n) return false;
  if (t.includes(n)) return true;
  const toks = n.split(' ').filter((w) => w && !STOP.has(w));
  if (!toks.length) return false;
  return toks.filter((w) => t.includes(w)).length / toks.length >= 0.75;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const has = (text, words) => words.some((w) => w && norm(text).includes(norm(w)));

function keywordInfo(d) {
  const label = d.primaryTypeDisplayName?.text || '';
  let kw = norm(label).replace(/\brestaurant\b/, '').trim();
  const generic = !kw;
  if (generic) kw = 'restaurant';
  return { label, kw, generic, phrase: norm(label) };
}

function areasOf(d) {
  const comps = d.addressComponents || [];
  const pick = (t) => comps.find((c) => c.types?.includes(t))?.longText;
  const parts = (d.formattedAddress || '').split(',').map((s) => s.trim());
  const city = pick('locality') || parts[1] || '';
  const hood = pick('sublocality_level_1') || pick('sublocality') || pick('neighborhood') || (parts.length > 3 ? parts[1] : '') || '';
  const areas = [...new Set([hood, city].filter(Boolean))];
  return { hood: hood || city, city, areas };
}

// ---------- website ----------
async function fetchPage(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const html = await r.text();
    return { ok: r.ok, status: r.status, finalUrl: r.url, html, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: url, html: '', ms: Date.now() - t0, error: String(e.cause?.code || e.message) };
  }
}

async function singleDomain(url) {
  const bare = hostOf(url);
  const variants = [`http://${bare}/`, `https://${bare}/`, `https://www.${bare}/`];
  const hosts = await Promise.all(variants.map(async (v) => {
    try {
      const r = await fetch(v, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      await r.body?.cancel();
      return r.ok ? new URL(r.url).host : null;
    } catch { return null; }
  }));
  const finals = new Set(hosts.filter(Boolean));
  return finals.size === 1;
}

const OFFSITE = /(doordash|ubereats|skipthedishes|grubhub|toasttab|chownow|order-now\.me|ordering\.|order\.online|menulog|clover\.com|square\.site|squareup\.com|slice\.com|seamless|foodja|fantuan|hungrypanda|ritual\.co|olo\.com|bentobox|mobi2go|owner\.com)/i;
const BUILDER = /(wixsite\.com|square\.site|squarespace\.com|godaddysites\.com|business\.site|weebly\.com|wordpress\.com|myshopify\.com|carrd\.co|webflow\.io|linktr\.ee|facebook\.com|instagram\.com|toasttab\.com|order\.online|google\.com|beacons\.ai)$/i;
const SOCIAL = /(facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|youtube\.com|linkedin\.com|pinterest\.com)/i;

function auditHtml(html, finalUrl, ctx) {
  const $ = cheerio.load(html);
  const siteHost = hostOf(finalUrl);
  // Real photos only: skip logos, social/payment icons, spinners, blurred placeholders and anything tiny.
  const BADIMG = /logo|icon|sprite|pixel|spacer|avatar|badge|facebook|whatsapp|twitter|instagram|youtube|tiktok|linkedin|pinterest|social|arrow|chevron|loader|loading|spinner|placeholder|blur|lqip|favicon|payment|visa|mastercard|paypal|qr-?code|button|banner-?ad/i;
  const absUrl = (u) => { try { return u ? new URL(u, finalUrl).href : null; } catch { return null; } };
  const cands = [
    { u: $('meta[property="og:image"]').attr('content') },
    ...$('img').toArray().map((i) => ({ u: $(i).attr('data-src') || $(i).attr('data-lazy-src') || $(i).attr('src'), w: +$(i).attr('width') || 0, h: +$(i).attr('height') || 0, alt: $(i).attr('alt') || '', cls: $(i).attr('class') || '' })),
  ];
  const siteImages = [...new Set(cands
    .filter((c) => c.u && !(c.w && c.w < 200) && !(c.h && c.h < 120) && !BADIMG.test(`${c.alt} ${c.cls}`))
    .map((c) => absUrl(c.u))
    .filter((u) => u && /^https?:/.test(u) && /\.(jpe?g|png|webp)(\?|$)/i.test(u) && !BADIMG.test(u)))].slice(0, 10);
  const title = $('title').first().text().trim();
  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const desc = ($('meta[name="description"]').attr('content') || '').replace(/\s+/g, ' ').trim();
  const meta = (p) => !!$(`meta[property="${p}"],meta[name="${p}"]`).attr('content');
  $('script,style,noscript,svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  const imgs = $('img').toArray();
  const noAlt = imgs.filter((i) => $(i).attr('alt') === undefined).length;
  const anchors = $('a').toArray().map((a) => ({ text: $(a).text().replace(/\s+/g, ' ').trim(), href: $(a).attr('href') || '' }));
  const buttons = $('button').toArray().map((b) => $(b).text().trim());
  const ctaText = [...anchors.map((a) => a.text), ...buttons].join(' | ');
  const absHost = (href) => { try { return hostOf(new URL(href, finalUrl).href); } catch { return ''; } };
  const offsite = anchors.filter((a) => {
    const h = absHost(a.href);
    if (!h || h === siteHost) return false;
    return OFFSITE.test(a.href) || /\border\b.*\b(online|now|pickup|delivery)\b|\bonline order/i.test(a.text);
  });
  const social = anchors.filter((a) => SOCIAL.test(a.href));
  const platforms = [...new Set(anchors.filter((a) => OFFSITE.test(a.href) && absHost(a.href) !== siteHost).map((a) => absHost(a.href)))].slice(0, 6);
  const phoneDigits = (ctx.phone || '').replace(/\D/g, '').slice(-7);
  const hasTel = anchors.some((a) => a.href.startsWith('tel:')) || (phoneDigits && text.replace(/\D/g, '').includes(phoneDigits));
  const street = norm(ctx.street || '').split(' ');
  const addrOk = street.length > 1 && norm(text).includes(street[0]) && street.slice(1, 3).some((w) => w.length > 3 && norm(text).includes(w));
  const hoursOk = /(mon|tue|wed|thu|fri|sat|sun)[a-z]*[^.]{0,60}\d{1,2}(:\d{2})?\s?(am|pm|a\.m|p\.m)|opening hours|hours of operation|open (daily|\d)/i.test(text);
  const reviewsOk = /testimonial|what (our )?(guests|customers|diners) (are )?say|customer reviews|★|⭐/i.test(text) || $('[class*="testimonial"],[class*="review"]').length >= 3;
  const kwCount = text ? (norm(text).match(new RegExp(`\\b${ctx.kw}`, 'g')) || []).length : 0;
  return {
    host: siteHost, siteImages, platforms, title, h1, desc, descLen: desc.length, words, imgs: imgs.length, noAlt,
    og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image') },
    twitter: meta('twitter:card'),
    favicon: false,
    viewport: /width\s*=\s*device-width/i.test($('meta[name="viewport"]').attr('content') || ''),
    hasTel, addrOk, hoursOk, reviewsOk, kwCount,
    social: social.length,
    about: /about( us)?|our story|who we are|our history/i.test([...$('nav a,header a,h1,h2,h3').toArray().map((e) => $(e).text())].join(' | ') + ' ' + anchors.map((a) => a.text).join(' | ')),
    faq: /\bfaq\b|frequently asked/i.test(text + ' ' + ctaText),
    ctaOrder: /order|reserve|book (a )?table|reservation/i.test(ctaText),
    offsite: offsite.slice(0, 3).map((a) => ({ text: a.text, host: absHost(a.href) })),
    benefits: /(order direct|skip the (middleman|fees|apps)|no (service )?fees|direct order|save (on )?(fees|commission))/i.test(text),
  };
}

// favicon needs raw html (head), separate cheap test
const hasFavicon = (html) => /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(html);

// ---------- PageSpeed ----------
async function pagespeed(url, timeoutMs = 75000) {
  if (!PSI_KEY) return null;
  const u = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=accessibility&key=${PSI_KEY}`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    const a = j.lighthouseResult.audits;
    const fmt = (k) => (a[k]?.displayValue || '').replace(/\u00a0/g, ' ');
    return {
      score: Math.round((j.lighthouseResult.categories.performance.score ?? 0) * 100),
      lcp: fmt('largest-contentful-paint'), lcpMs: a['largest-contentful-paint']?.numericValue,
      fcp: fmt('first-contentful-paint'), si: fmt('speed-index'), tbt: fmt('total-blocking-time'), cls: a['cumulative-layout-shift']?.displayValue,
      contrast: a['color-contrast'] ? a['color-contrast'].score === 1 : null,
    };
  } catch (e) {
    return { error: /timeout|aborted/i.test(e.message) ? 'The speed test took too long and was skipped.' : redact(e.message) };
  }
}

// ---------- scoring ----------
const P = 'pass', F = 'fail', N = 'na', H = 'partial';
const round1 = (n) => Math.round(n * 10) / 10;
/** frac: null = not checked, true/1 = full credit, false/0 = none, 0<frac<1 = partial credit. */
const chk = (group, name, weight, frac, passNote, failNote, partialNote) => {
  if (frac === null) return { group, name, weight, status: N, earned: 0, note: failNote };
  const f = frac === true ? 1 : frac === false ? 0 : Math.max(0, Math.min(1, frac));
  const status = f >= 1 ? P : f <= 0 ? F : H;
  return { group, name, weight, status, earned: round1(weight * f), note: status === P ? passNote : status === H ? (partialNote || failNote) : failNote };
};

function buildChecks(d, ctx, site, siteRead, speed, domainOk, extra) {
  const noSite = !d.websiteUri;
  const unread = !noSite && !siteRead;
  const W = (group, name, weight, fn, pass, fail, partial) => {
    if (noSite) return chk(group, name, weight, false, '', 'No website listed on Google, so there is nothing for Google or guests to find.');
    if (unread) return chk(group, name, weight, null, '', 'We could not read this website, so this check was skipped.');
    return chk(group, name, weight, fn(), pass, fail, partial);
  };
  const s = site || { host: '', title: '', h1: '', desc: '', descLen: 0, words: 0, imgs: 0, noAlt: 0, og: {}, social: 0, offsite: [], kwCount: 0 };
  const area = ctx.areas;
  const kwOk = (t) => has(t, [ctx.kw, ctx.phrase].filter((x) => x && x !== 'restaurant'));
  const { crawl: cr, menu, structured } = extra;
  const og = s.og || {};
  const tags = [['Open Graph title', og.title], ['Open Graph description', og.description], ['Open Graph image', og.image], ['Twitter card', s.twitter]];
  const missingTags = tags.filter(([, v]) => !v).map(([n]) => n);
  const descFrac = s.descLen >= 70 && s.descLen <= 165 ? 1 : (s.descLen >= 40 && s.descLen < 70) || (s.descLen > 165 && s.descLen <= 220) ? 0.5 : 0;
  const search = [
    W('Page title', 'Includes service area', 4, () => has(s.title, area), 'Your area is in the title.', 'Your area is not in the page title.'),
    W('Page title', 'Matches Google Business Profile name', 3, () => nameMatches(s.title, ctx.name), `“${s.title}”`, s.title ? `The page title (“${s.title}”) doesn't contain “${ctx.name}”.` : 'The homepage has no page title, so Google can\'t see your restaurant name there.'),
    W('Page title', 'Includes a keyword', 3, () => kwOk(s.title), 'A cuisine keyword is in the title.', 'No cuisine keyword in the page title.'),
    W('Headline (H1)', 'H1 exists', 1, () => !!s.h1, `“${s.h1}”`, 'No main headline (H1) found on the homepage.'),
    W('Headline (H1)', 'H1 includes service area', 2, () => has(s.h1, area), 'Your area is in the headline.', `Add your area (e.g. “${ctx.hood || 'Toronto'}”) to the headline so Google knows where you are.`),
    W('Headline (H1)', 'H1 includes keywords', 2, () => kwOk(s.h1), 'A cuisine keyword is in the headline.', `No cuisine keyword (e.g. “${ctx.label || 'restaurant'}”) in the headline.`),
    W('Metadata', 'Description length', 2, () => descFrac, `${s.descLen} characters.`, s.descLen ? `${s.descLen} characters. Google shows about 155–160, so it gets cut off.` : 'No meta description.', `${s.descLen} characters. Close, but the ideal is 70–165.`),
    W('Metadata', 'Description includes service area', 1, () => has(s.desc, area), 'Mentions your area.', 'Your area is not in the description.'),
    W('Metadata', 'Description includes keywords', 2, () => kwOk(s.desc), 'Mentions your cuisine.', `No “${ctx.kw}”-type keyword in the description.`),
    W('Metadata', 'Images have alt tags', 2, () => (s.imgs ? 1 - s.noAlt / s.imgs : 1), s.imgs ? 'Every image has an alt attribute.' : 'No images found.', `${s.noAlt} of ${s.imgs} images have no alt attribute.`, `${s.noAlt} of ${s.imgs} images have no alt attribute.`),
    W('Metadata', 'Restaurant structured data', 3, () => structured?.restaurant, `Tells Google this is a restaurant (${structured?.types?.slice(0, 3).join(', ')}).`, 'No restaurant structured data (schema.org), so Google gets fewer clues about your hours, menu and location.'),
    W('Metadata', 'Social sharing tags', 2, () => 1 - missingTags.length / 4, 'All four sharing tags are present.', 'Missing: ' + missingTags.join(', ') + '. Shared links look plain on Facebook and in messages.', 'Missing: ' + missingTags.join(', ') + '.'),
    W('Domain', 'Custom domain', 1, () => !BUILDER.test(s.host), `${s.host} is a real custom domain.`, `${s.host} is a free builder or social address.`),
    W('Domain', 'Single domain', 2, () => domainOk, 'http, https and www versions all end up on one address.', 'Different versions of the address land on different sites, which splits your Google authority.'),
  ];
  const sp = speed && !speed.error ? speed : null;
  const crawlOk = cr && cr.crawled >= 0;
  const brokenCount = crawlOk ? cr.broken.length + cr.brokenImages.length + (cr.mixed ? 1 : 0) : 0;
  const issues = crawlOk ? [cr.broken.length && `${cr.broken.length} broken page${cr.broken.length > 1 ? 's' : ''}`, cr.brokenImages.length && `${cr.brokenImages.length} broken image${cr.brokenImages.length > 1 ? 's' : ''}`, cr.mixed && `${cr.mixed} insecure (http) resources on a secure page`].filter(Boolean).join(', ') + '.' : 'Could not crawl the site.';
  const guest = [
    sp ? chk('Usability', 'Fast site speed', 4, sp.lcpMs <= 2500 ? 1 : sp.lcpMs <= 4000 ? 0.5 : 0, `Main content appears in ${sp.lcp}.`, `Google PageSpeed gives the mobile site ${sp.score}/100. Main content takes ${sp.lcp} (Google wants under 2.5s).`, `Main content takes ${sp.lcp}. Close: Google wants under 2.5s (${sp.score}/100 on mobile).`)
      : noSite ? chk('Usability', 'Fast site speed', 4, false, '', 'No website to test.') : chk('Usability', 'Fast site speed', 4, null, '', 'Speed test was unavailable.'),
    W('Usability', 'Mobile-friendly', 3, () => s.viewport, 'Has a mobile viewport tag.', 'No mobile viewport tag. The site may be hard to use on phones.'),
    W('Usability', 'Nothing broken on the site', 3, () => (crawlOk ? (brokenCount === 0 ? 1 : brokenCount <= 2 ? 0.5 : 0) : null),
      crawlOk ? `Checked ${cr.crawled} pages and ${cr.imagesChecked} images. No broken links or images.` : '', crawlOk ? issues : 'Could not crawl the site.', crawlOk ? issues : ''),
    W('Content', 'No off-site ordering', 3, () => !s.offsite.length, 'No links sending guests to an outside ordering site.', `“${s.offsite[0]?.text}” sends guests to ${s.offsite[0]?.host}, an outside ordering site that costs you direct revenue.`),
    W('Content', 'Ordering CTA', 3, () => s.ctaOrder, 'An order or reserve button was found.', 'No order or reservation button found.'),
    W('Content', 'Enough text content', 2, () => (s.words >= 250 ? 1 : s.words >= 120 ? 0.5 : 0), `About ${s.words} words on the homepage.`, `Only about ${s.words} words. Google needs more to understand your business.`, `About ${s.words} words. Aim for 250 or more.`),
    W('Content', 'Phone number', 2, () => s.hasTel, 'Phone number is on the site.', 'Your phone number is not on the homepage.'),
    W('Content', 'Favicon', 1, () => s.favicon, 'Present.', 'No favicon.'),
    W('Content', 'Social media links', 2, () => s.social > 0, `${s.social} social links.`, 'No social media links.'),
    W('Content', 'Operating hours on homepage', 3, () => s.hoursOk, 'Hours are shown on the homepage.', 'Your homepage doesn\'t show your hours.'),
    W('Content', 'Address on site', 2, () => s.addrOk, 'Address is on the site.', 'Your address is not on the homepage.'),
    W('Content', 'Page content includes keywords', 2, () => s.kwCount >= 2, `“${ctx.kw}” appears ${s.kwCount} times.`, `“${ctx.kw}” appears ${s.kwCount} time(s) in your page text.`),
    W('Content', 'Menu readable as text', 2, () => (menu ? menu.kind === 'text' : null),
      menu?.where === 'homepage' ? 'Menu items and prices are on the homepage.' : 'Your menu is real text that Google can read.',
      !menu ? 'Could not check.' : { none: 'No menu found on the site.', pdf: 'Your menu is a PDF, which is hard to read on phones and for Google.', image: 'Your menu looks like pictures, which Google can\'t read.', external: 'Your menu lives on another website.', thin: 'The menu page has very little text.', unknown: 'We found a menu link but couldn\'t read it.' }[menu.kind] || 'Menu is not readable text.'),
    W('Content', 'About us section', 2, () => s.about, 'Has an About or Our Story section.', 'No About section found.'),
    W('Content', 'FAQ section', 1, () => s.faq, 'Has an FAQ.', 'No FAQ.'),
    W('Content', '3+ customer reviews on site', 2, () => s.reviewsOk, 'Reviews or testimonials appear on the site.', 'No customer reviews or testimonials on the homepage.'),
    W('Content', 'Direct-ordering benefits', 2, () => s.benefits, 'Tells guests why ordering direct is better.', 'Nothing tells guests why ordering direct is better.'),
    sp && sp.contrast !== null ? chk('Appearance', 'Text contrast', 1, sp.contrast, 'Text colours have enough contrast.', 'Some text has too little contrast against its background (flagged by Google).')
      : chk('Appearance', 'Text contrast', 1, noSite ? false : null, '', noSite ? 'No website to test.' : 'Could not be tested.'),
    chk('Appearance', 'Readable text size', 0, null, '', 'Not tested yet.'),
  ];
  const kwWeb = site && has([s.title, s.h1, s.desc].join(' '), [ctx.kw, ctx.phrase].filter((x) => x && x !== 'restaurant'));
  const svc = ['dineIn', 'takeout', 'delivery', 'reservable'].filter((k) => d[k]);
  const r = d.rating ?? 0, n = d.userRatingCount ?? 0;
  const revFrac = r >= 4.5 && n >= 200 ? 1 : r >= 4.0 && n >= 30 ? 2 / 3 : r >= 3.5 && n >= 10 ? 1 / 3 : 0;
  const local = [
    chk('Google Business Profile', 'Website linked', 3, !noSite, `${d.websiteUri}`, 'No website is linked on your Google profile.'),
    chk('Profile content', 'Description', 3, !!d.editorialSummary?.text, `Google shows: “${d.editorialSummary?.text}” (Google's own summary, may not be owner-written).`, 'Your profile has no description.'),
    chk('Profile content', 'Business hours', 3, !!d.regularOpeningHours, 'Hours are listed.', 'No hours listed. Customers don\'t know when to show up.'),
    chk('Profile content', 'Phone number', 2, !!d.nationalPhoneNumber, d.nationalPhoneNumber, 'No phone number listed.'),
    chk('Profile content', 'Price range', 2, !!(d.priceRange || d.priceLevel), d.priceRange ? `$${d.priceRange.startPrice?.units}–${d.priceRange.endPrice?.units || '+'} ${d.priceRange.startPrice?.currencyCode}` : String(d.priceLevel || '').replace('PRICE_LEVEL_', '').toLowerCase(), 'No price range listed.'),
    chk('Profile content', 'Service options', 2, svc.length > 0, `Offers: ${svc.join(', ').replace('dineIn', 'dine-in')}.`, 'No service options listed.'),
    chk('Profile content', 'Categories match keywords', 2, noSite || unread ? (noSite ? false : null) : !!kwWeb, `Primary category “${ctx.label}” also appears in your website title or headline.`, noSite ? 'No website to compare against.' : unread ? 'Could not read the website.' : `Your category “${ctx.label}” is not mentioned in the website title, headline or description.`),
    chk('Profile content', 'Social media links on profile', 0, null, '', 'Not available from Google\'s API.'),
    chk('Reviews', 'Review rating and volume', 3, revFrac, `${d.rating} stars from ${n.toLocaleString()} reviews.`, n ? `${d.rating} stars from ${n} reviews. Aim for 4.5+ with 200 or more.` : 'No Google reviews yet.', `${d.rating} stars from ${n.toLocaleString()} reviews. Good, but 4.5+ with 200+ reviews earns full marks.`),
  ];
  return { search, guest, local };
}

/** Reputation (10 pts): needs the review summary and web search, so it is added after those finish. */
function buildReputation(sentiment, mentions) {
  const sent = sentiment && !sentiment.skipped ? sentiment : null;
  const searchOk = mentions?.configured && !mentions.error;
  const blogs = searchOk ? mentions.articles.filter((a) => a.type === 'blog' || a.type === 'press').length : 0;
  const found = searchOk ? ['Yelp', 'TripAdvisor'].filter((p) => mentions.listings.some((l) => l.platform === p)) : [];
  return [
    chk('Reputation', 'Guest sentiment', 4, sent ? (sent.sentiment === 'positive' ? 1 : sent.sentiment === 'mixed' ? 0.5 : 0) : null,
      'Guests write positively about you.', sent?.sentiment === 'negative' ? 'Guests write mostly negative things about you.' : 'Not scored: ' + (sentiment?.skipped || 'review summary unavailable') + '.',
      'Guest comments are mixed. See what they praise and complain about below.'),
    chk('Reputation', 'Listed on Yelp and TripAdvisor', 3, searchOk ? found.length / 2 : null, 'Found on both Yelp and TripAdvisor.',
      searchOk ? 'Not found on Yelp or TripAdvisor in search results.' : 'Not scored: web search is unavailable.', `Found on ${found.join('')} only.`),
    chk('Reputation', 'Blog and press coverage', 3, searchOk ? (blogs >= 3 ? 1 : blogs >= 1 ? 0.5 : 0) : null, `${blogs} blog posts or press mentions found.`,
      searchOk ? 'No independent blog posts or press found.' : 'Not scored: web search is unavailable.', `${blogs} blog post or press mention found. Three or more earns full marks.`),
  ];
}

const sumBy = (l, f, v) => l.filter(f).reduce((a, c) => a + v(c), 0);
function sectionScore(list, max) {
  const possible = sumBy(list, (c) => c.status !== N, (c) => c.weight);
  const earned = round1(sumBy(list, (c) => c.status !== N, (c) => c.earned));
  if (!possible) return { earned: 0, possible: 0, max, score: null };
  return { earned, possible, max, score: Math.round((earned / possible) * max) };
}

export function computeScores(checks, { siteBlocked = false } = {}) {
  const sc = { search: sectionScore(checks.search, 30), guest: sectionScore(checks.guest, 40), local: sectionScore(checks.local, 30) };
  const earned = sc.search.earned + sc.guest.earned + sc.local.earned;
  const possible = sc.search.possible + sc.guest.possible + sc.local.possible;
  const overall = possible ? Math.round((earned / possible) * 100) : null;
  const all = [...checks.search, ...checks.guest, ...checks.local].filter((c) => c.status !== N);
  const coverage = possible / 100;
  return {
    ...sc, overall, grade: gradeOf(overall), reviewed: all.length, failing: all.filter((c) => c.status === F || c.status === H).length,
    coverage: Math.round(coverage * 100) / 100, incomplete: siteBlocked || coverage < 0.7,
    incompleteReason: siteBlocked ? 'We couldn\'t read the website, so only the Google profile and speed could be scored.' : coverage < 0.7 ? 'Fewer than 70% of the checks could be run.' : null,
  };
}

/** Everything about one restaurant's own presence: Google profile, website, speed, crawl, scores. */
async function scoreCore(d, { crawlMax = 12, lite = false, psiTimeout = 75000, track = (id, label, p) => p, onImages = () => {}, onAudit = null, onSite = null } = {}) {
  const kwi = keywordInfo(d);
  const ar = areasOf(d);
  const ctx = { name: (d.displayName?.text || '').replace(/[‍​]/g, '').trim(), ...kwi, ...ar, phone: d.nationalPhoneNumber, street: (d.formattedAddress || '').split(',')[0] };
  const notes = [];
  let site = null, siteRead = false, domainOk = false, siteMs = null, siteStatus = null, speed = null;
  const extra = { crawl: null, menu: null, structured: null };
  // Tell the caller as soon as the website audit is done, before the slow speed test finishes.
  let siteFired = false;
  const fireSite = (x) => { if (!siteFired) { siteFired = true; onSite?.(x); } };
  const fireEarly = () => onAudit?.({ site, checks: buildChecks(d, ctx, site, siteRead, null, domainOk, extra) });
  if (d.websiteUri) {
    const pagePromise = track('site', 'Reading the website', fetchPage(d.websiteUri));
    const speedPromise = track('speed', 'Running Google PageSpeed', pagespeed(d.websiteUri, psiTimeout));
    const page = await pagePromise;
    siteStatus = page.status; siteMs = page.ms;
    if (page.ok && page.html) {
      siteRead = true;
      site = auditHtml(page.html, page.finalUrl, ctx);
      site.favicon = hasFavicon(page.html);
      fireSite(site);
      onImages(site.siteImages);
      extra.structured = structuredData(page.html);
      const [dom, cr, menu] = await Promise.all([
        singleDomain(page.finalUrl),
        lite ? null : track('crawl', 'Looking for broken pages and links', crawl(page.finalUrl, page.html, { max: crawlMax }).catch(() => null)),
        checkMenu(page.finalUrl, page.html).catch(() => null),
      ]);
      domainOk = dom; extra.crawl = cr; extra.menu = menu;
    } else { notes.push(`We couldn't read ${hostOf(d.websiteUri)} (${page.status ? 'HTTP ' + page.status : page.error}). The website's own checks were skipped.`); fireSite(null); }
    fireEarly();
    speed = await speedPromise;
    if (speed?.error) notes.push('The Google PageSpeed test failed: ' + speed.error);
  } else { notes.push('This restaurant has no website listed on Google.'); fireSite(null); fireEarly(); }

  const checks = buildChecks(d, ctx, site, siteRead, speed, domainOk, extra);
  const scores = computeScores(checks, { siteBlocked: !!d.websiteUri && !siteRead });
  return { ctx, notes, site, siteRead, siteMs, siteStatus, speed, extra, checks, scores };
}

// ---------- competitors & rankings ----------
async function nearby(d) {
  const type = d.primaryType || 'restaurant';
  const body = (t) => ({ includedTypes: [t], maxResultCount: 10, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude: d.location.latitude, longitude: d.location.longitude }, radius: 5000 } } });
  const mask = 'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.formattedAddress';
  let j;
  try { j = await places('places:searchNearby', { body: body(type), mask }); } catch { j = await places('places:searchNearby', { body: body('restaurant'), mask }); }
  return (j.places || []).map((p) => ({ id: p.id, name: (p.displayName?.text || '').trim(), rating: p.rating ?? null, reviews: p.userRatingCount ?? 0, website: !!p.websiteUri, address: p.formattedAddress, self: p.id === d.id }));
}

const compMask = 'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.formattedAddress';
const toComp = (d) => (p) => ({ id: p.id, name: (p.displayName?.text || '').trim(), rating: p.rating ?? null, reviews: p.userRatingCount ?? 0, website: !!p.websiteUri, address: p.formattedAddress, self: p.id === d.id });

/** Nearby competitors, making sure same-cuisine restaurants are included (e.g. other South Indian places for a South Indian restaurant). */
async function findCompetitors(d, cuisine) {
  const me = { id: d.id, name: (d.displayName?.text || '').trim(), rating: d.rating ?? null, reviews: d.userRatingCount ?? 0, website: !!d.websiteUri, address: d.formattedAddress, self: true };
  const base = (await nearby(d).catch(() => [])).filter((c) => !c.self);
  let same = [];
  if (cuisine) {
    try {
      const j = await places('places:searchText', {
        body: { textQuery: `${cuisine.term} restaurant`, pageSize: 12, locationBias: { circle: { center: { latitude: d.location.latitude, longitude: d.location.longitude }, radius: 10000 } } },
        mask: compMask,
      });
      same = (j.places || []).map(toComp(d)).filter((c) => !c.self && c.reviews >= 5);
    } catch { /* fall back to the nearby list only */ }
  }
  const chosen = [me];
  const have = new Set([d.id]);
  const add = (c, flag) => { if (!have.has(c.id) && chosen.length < 10) { have.add(c.id); chosen.push({ ...c, cuisine: flag }); } };
  same.slice(0, 4).forEach((c) => add(c, true));
  const sameIds = new Set(same.map((c) => c.id));
  base.forEach((c) => add(c, sameIds.has(c.id)));
  return chosen;
}

async function rankings(d, ctx, cuisine) {
  const k = cuisine ? cuisine.label.toLowerCase() + ' ' : ctx.generic ? '' : ctx.kw + ' ';
  const qk = cuisine ? cuisine.term.toLowerCase() + ' ' : k;
  const queries = [];
  if (ctx.hood) queries.push({ label: `Best ${k}restaurant in ${ctx.hood}`, q: `best ${qk}restaurant in ${ctx.hood}, ${ctx.city}` });
  if (ctx.city && ctx.city !== ctx.hood) queries.push({ label: `Best ${k}restaurant in ${ctx.city}`, q: `best ${qk}restaurant in ${ctx.city}` });
  queries.push({ label: `${k.trim() ? k : ''}restaurants within 2 km`.replace(/^./, (c) => c.toUpperCase()), q: `${qk}restaurant`, near: true });
  const out = [];
  for (const { label, q, near } of queries) {
    const body = { textQuery: q, pageSize: 20 };
    if (near) body.locationBias = { circle: { center: { latitude: d.location.latitude, longitude: d.location.longitude }, radius: 2000 } };
    try {
      const j = await places('places:searchText', { body, mask: 'places.id,places.displayName' });
      const ids = (j.places || []).map((p) => p.id);
      const i = ids.indexOf(d.id);
      out.push({ label, rank: i >= 0 ? i + 1 : null, of: ids.length, top: (j.places?.[0]?.displayName?.text || '').trim() });
    } catch (e) { out.push({ label, rank: null, of: 0, top: '', error: redact(e.message) }); }
  }
  return out;
}

const COMP_TTL = 7 * 24 * 3600 * 1000;
const cmOf = (checks) => Object.fromEntries([...checks.search, ...checks.guest, ...checks.local].filter((x) => x.status !== N && x.weight > 0).map((x) => [x.name, [x.weight, x.earned]]));
const compKey = (id) => 'competitors/' + id.replace(/[^A-Za-z0-9_-]/g, '') + '.json';
const readComp = async (id) => { try { const j = await store.get(compKey(id)); return j && Date.now() - j.t < COMP_TTL ? j.v : null; } catch { return null; } };

/** A light audit of a competitor: Google profile + homepage checks + a capped speed test. No crawl. Cached for a week. */
async function auditCompetitor(c) {
  const cached = await readComp(c.id);
  if (cached) return cached;
  const d = await getDetails(c.id);
  const core = await scoreCore(d, { lite: true, psiTimeout: 25000 });
  const v = {
    placeId: c.id, name: core.ctx.name, rating: d.rating ?? null, reviews: d.userRatingCount ?? 0, website: !!d.websiteUri,
    incomplete: core.scores.incomplete,
    speed: core.speed && !core.speed.error ? core.speed.score : null, lcp: core.speed && !core.speed.error ? core.speed.lcp : null,
    checks: Object.fromEntries([...core.checks.search, ...core.checks.guest, ...core.checks.local].map((x) => [x.name, x.status])),
    cm: cmOf(core.checks),
  };
  await store.put(compKey(c.id), { t: Date.now(), v }).catch(() => {});
  return v;
}

/** Score two restaurants on only the checks that were run for both, so the comparison is fair. */
function benchPair(a, b) {
  let wa = 0, ea = 0, eb = 0;
  for (const k of Object.keys(a)) if (b[k]) { wa += a[k][0]; ea += a[k][1]; eb += b[k][1]; }
  return wa ? [Math.round((ea / wa) * 100), Math.round((eb / wa) * 100)] : [null, null];
}

function beatingYou(me, comps, ranks) {
  const mine = me.checkMap;
  const out = comps.map((c) => {
    const beats = [];
    if (c.reviews >= 100 && (c.rating ?? 0) >= (me.rating ?? 0) + 0.1) beats.push({ key: 'rating', text: `Higher Google rating (${c.rating} vs ${me.rating})` });
    if (c.reviews >= Math.max(30, me.reviews * 1.5)) beats.push({ key: 'reviews', text: `More Google reviews (${c.reviews.toLocaleString()} vs ${me.reviews.toLocaleString()})` });
    const [mb, cb] = benchPair(me.cm, c.cm);
    c.bench = cb;
    if (cb != null && !c.incomplete && !me.incomplete && cb >= mb + 5) beats.push({ key: 'score', text: `Stronger online score on the same checks (${cb} vs ${mb})` });
    if (c.speed != null && me.speed != null && c.speed >= me.speed + 10) beats.push({ key: 'speed', text: `Faster website (${c.speed} vs ${me.speed} on mobile)` });
    if (c.website && !me.website) beats.push({ key: 'website', text: 'Has a website, and you don\'t' });
    const reasons = [['No off-site ordering', 'orders direct on its own site'], ['Menu readable as text', 'has a menu Google can read'], ['Operating hours on homepage', 'shows its hours on the homepage'], ['3+ customer reviews on site', 'shows customer reviews on its site'], ['Restaurant structured data', 'tells Google it is a restaurant (structured data)'], ['Description', 'has a Google profile description']];
    for (const [name, text] of reasons) if (c.checks[name] === 'pass' && mine[name] === 'fail') beats.push({ key: name, text: `It ${text}` });
    for (const r of ranks) if (r.rank !== 1 && r.top && nameMatches(r.top, c.name) && nameMatches(c.name, r.top)) beats.push({ key: 'rank:' + r.label, text: `Ranks #1 for “${r.label}”` });
    const { cm, ...rest } = c;
    return { ...rest, bench: c.bench, beats: beats.slice(0, 5) };
  });
  const tally = {};
  for (const c of out) for (const b of c.beats) { const k = b.key.startsWith('rank:') ? 'rank' : b.key; tally[k] = (tally[k] || 0) + 1; }
  const label = { rating: 'a higher Google rating', reviews: 'more Google reviews', score: 'a stronger online score', speed: 'a faster website', website: 'a website', rank: 'a #1 map ranking', 'No off-site ordering': 'direct ordering on their own site', 'Menu readable as text': 'a readable text menu', 'Operating hours on homepage': 'hours on their homepage', '3+ customer reviews on site': 'reviews on their website', 'Restaurant structured data': 'restaurant structured data', Description: 'a Google profile description' };
  const summary = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${n} of ${out.length} have ${label[k] || k}`);
  const common = comps.length ? Object.keys(me.cm).filter((k) => comps.every((c) => c.cm[k])) : [];
  const benchMe = common.length ? Math.round((common.reduce((t, k) => t + me.cm[k][1], 0) / common.reduce((t, k) => t + me.cm[k][0], 0)) * 100) : null;
  return { competitors: out, summary, benchMe };
}

function positives(r, comps, ranks) {
  const out = [];
  const m = r.meta;
  if (m.rating >= 4.5) out.push(`Excellent Google rating: ${m.rating} stars`);
  else if (m.rating >= 4.0) out.push(`Solid Google rating: ${m.rating} stars`);
  if (m.reviews >= 500) out.push(`${m.reviews.toLocaleString()} Google reviews, which is strong social proof`);
  else if (m.reviews >= 100) out.push(`${m.reviews.toLocaleString()} Google reviews`);
  const rankedBy = comps.filter((c) => (c.reviews ?? 0) >= 30);
  const beaten = rankedBy.filter((c) => !c.self && weightedRating(c.rating, c.reviews) < weightedRating(m.rating, m.reviews)).length;
  if (beaten >= 2) out.push(`You out-rate ${beaten} nearby competitors`);
  const top = ranks.filter((k) => k.rank && k.rank <= 3);
  for (const k of top.slice(0, 2)) out.push(`#${k.rank} in Google Maps search for “${k.label}”`);
  const pass = [...r.checks.search, ...r.checks.guest, ...r.checks.local].filter((c) => c.status === P && c.weight >= 3).slice(0, 4);
  for (const c of pass) out.push(`${c.group}: ${c.name.charAt(0).toLowerCase() + c.name.slice(1)}`.replace(/^(.)/, (x) => x.toUpperCase()));
  if (r.speed && r.speed.lcpMs <= 2500) out.push('Fast website on phones');
  if (r.reviews?.sentiment?.sentiment === 'positive') out.push('Guests write positively about you');
  return [...new Set(out)].slice(0, 7);
}

// ---------- main ----------
export async function analyze({ placeId, name, address }, emit = () => {}) {
  const track = async (id, label, p) => {
    emit({ type: 'step', id, label, state: 'start' });
    try { return await p; } finally { emit({ type: 'step', id, label, state: 'done' }); }
  };
  emit({ type: 'step', id: 'find', label: 'Finding the restaurant on Google', state: 'start' });
  const id = placeId || (await findPlaceId(name, address));
  if (!id) throw new Error(`Couldn't find “${name}” on Google Maps.`);
  const d = await getDetails(id, FULL_MASK);
  emit({ type: 'step', id: 'find', label: 'Finding the restaurant on Google', state: 'done' });
  emit({ type: 'info', text: `Found ${(d.displayName?.text || '').trim()}` });
  const photos = (d.photos || []).slice(0, 8).map((p) => 'api/photo?name=' + encodeURIComponent(p.name));
  for (const p of photos) emit({ type: 'image', kind: 'google', src: p });

  const ctx0 = { name: (d.displayName?.text || '').trim(), city: areasOf(d).city };
  const revs = (d.reviews || []).map((r) => ({ author: r.authorAttribution?.displayName || 'A guest', rating: r.rating, text: r.text?.text || r.originalText?.text || '', when: r.relativePublishTimeDescription || '' }));

  let onSite;
  const siteP = new Promise((res) => { onSite = res; });
  let onAudit;
  const earlyAudit = new Promise((res) => { onAudit = res; });
  const corePromise = scoreCore(d, { crawlMax: 12, track, onAudit, onSite, onImages: (imgs) => imgs.forEach((src) => emit({ type: 'image', kind: 'site', src })) });
  const sentimentPromise = track('reviews', 'Reading Google reviews', reviewSentiment(revs, ctx0.name));
  const blogsPromise = track('blogs', 'Searching for blogs and listings', mentions({ name: ctx0.name, city: ctx0.city, website: d.websiteUri }));
  // Work out the specific cuisine (e.g. South Indian) once the homepage is read, then find competitors of that cuisine too.
  const cuisineP = (async () => {
    const st = await siteP;
    return detectCuisine({ name: ctx0.name, summary: d.editorialSummary?.text || '', siteText: [st?.title, st?.h1, st?.desc].filter(Boolean).join(' '), reviews: revs.map((r) => r.text).filter(Boolean) }).catch(() => null);
  })();
  const comp = await track('competitors', 'Finding nearby competitors', cuisineP.then((cu) => findCompetitors(d, cu)).catch(() => []));
  const cuisine = await cuisineP;
  const ctxPre = { ...keywordInfo(d), ...areasOf(d) };
  const rankPromise = track('rank', 'Checking where you show up in Google Maps', rankings(d, ctxPre, cuisine));
  // Audit five competitors: up to three of the same cuisine first, then the best-rated of the rest.
  const byStrength = (a, b) => weightedRating(b.rating, b.reviews) - weightedRating(a.rating, a.reviews);
  const sameTop = comp.filter((c) => !c.self && c.cuisine && c.reviews >= 10).sort(byStrength).slice(0, 3);
  const rest = comp.filter((c) => !c.self && !sameTop.includes(c) && c.reviews >= 30).sort(byStrength);
  const topFive = [...sameTop, ...rest].slice(0, 5);
  // Competitor audits are light, cached and capped at 40 seconds in total; anything slower is left out.
  const deadline = new Promise((res) => setTimeout(() => res(null), 40000));
  const auditsPromise = track('audit', `Auditing your top ${topFive.length} competitors`, Promise.all(topFive.map((c) => Promise.race([auditCompetitor(c).catch(() => null), deadline]))));
  // The AI blog analysis starts as soon as the website audit and blog search are done, while the speed test is still running.
  const failing = (checks) => [...checks.search, ...checks.guest, ...checks.local].filter((c) => c.status === F || c.status === H)
    .sort((a, b) => (b.weight - b.earned) - (a.weight - a.earned)).map((c) => `${c.name}: ${c.note}`.slice(0, 160));
  const coveragePromise = (async () => {
    const [bl, early] = await Promise.all([blogsPromise, earlyAudit]);
    if (!bl.configured || bl.error) return null;
    return track('coverage', 'Analysing what blogs say about you', analyzeCoverage({ name: ctx0.name, city: ctx0.city, category: cuisine?.label || keywordInfo(d).label, articles: bl.articles, directories: bl.directories, site: early.site, issues: failing(early.checks) }));
  })();
  const [core, sentiment, blogs] = await Promise.all([corePromise, sentimentPromise, blogsPromise]);
  core.checks.local = [...core.checks.local, ...buildReputation(sentiment, blogs)];
  core.scores = computeScores(core.checks, { siteBlocked: !!d.websiteUri && !core.siteRead });

  const [ranks, audits, analysis] = await Promise.all([rankPromise, auditsPromise, coveragePromise]);
  if (analysis) blogs.analysis = analysis;
  emit({ type: 'step', id: 'score', label: 'Scoring everything', state: 'start' });
  const m = {
    placeId: id, name: core.ctx.name, address: d.formattedAddress, phone: d.nationalPhoneNumber || null, website: d.websiteUri || null,
    mapsUri: d.googleMapsUri, reviewLink: `https://search.google.com/local/writereview?placeid=${id}`,
    rating: d.rating ?? null, reviews: d.userRatingCount ?? 0, category: core.ctx.label, cuisine: cuisine?.label || null, hood: core.ctx.hood, city: core.ctx.city, status: d.businessStatus,
    photo: photos[0] || null, photos, siteImages: core.site?.siteImages || [], priceRange: d.priceRange || null,
  };
  const compSorted = comp.map((c) => ({ ...c, strength: Math.round(weightedRating(c.rating, c.reviews) * 100) / 100, fewReviews: looksNew(c) })).sort((a, b) => b.strength - a.strength);
  const mine = { rating: m.rating, reviews: m.reviews, overall: core.scores.overall, incomplete: core.scores.incomplete, cm: cmOf(core.checks), website: !!d.websiteUri, speed: core.speed && !core.speed.error ? core.speed.score : null, checkMap: Object.fromEntries([...core.checks.search, ...core.checks.guest, ...core.checks.local].map((x) => [x.name, x.status])) };
  const bt = beatingYou(mine, audits.filter(Boolean), ranks);

  const rep = {
    version: 3,
    scannedAt: new Date().toISOString(),
    meta: m,
    scores: core.scores,
    checks: core.checks,
    speed: core.speed && !core.speed.error ? core.speed : null,
    website: core.site ? { title: core.site.title, h1: core.site.h1, descLen: core.site.descLen, words: core.site.words, status: core.siteStatus, loadMs: core.siteMs } : null,
    crawl: core.extra.crawl,
    menu: core.extra.menu,
    structured: core.extra.structured,
    platforms: core.site?.platforms || [],
    reviews: { items: revs, sentiment },
    mentions: blogs,
    competitors: compSorted,
    competitorAudits: bt.competitors,
    beatingYou: bt.summary,
    benchMe: bt.benchMe,
    rankings: ranks,
    notes: core.notes,
  };
  rep.estimate = estimateLoss({ score: core.scores.overall, reviews: m.reviews, priceRange: d.priceRange, priceLevel: d.priceLevel, problems: core.scores.failing });
  rep.positives = positives(rep, compSorted, ranks);
  emit({ type: 'step', id: 'score', label: 'Scoring everything', state: 'done' });
  return rep;
}
