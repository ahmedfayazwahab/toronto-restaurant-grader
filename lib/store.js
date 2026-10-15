// Tiny JSON key-value store. Local files by default; an S3 bucket when DATA_BUCKET is set (AWS).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from './env.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const BUCKET = ENV.DATA_BUCKET || '';
let s3;
async function client() {
  if (!s3) { const m = await import('@aws-sdk/client-s3'); s3 = { c: new m.S3Client({}), m }; }
  return s3;
}
const safeKey = (k) => k.split('/').map((p) => p.replace(/\.\./g, '').replace(/[^A-Za-z0-9_.-]/g, '')).filter(Boolean).join('/');

export async function get(key) {
  key = safeKey(key);
  if (BUCKET) {
    try {
      const { c, m } = await client();
      const r = await c.send(new m.GetObjectCommand({ Bucket: BUCKET, Key: key }));
      return JSON.parse(await r.Body.transformToString());
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, key), 'utf8')); } catch { return null; }
}

export async function put(key, value) {
  key = safeKey(key);
  const body = JSON.stringify(value);
  if (BUCKET) {
    const { c, m } = await client();
    await c.send(new m.PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
    return;
  }
  const file = path.join(dataDir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

export const usingS3 = !!BUCKET;
