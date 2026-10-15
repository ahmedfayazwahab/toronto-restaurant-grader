import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENV = { ...process.env };
for (const p of [path.join(here, '..', '.env'), path.join(here, '..', '..', '.env')]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !(m[1] in ENV && ENV[m[1]])) ENV[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const SECRETS = ['GOOGLE_API_KEY', 'PAGESPEED_API_KEY', 'OPENAI_API_KEY', 'BRAVE_API_KEY'].map((k) => ENV[k]).filter(Boolean);
export function redact(s) {
  let out = String(s);
  for (const k of SECRETS) out = out.split(k).join('[key]');
  return out.replace(/AIza[A-Za-z0-9_-]{20,}/g, '[key]').replace(/sk-[A-Za-z0-9_-]{20,}/g, '[key]');
}
