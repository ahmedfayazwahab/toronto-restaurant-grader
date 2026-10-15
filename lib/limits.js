// Usage limits that protect the API budgets. Counters live in memory locally and in DynamoDB on AWS.
// Visitor IPs are never stored: only a one-way hash, which expires after two days.
import crypto from 'node:crypto';
import { ENV } from './env.js';

const TABLE = ENV.COUNTER_TABLE || '';
const mem = new Map();
const day = () => new Date().toISOString().slice(0, 10);
const hash = (ip) => crypto.createHash('sha256').update((ENV.ORIGIN_SECRET || 'local') + '|' + ip).digest('hex').slice(0, 24);
let ddb;

async function bump(pk, by = 1) {
  if (TABLE) {
    if (!ddb) { const m = await import('@aws-sdk/client-dynamodb'); ddb = { c: new m.DynamoDBClient({}), m }; }
    const r = await ddb.c.send(new ddb.m.UpdateItemCommand({
      TableName: TABLE, Key: { pk: { S: pk } },
      UpdateExpression: 'ADD #c :one SET #t = :ttl',
      ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
      ExpressionAttributeValues: { ':one': { N: String(by) }, ':ttl': { N: String(Math.floor(Date.now() / 1000) + 2 * 86400) } },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(r.Attributes.count.N);
  }
  const n = Math.max(0, (mem.get(pk) || 0) + by);
  mem.set(pk, n);
  return n;
}

export const limits = () => ({
  perIpPerDay: +ENV.LIMIT_SCANS_PER_IP_PER_DAY || 8,
  perDay: +ENV.LIMIT_SCANS_PER_DAY || 80,
});

const tooMany = (msg) => Object.assign(new Error(msg), { code: 429 });

/** Call before starting a NEW scan (cached reports are free to view). Throws a 429 when over a limit. */
export async function checkScan(ip) {
  const d = day(), L = limits();
  const mine = await bump(`scan#${d}#ip#${hash(ip)}`);
  if (mine > L.perIpPerDay) throw tooMany(`You've reached today's limit of ${L.perIpPerDay} new scans. Reports that were already scanned are still available, and the limit resets tomorrow.`);
  const all = await bump(`scan#${d}#all`);
  if (all > L.perDay) throw tooMany('This free beta has reached its daily scan limit. Reports that were already scanned are still available. Please try again tomorrow.');
}

/** Give the allowance back when a scan fails before producing a report (the visitor shouldn't pay for our errors). */
export async function refundScan(ip) {
  const d = day();
  await Promise.all([bump(`scan#${d}#ip#${hash(ip)}`, -1), bump(`scan#${d}#all`, -1)]);
}

// Light per-instance limit for cheap endpoints (search, photos).
const soft = new Map();
export function softLimit(ip, bucket, max, windowMs = 3600_000) {
  const k = bucket + '|' + hash(ip), now = Date.now();
  const e = soft.get(k);
  if (!e || now - e.t > windowMs) { soft.set(k, { t: now, n: 1 }); if (soft.size > 5000) soft.clear(); return true; }
  return ++e.n <= max;
}
