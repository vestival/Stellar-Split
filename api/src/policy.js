import { toBaseUnits, fromBaseUnits } from './amounts.js';

export const DEFAULT_POLICY = { perTxCap: '25', dailyCap: '50' };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure spend check run before any 402 is issued.
 * policy: { perTxCap, dailyCap, counterparties? } caps as USDC decimal strings.
 * history: [{ amount: bigint, at: ms }] settlements already paid by this agent.
 * intent: { from, to, amount: bigint, at: ms }.
 */
export function checkPolicy({ policy, history, intent, groupMembers }) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const perTx = toBaseUnits(p.perTxCap);
  const daily = toBaseUnits(p.dailyCap);

  if (intent.amount <= 0n) return deny('amount must be positive');
  if (intent.to === intent.from) return deny('cannot pay yourself');
  if (!groupMembers.includes(intent.to)) return deny('counterparty is not a member of this group');
  if (p.counterparties && !p.counterparties.includes(intent.to)) return deny('counterparty is not on the owner allowlist');
  if (intent.amount > perTx) return deny(`amount exceeds per-transaction cap of ${fromBaseUnits(perTx)} USDC`);

  const spent = history.filter((h) => h.at > intent.at - DAY_MS).reduce((a, h) => a + h.amount, 0n);
  if (spent + intent.amount > daily) {
    return deny(`amount exceeds rolling 24h cap of ${fromBaseUnits(daily)} USDC (already spent ${fromBaseUnits(spent)})`);
  }
  return { allow: true, reason: 'ok' };
}

const deny = (reason) => ({ allow: false, reason });
