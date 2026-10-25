import { createHash } from 'node:crypto';

export const DECIMALS = 7;

export function toBaseUnits(value, decimals = DECIMALS) {
  if (typeof value !== 'string' || !new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(value)) {
    throw new RangeError(`amount must be a decimal string with at most ${decimals} decimals`);
  }
  const [int, frac = ''] = value.split('.');
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0'));
}

export function fromBaseUnits(n, decimals = DECIMALS) {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${s.slice(0, -decimals)}${frac ? `.${frac}` : ''}`;
}

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const sha256 = (s) => createHash('sha256').update(s).digest();

/**
 * Splits `amount` (base units) between group members and returns per-member shares
 * plus net deltas (payer credited the total, every participant debited its share).
 * Equal splits hand the leftover base units to the first participants in address order.
 */
export function splitExpense({ amount, payer, members, split }) {
  if (amount <= 0n) throw new RangeError('amount must be positive');
  if (!members.includes(payer)) throw new RangeError('payer is not a group member');
  const shares = new Map();

  if (split?.type === 'equal') {
    const participants = [...new Set(split.participants ?? members)].sort();
    if (participants.length === 0) throw new RangeError('no participants');
    for (const p of participants) if (!members.includes(p)) throw new RangeError(`${p} is not a group member`);
    const n = BigInt(participants.length);
    participants.forEach((p, i) => shares.set(p, amount / n + (BigInt(i) < amount % n ? 1n : 0n)));
  } else if (split?.type === 'exact') {
    const entries = Object.entries(split.shares ?? {});
    if (entries.length === 0) throw new RangeError('exact split needs shares');
    for (const [p, v] of entries) {
      if (!members.includes(p)) throw new RangeError(`${p} is not a group member`);
      shares.set(p, toBaseUnits(v));
    }
    const sum = [...shares.values()].reduce((a, b) => a + b, 0n);
    if (sum !== amount) throw new RangeError(`shares sum to ${fromBaseUnits(sum)}, expected ${fromBaseUnits(amount)}`);
  } else {
    throw new RangeError('split.type must be "equal" or "exact"');
  }

  const net = new Map([...shares].map(([p, s]) => [p, -s]));
  net.set(payer, (net.get(payer) ?? 0n) + amount);
  const deltas = [...net].filter(([, d]) => d !== 0n).sort(([a], [b]) => (a < b ? -1 : 1));
  return { shares, deltas };
}
