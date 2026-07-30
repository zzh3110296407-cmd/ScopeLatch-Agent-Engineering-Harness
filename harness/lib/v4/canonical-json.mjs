import crypto from 'node:crypto';

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function digestCanonicalJson(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'));
}

export function digestBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function normalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Canonical JSON rejects cyclic arrays.');
    seen.add(value);
    const out = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return out;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Canonical JSON rejects cyclic objects.');
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new TypeError(`Canonical JSON rejects unsupported value at ${key}.`);
      }
      out[key] = normalize(item, seen);
    }
    seen.delete(value);
    return out;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}.`);
}
