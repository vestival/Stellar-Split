import {
  Account, Address, BASE_FEE, Contract, Keypair, Networks, StrKey, TransactionBuilder,
  nativeToScVal, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';

const PASSPHRASES = { 'stellar:testnet': Networks.TESTNET, 'stellar:pubnet': Networks.PUBLIC };
// Source account for read-only simulations, same constant the SDK contract client uses.
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TESTNET_USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

export function loadConfig(env = process.env) {
  const network = env.NETWORK ?? 'stellar:testnet';
  const passphrase = PASSPHRASES[network];
  if (!passphrase) throw new Error(`unknown NETWORK ${network}`);
  return {
    network,
    passphrase,
    rpcUrl: env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    contractId: env.CONTRACT_ID,
    usdc: env.USDC_CONTRACT_ID ?? (network === 'stellar:testnet' ? TESTNET_USDC : undefined),
    recorderSecret: env.RECORDER_SECRET,
    facilitatorUrl: env.FACILITATOR_URL ?? 'https://channels.openzeppelin.com/x402/testnet',
    facilitatorApiKey: env.FACILITATOR_API_KEY,
    port: Number(env.PORT ?? 8787),
    publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`,
    agentsFile: env.AGENTS_FILE ?? new URL('../data/agents.json', import.meta.url).pathname,
    spendLogFile: env.SPEND_LOG_FILE ?? new URL('../data/spend-log.jsonl', import.meta.url).pathname,
  };
}

export const isAccount = (a) => typeof a === 'string' && StrKey.isValidEd25519PublicKey(a);
export const explorerTx = (network, hash) =>
  `https://stellar.expert/explorer/${network === 'stellar:pubnet' ? 'public' : 'testnet'}/tx/${hash}`;

const u32 = (n) => nativeToScVal(n, { type: 'u32' });
const addr = (a) => new Address(a).toScVal();
const i128 = (n) => nativeToScVal(n, { type: 'i128' });

export function createLedger(config, server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') })) {
  if (!config.contractId) throw new Error('CONTRACT_ID is required');
  const contract = new Contract(config.contractId);
  const recorder = config.recorderSecret ? Keypair.fromSecret(config.recorderSecret) : null;
  const build = (source, op) =>
    new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: config.passphrase }).addOperation(op).setTimeout(120).build();

  async function read(method, ...args) {
    const sim = await server.simulateTransaction(build(new Account(NULL_ACCOUNT, '0'), contract.call(method, ...args)));
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} simulation failed: ${sim.error}`);
    return scValToNative(sim.result.retval);
  }

  return {
    members: (group) => read('members', u32(group)),
    balance: async (group, member) => BigInt(await read('balance', u32(group), addr(member))),
    groupToken: (group) => read('group_token', u32(group)),

    // Unsigned, simulated transaction. The payer is the source account, so its signature covers the payer auth.
    async buildAddExpense({ group, payer, expenseHash, deltas }) {
      const deltaVec = xdr.ScVal.scvVec(deltas.map(([a, d]) => xdr.ScVal.scvVec([addr(a), i128(d)])));
      const tx = build(await server.getAccount(payer),
        contract.call('add_expense', u32(group), addr(payer), nativeToScVal(expenseHash), deltaVec));
      return (await server.prepareTransaction(tx)).toXDR();
    },

    async recordX402Settlement({ group, from, to, amount, txHash }) {
      if (!recorder) throw new Error('RECORDER_SECRET is not set');
      const tx = await server.prepareTransaction(build(await server.getAccount(recorder.publicKey()),
        contract.call('record_x402_settlement', u32(group), addr(from), addr(to), i128(amount),
          nativeToScVal(Buffer.from(txHash, 'hex')))));
      tx.sign(recorder);
      const sent = await server.sendTransaction(tx);
      if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') throw new Error(`record_x402_settlement send ${sent.status}`);
      const res = await server.pollTransaction(sent.hash, { attempts: 30 });
      if (res.status !== 'SUCCESS') throw new Error(`record_x402_settlement ${res.status}`);
      return sent.hash;
    },
  };
}
