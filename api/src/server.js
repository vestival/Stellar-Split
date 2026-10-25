import { createServer } from 'node:http';
import { rpc } from '@stellar/stellar-sdk';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createApp } from './app.js';
import { createLedger, loadConfig } from './ledger.js';
import { createVerifier } from './verifier.js';
import { fileSpendLog, loadAgents } from './stores.js';

const config = loadConfig();
const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') });
const auth = config.facilitatorApiKey ? { Authorization: `Bearer ${config.facilitatorApiKey}` } : {};

const handler = createApp({
  config,
  ledger: createLedger(config, server),
  facilitator: new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  }),
  verifier: createVerifier({ server, passphrase: config.passphrase, asset: config.usdc }),
  agents: loadAgents(config.agentsFile),
  spendLog: fileSpendLog(config.spendLogFile),
});

createServer(handler).listen(config.port, () => console.log(`ledgerly api on :${config.port} (${config.network})`));
