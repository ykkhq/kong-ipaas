import { createHash } from 'node:crypto';

const NAMESPACE = '8f6a8c3e-0c9b-4a52-9d1e-6f3b1d2c7a10';

/** RFC 4122 v5 UUID, so Kong entity ids are stable per flow and PUT upserts idempotently. */
export function uuidv5(name: string, namespace = NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
