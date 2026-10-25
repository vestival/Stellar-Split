import { createHash, randomUUID } from 'node:crypto';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { canonicalJson, fromBaseUnits, sha256, splitExpense, toBaseUnits } from './amounts.js';
import { checkPolicy } from './policy.js';
import { explorerTx, isAccount } from './ledger.js';

const INTENT_TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * deps: { config, ledger, facilitator, verifier, agents, spendLog, log }
 * agents: Map keyHashHex -> { address, owner, groups: number[], policy }
 * spendLog: { history(address) -> [{amount, at}], append(entry) }
 * facilitator: { verify(payload, req), settle(payload, req) } (x402 HTTPFacilitatorClient shape)
 */
export function createApp(deps) {
  const { config, ledger, facilitator, verifier, agents, spendLog } = deps;
  const log = deps.log ?? ((e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })));
  const intents = new Map();
  const now = deps.now ?? Date.now;

  function authenticate(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const agent = m && agents.get(createHash('sha256').update(m[1]).digest('hex'));
    if (!agent) throw new HttpError(401, 'invalid or missing API key');
    return agent;
  }

  function groupFor(agent, raw) {
    const group = Number(raw);
    if (!Number.isInteger(group) || group < 0 || group > 0xffffffff) throw new HttpError(400, 'invalid group id');
    if (!agent.groups.includes(group)) throw new HttpError(403, 'agent is not scoped to this group');
    return group;
  }

  async function balances(group) {
    const members = await ledger.members(group);
    const values = await Promise.all(members.map((m) => ledger.balance(group, m)));
    return members.map((member, i) => ({ member, net: fromBaseUnits(values[i]), netBaseUnits: values[i].toString() }));
  }

  async function createExpense(agent, group, body) {
    const members = await ledger.members(group);
    const payer = body.payer ?? agent.address;
    if (payer !== agent.address) throw new HttpError(403, 'agents can only record expenses they paid');
    let amount, deltas;
    try {
      amount = toBaseUnits(body.amount);
      ({ deltas } = splitExpense({ amount, payer, members, split: body.split }));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const record = {
      group, payer, amount: body.amount, description: String(body.description ?? ''),
      split: body.split, deltas: deltas.map(([m, d]) => [m, d.toString()]), nonce: body.nonce ?? randomUUID(),
    };
    const expenseHash = sha256(canonicalJson(record));
    const transaction = await ledger.buildAddExpense({ group, payer, expenseHash, deltas });
    return { expenseHash: expenseHash.toString('hex'), record, transaction, network: config.network };
  }

  function requirementsFor(intent) {
    return {
      scheme: 'exact',
      network: config.network,
      asset: config.usdc,
      amount: intent.amount.toString(),
      payTo: intent.to,
      maxTimeoutSeconds: 60,
      // Stellar exact currently always runs with facilitator-sponsored fees (scheme spec).
      extra: { areFeesSponsored: true },
    };
  }

  function paymentRequired(intent, error) {
    const body = {
      x402Version: 2,
      ...(error && { error }),
      resource: {
        url: `${config.publicUrl}/v1/groups/${intent.group}/settlements?intent=${intent.id}`,
        description: `Ledgerly settlement intent ${intent.id}: group ${intent.group}, ${fromBaseUnits(intent.amount)} USDC to ${intent.to}`,
        mimeType: 'application/json',
      },
      accepts: [requirementsFor(intent)],
    };
    return { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body) }, body: { ...body, intentId: intent.id } };
  }

  async function settle(agent, group, body, paymentHeader) {
    if (!isAccount(body.to)) throw new HttpError(400, 'to must be a Stellar account address');
    let amount;
    try { amount = toBaseUnits(body.amount); } catch (e) { throw new HttpError(400, e.message); }

    const members = await ledger.members(group);
    const at = now();
    const decision = checkPolicy({
      policy: agent.policy, history: spendLog.history(agent.address),
      intent: { from: agent.address, to: body.to, amount, at }, groupMembers: members,
    });
    if (!decision.allow) {
      log({ event: 'policy_denied', agent: agent.address, group, reason: decision.reason });
      return { status: 403, body: { error: 'policy_denied', reason: decision.reason } };
    }
    const [debt, credit] = await Promise.all([ledger.balance(group, agent.address), ledger.balance(group, body.to)]);
    if (-debt < amount || credit < amount) {
      return { status: 409, body: { error: 'amount exceeds what is owed between these members' } };
    }

    if (!paymentHeader) {
      const intent = { id: randomUUID(), group, from: agent.address, to: body.to, amount, expires: at + INTENT_TTL_MS };
      intents.set(intent.id, intent);
      log({ event: 'payment_required', agent: agent.address, group, intent: intent.id });
      return paymentRequired(intent);
    }

    let payload;
    try { payload = decodePaymentSignatureHeader(paymentHeader); } catch { throw new HttpError(400, 'malformed PAYMENT-SIGNATURE'); }
    const id = new URL(payload.resource?.url ?? 'x:', 'http://x').searchParams.get('intent');
    const intent = id && intents.get(id);
    if (!intent || intent.expires < at || intent.from !== agent.address || intent.group !== group
      || intent.to !== body.to || intent.amount !== amount) {
      throw new HttpError(400, 'unknown, expired or mismatched settlement intent');
    }
    const requirements = requirementsFor(intent);
    const fresh = (reason) => {
      intents.delete(intent.id);
      const next = { ...intent, id: randomUUID(), expires: at + INTENT_TTL_MS };
      intents.set(next.id, next);
      log({ event: 'settle_failed', agent: agent.address, group, intent: intent.id, reason });
      return paymentRequired(next, reason);
    };

    const a = payload.accepted ?? {};
    if (a.scheme !== 'exact' || a.network !== requirements.network || a.asset !== requirements.asset
      || a.amount !== requirements.amount || a.payTo !== requirements.payTo) {
      return fresh('accepted requirements do not match the intent');
    }
    intents.delete(intent.id); // single use, a retry gets a fresh challenge

    let settled;
    try {
      const v = await facilitator.verify(payload, requirements);
      if (!v.isValid) return fresh(`verify: ${v.invalidReason ?? 'invalid'}`);
      settled = await facilitator.settle(payload, requirements);
    } catch (e) {
      return fresh(`facilitator: ${e.message}`);
    }
    if (!settled.success) return fresh(`settle: ${settled.errorReason ?? 'failed'}`);

    // Tokens moved, so the spend counts against caps even if verification below fails.
    spendLog.append({ agent: agent.address, amount: amount.toString(), at, tx: settled.transaction });
    const headers = { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settled) };
    const receipt = { intentId: intent.id, txHash: settled.transaction, explorer: explorerTx(config.network, settled.transaction) };

    const check = await verifier.verify({ txHash: settled.transaction, from: agent.address, to: intent.to, amount });
    if (!check.ok) {
      log({ event: 'verify_failed', agent: agent.address, group, intent: intent.id, reason: check.reason });
      return { status: 502, headers, body: { ...receipt, status: 'submitted', error: `chain verification failed: ${check.reason}` } };
    }
    try {
      const recordTx = await ledger.recordX402Settlement({ group, from: agent.address, to: intent.to, amount, txHash: settled.transaction });
      log({ event: 'settlement_completed', agent: agent.address, group, intent: intent.id, tx: settled.transaction });
      return { status: 200, headers, body: { ...receipt, status: 'settled', recordTx } };
    } catch (e) {
      log({ event: 'record_failed', agent: agent.address, group, intent: intent.id, reason: e.message });
      return { status: 502, headers, body: { ...receipt, status: 'verified', error: 'recording on the group contract failed, retry later' } };
    }
  }

  async function route(req) {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'GET' && url.pathname === '/health') return { status: 200, body: { ok: true } };
    const agent = authenticate(req);
    if (req.method === 'GET' && url.pathname === '/v1/groups') {
      return { status: 200, body: { agent: agent.address, groups: agent.groups } };
    }
    const m = /^\/v1\/groups\/([^/]+)\/(balances|expenses|settlements)$/.exec(url.pathname);
    if (!m) throw new HttpError(404, 'not found');
    const group = groupFor(agent, m[1]);
    if (req.method === 'GET' && m[2] === 'balances') return { status: 200, body: { group, balances: await balances(group) } };
    if (req.method !== 'POST' || m[2] === 'balances') throw new HttpError(405, 'method not allowed');
    const body = await readJson(req);
    if (m[2] === 'expenses') return { status: 201, body: await createExpense(agent, group, body) };
    return settle(agent, group, body, req.headers['payment-signature']);
  }

  return async function handler(req, res) {
    let out;
    try {
      out = await route(req);
    } catch (e) {
      if (!(e instanceof HttpError)) log({ event: 'error', message: e.message });
      out = { status: e.status ?? 500, body: { error: e instanceof HttpError ? e.message : 'internal error' } };
    }
    res.writeHead(out.status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
      ...out.headers,
    });
    res.end(JSON.stringify(out.body));
  };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
}
