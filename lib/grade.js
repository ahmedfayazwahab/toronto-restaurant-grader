import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'grades.json');
export function gradeCutoffs() {
  try { const g = JSON.parse(fs.readFileSync(file, 'utf8')); return { good: g.good, fair: g.fair }; } catch { return { good: 80, fair: 60 }; }
}
/** overall is 0..100 */
export function gradeOf(overall, cut = gradeCutoffs()) {
  if (overall == null) return null;
  return overall >= cut.good ? 'Good' : overall >= cut.fair ? 'Fair' : 'Poor';
}
