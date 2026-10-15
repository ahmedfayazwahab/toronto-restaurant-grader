import { ENV, redact } from './env.js';

// Where the restaurant has a profile (shown as chips).
const LISTING = { 'yelp.': 'Yelp', 'tripadvisor.': 'TripAdvisor', 'opentable.': 'OpenTable', 'ubereats.': 'Uber Eats', 'doordash.': 'DoorDash', 'skipthedishes.': 'SkipTheDishes', 'restaurantguru.': 'Restaurant Guru', 'facebook.': 'Facebook', 'instagram.': 'Instagram', 'yellowpages.': 'Yellow Pages', 'foursquare.': 'Foursquare', 'mapquest.': 'MapQuest', 'zomato.': 'Zomato' };
// Pages that list lots of businesses: useful for consistency, but not editorial coverage.
const DIRECTORY = /(mindtrip|tagvenue|weddingwire|wheree|eventsource|tableagent|wanderlog|sirved|menupix|allmenus|restaurantji|opentable|cylex|brownbook|hotfrog|canpages|411\.ca|mapcarta|alltrails|tripadvisor|yelp|bark\.com|peerspace|giggster|venuelook|thumbtack|bing\.com|apple\.com\/maps|chamberofcommerce|yellowbook|find-open|foodspotting|menuism|eatstreet|menuwithprice|superpages|trustpilot|birdeye|wanderboat|menu-res|restaurantguru|menupages|zmenu|sluurpy|foodie\.fm|opendi|tupalo|infobel|wherevent|evendo|yably|meemup)/i;
const PRESS_DOMAINS = ['blogto.com', 'torontolife.com', 'narcity.com', 'dailyhive.com', 'eater.com', 'theinfatuation.com', 'thestar.com', 'nowtoronto.com', 'globalnews.ca', 'cbc.ca', 'ctvnews.ca', 'citynews.ca', 'torontoist.com', 'thekit.ca', 'streetsoftoronto.com', 'toronto.com', 'torontosun.com', 'macleans.ca', 'guide.michelin.com', 'enroute.aircanada.com', 'postcity.com', 'todocanada.ca'];
const PRESS = { test: (h) => PRESS_DOMAINS.some((d) => h === d || h.endsWith('.' + d)) };
const BLOGHOST = /(blogspot|wordpress|medium\.com|substack|tumblr|wixsite|squarespace|ghost\.io|blog\.|\.blog)/i;
const SKIP = /google\.|youtube\.|wikipedia\.|pinterest\.|linkedin\.|tiktok\.|twitter\.|x\.com\/|reddit\.com\/search/i;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function brave(q, count = 15) {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}&country=ca`, { headers: { 'X-Subscription-Token': ENV.BRAVE_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Brave Search ${r.status}: ${j.error?.detail || j.message || 'request failed'}`);
  return (j.web?.results || []).map((x) => ({ title: (x.title || '').replace(/<[^>]+>/g, ''), url: x.url, snippet: (x.description || '').replace(/<[^>]+>/g, ''), date: x.page_age || null, age: x.age || null }));
}
async function googleCse(q, count = 10) {
  const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${ENV.GOOGLE_API_KEY}&cx=${ENV.GOOGLE_CSE_ID}&q=${encodeURIComponent(q)}&num=${count}`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Custom Search ${r.status}: ${j.error?.message || 'request failed'}`);
  return (j.items || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '', date: x.pagemap?.metatags?.[0]?.['article:published_time'] || null, age: null }));
}

const nk = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const prettyDate = (d, age) => {
  if (d) { const t = Date.parse(d); if (!Number.isNaN(t)) return new Date(t).toLocaleDateString('en-CA', { year: 'numeric', month: 'short' }); }
  return age || null;
};

/** Blog posts, press, directories and third-party listings that mention the restaurant. */
export async function mentions({ name, city, website }) {
  const provider = ENV.BRAVE_API_KEY ? 'Brave Search' : ENV.GOOGLE_CSE_ID ? 'Google Custom Search' : null;
  if (!provider) return { configured: false, note: 'Add BRAVE_API_KEY (or GOOGLE_CSE_ID) to .env to find blog posts and listings.' };
  const run = ENV.BRAVE_API_KEY ? brave : googleCse;
  try {
    const own = hostOf(website || '');
    const q = (s) => run(s, 15).catch(() => []);
    const results = await Promise.all([
      q(`"${name}" ${city} blog`),
      q(`"${name}" ${city} "we ate" OR "our visit" OR "I tried" OR "food blog"`),
      q(`"${name}" ${city} review -yelp -tripadvisor`),
      q(`"${name}" ${city} yelp OR tripadvisor OR opentable OR restaurantguru`),
    ]);
    if (results.every((r) => !r.length)) throw new Error('The search returned nothing. Check the key and quota.');
    const key = nk(name).slice(0, 12);
    const seen = new Set();
    const articles = [], directories = [], listings = [];
    for (const x of results.flat()) {
      const h = hostOf(x.url);
      if (!h || seen.has(x.url) || h === own || SKIP.test(x.url)) continue;
      seen.add(x.url);
      const plat = Object.entries(LISTING).find(([k]) => h.includes(k));
      if (plat) { if (!listings.some((l) => l.platform === plat[1])) listings.push({ platform: plat[1], url: x.url, title: x.title }); continue; }
      // Only keep pages that are actually about this restaurant.
      const about = nk(`${x.title} ${x.snippet} ${x.url}`).includes(key);
      if (!about) continue;
      const entry = { title: x.title, url: x.url, host: h, snippet: x.snippet.slice(0, 220), when: prettyDate(x.date, x.age) };
      if (DIRECTORY.test(h)) { if (directories.length < 6) directories.push(entry); continue; }
      entry.type = PRESS.test(h) ? 'press' : BLOGHOST.test(h) || /\/(blog|post|posts|20\d\d)\//i.test(x.url) ? 'blog' : 'article';
      articles.push(entry);
    }
    const rank = { blog: 0, press: 1, article: 2 };
    articles.sort((a, b) => rank[a.type] - rank[b.type]);
    return { configured: true, provider, articles: articles.slice(0, 10), directories, listings };
  } catch (e) {
    return { configured: true, provider, error: redact(e.message), articles: [], directories: [], listings: [] };
  }
}
