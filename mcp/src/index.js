#!/usr/bin/env node
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { x402Client } from '@x402/core/client';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { z } from 'zod';
import { createLedgerly, loadConfig } from './ledgerly.js';

const config = loadConfig();
const payer = x402Client.fromConfig({
  schemes: [{ network: config.network, client: new ExactStellarScheme(createEd25519Signer(config.agentSecret, config.network), { url: config.rpcUrl }) }],
  // Caps live server side (policy engine) and the intent check in ledgerly.js, so the SDK's $1 default is off.
  spendControls: false,
});
const ledgerly = createLedgerly(config, { payer });
delete process.env.AGENT_SECRET; // keep it out of anything that inspects the environment later

const group = z.number().int().min(0).describe('Ledgerly group id');
const amount = z.string().regex(/^\d+(\.\d{1,7})?$/).describe('USDC amount as a decimal string, for example "12.50"');
const wrap = (fn) => async (args) => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(args)) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

function buildServer() {
  const s = new McpServer({ name: 'ledgerly', version: '0.1.0' });
  s.registerTool('ledgerly_list_groups', {
    description: 'List the Ledgerly groups this agent belongs to. Does not spend money.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, wrap(() => ledgerly.listGroups()));

  s.registerTool('ledgerly_get_balances', {
    description: 'Net balance of every member of a group, in USDC. Positive means the member is owed money. Does not spend money.',
    inputSchema: { group },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, wrap(({ group: g }) => ledgerly.getBalances(g)));

  s.registerTool('ledgerly_create_expense', {
    description: 'Record an expense this agent paid, split equally or by exact shares, on the group contract. Does not move money, it only changes who owes whom.',
    inputSchema: {
      group,
      amount,
      description: z.string().max(200),
      split: z.discriminatedUnion('type', [
        z.object({ type: z.literal('equal'), participants: z.array(z.string()).optional() }),
        z.object({ type: z.literal('exact'), shares: z.record(z.string(), amount) }),
      ]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(({ group: g, ...input }) => ledgerly.createExpense(g, input)));

  s.registerTool('ledgerly_settle', {
    description: 'SPENDS MONEY. Pays a group member USDC from the agent wallet via x402 to settle a debt. Subject to the owner spend policy.',
    inputSchema: { group, to: z.string().describe('Stellar address of the creditor, must be a group member'), amount },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, wrap(({ group: g, to, amount: a }) => ledgerly.settle(g, { to, amount: a })));
  return s;
}

const port = process.env.MCP_HTTP_PORT;
if (!port) {
  await buildServer().connect(new StdioServerTransport());
} else {
  const token = process.env.MCP_HTTP_TOKEN;
  if (!token) throw new Error('MCP_HTTP_TOKEN is required with MCP_HTTP_PORT');
  // Stateless streamable HTTP: one server and transport per request.
  createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(req.url === '/mcp' ? 401 : 404).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildServer();
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(Number(port), () => console.error(`ledgerly mcp on :${port}/mcp`));
}
