import { Address, Networks, TransactionBuilder, Keypair, rpc } from '@stellar/stellar-sdk';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';

const PASSPHRASES = { 'stellar:testnet': Networks.TESTNET, 'stellar:pubnet': Networks.PUBLIC };
const TESTNET_USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

export function loadConfig(env = process.env) {
  const network = env.NETWORK ?? 'stellar:testnet';
  if (!PASSPHRASES[network]) throw new Error(`unknown NETWORK ${network}`);
  for (const k of ['LEDGERLY_API_URL', 'LEDGERLY_API_KEY', 'AGENT_SECRET', 'CONTRACT_ID']) {
    if (!env[k]) throw new Error(`${k} is required`);
  }
  return {
    network,
    passphrase: PASSPHRASES[network],
    apiUrl: env.LEDGERLY_API_URL.replace(/\/$/, ''),
    apiKey: env.LEDGERLY_API_KEY,
    agentSecret: env.AGENT_SECRET,
    contractId: env.CONTRACT_ID,
    usdc: env.USDC_CONTRACT_ID ?? (network === 'stellar:testnet' ? TESTNET_USDC : undefined),
    rpcUrl: env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  };
}

export function toBaseUnits(value, decimals = 7) {
  if (typeof value !== 'string' || !new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(value)) {
    throw new RangeError(`amount must be a decimal string with at most ${decimals} decimals`);
  }
  const [int, frac = ''] = value.split('.');
  return (BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0'))).toString();
}

/**
 * FR-38: returns the single accept that matches what we asked to pay, or throws.
 * Every accept must match, so a server cannot slip in an alternative option.
 */
export function matchRequirements(paymentRequired, intent) {
  const accepts = paymentRequired?.accepts ?? [];
  if (paymentRequired?.x402Version !== 2 || accepts.length === 0) throw new Error('refusing to pay: malformed 402');
  for (const a of accepts) {
    const diff = [
      a.scheme !== 'exact' && 'scheme',
      a.network !== intent.network && 'network',
      a.asset !== intent.asset && 'asset',
      a.amount !== intent.amount && 'amount',
      a.payTo !== intent.payTo && 'payTo',
    ].filter(Boolean);
    if (diff.length) throw new Error(`refusing to pay: 402 ${diff.join(', ')} differ from the requested intent`);
  }
  return accepts[0];
}

/**
 * The API returns an unsigned add_expense transaction. Only sign it if it is exactly
 * one call to our group contract's add_expense, so a compromised API cannot get a payment signed.
 */
export function checkExpenseTx(xdrB64, { passphrase, contractId, agent }) {
  const tx = TransactionBuilder.fromXDR(xdrB64, passphrase);
  const op = tx.operations[0];
  if (tx.source !== agent || tx.operations.length !== 1 || op?.type !== 'invokeHostFunction'
    || op.func?.type !== 'hostFunctionTypeInvokeContract'
    || Address.fromScAddress(op.func.invokeContract.contractAddress).toString() !== contractId
    || op.func.invokeContract.functionName.toString() !== 'add_expense') {
    throw new Error('refusing to sign: transaction is not a single add_expense call on the Ledgerly contract');
  }
  return tx;
}

export const explorerTx = (network, hash) =>
  `https://stellar.expert/explorer/${network === 'stellar:pubnet' ? 'public' : 'testnet'}/tx/${hash}`;

/**
 * deps.payer: { createPaymentPayload(paymentRequired) } (an x402Client)
 * deps.fetch, deps.rpc are injectable for tests.
 */
export function createLedgerly(config, deps) {
  const keypair = Keypair.fromSecret(config.agentSecret);
  const address = keypair.publicKey();
  const doFetch = deps.fetch ?? fetch;
  const server = deps.rpc ?? new rpc.Server(config.rpcUrl);

  async function api(method, path, body, headers = {}) {
    const res = await doFetch(`${config.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', ...headers },
      body: body && JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => ({})) };
  }
  const ok = ({ res, json }) => {
    if (!res.ok) throw new Error(`Ledgerly API ${res.status}: ${json.reason ?? json.error ?? 'error'}`);
    return json;
  };

  return {
    address,
    listGroups: async () => ok(await api('GET', '/v1/groups')),
    getBalances: async (group) => ok(await api('GET', `/v1/groups/${group}/balances`)),

    async createExpense(group, input) {
      const created = ok(await api('POST', `/v1/groups/${group}/expenses`, { ...input, payer: address }));
      const tx = checkExpenseTx(created.transaction, { passphrase: config.passphrase, contractId: config.contractId, agent: address });
      tx.sign(keypair);
      const sent = await server.sendTransaction(tx);
      if (sent.status !== 'PENDING') throw new Error(`add_expense submit ${sent.status}`);
      const res = await server.pollTransaction(sent.hash, { attempts: 30 });
      if (res.status !== 'SUCCESS') throw new Error(`add_expense ${res.status}`);
      return { expenseHash: created.expenseHash, txHash: sent.hash, explorer: explorerTx(config.network, sent.hash) };
    },

    async settle(group, { to, amount }) {
      const intent = { network: config.network, asset: config.usdc, amount: toBaseUnits(amount), payTo: to };
      const body = { to, amount };
      const first = await api('POST', `/v1/groups/${group}/settlements`, body);
      if (first.res.status !== 402) return ok(first);

      const required = decodePaymentRequiredHeader(first.res.headers.get('payment-required') ?? '');
      const accepted = matchRequirements(required, intent);
      const payload = await deps.payer.createPaymentPayload({ ...required, accepts: [accepted] });

      const paid = await api('POST', `/v1/groups/${group}/settlements`, body, { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) });
      const header = paid.res.headers.get('payment-response');
      const settled = header ? decodePaymentResponseHeader(header) : null;
      if (paid.res.status === 402) throw new Error(`payment not settled: ${decodePaymentRequiredHeader(paid.res.headers.get('payment-required') ?? '').error ?? 'unknown'}`);
      if (!settled) { ok(paid); throw new Error('API did not return PAYMENT-RESPONSE'); }
      return {
        status: paid.json.status ?? (paid.res.ok ? 'settled' : 'submitted'),
        txHash: settled.transaction,
        explorer: explorerTx(config.network, settled.transaction),
        ...(paid.json.error && { warning: paid.json.error }),
      };
    },
  };
}
