// Local development server: node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import * as store from './lib/store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// First run after upgrading: build the "recent reports" list from reports already on disk.
if (!store.usingS3 && !(await store.get('recent.json'))) {
  const dir = path.join(root, 'data', 'reports');
  const rows = [], seen = new Set();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (c.version !== 3 || seen.has(c.meta.placeId)) continue;
      seen.add(c.meta.placeId);
      rows.push({ placeId: c.meta.placeId, name: c.meta.name, rating: c.meta.rating, overall: c.scores.overall, incomplete: !!c.scores.incomplete, at: c.scannedAt });
    } catch { /* skip unreadable file */ }
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  await store.put('recent.json', rows.slice(0, 10));
}

const app = createApp({ serveStatic: true });
http.createServer((req, res) => app.handle(req, res)).listen(PORT, () => console.log(`Restaurant Health Grader running at http://localhost:${PORT}`));
