# Ledgerly MCP server

MCP server that runs next to an agent and holds the agent's Stellar key. The model and its plugins only see tool results. The key is never returned by any tool.

## Tools

| Tool | Spends money | Annotations |
|---|---|---|
| `ledgerly_list_groups` | No | `readOnlyHint: true` |
| `ledgerly_get_balances` | No | `readOnlyHint: true` |
| `ledgerly_create_expense` | No, it changes who owes whom | `readOnlyHint: false`, `destructiveHint: false` |
| `ledgerly_settle` | Yes | `readOnlyHint: false`, `destructiveHint: true` |

## Setup

```sh
cd mcp
npm ci --ignore-scripts
cp .env.example .env
node --env-file=.env src/index.js          # stdio
npm test
```

Docker, as a container next to the agent:

```sh
docker build -t ledgerly-mcp mcp
docker run --rm -i --env-file mcp/.env ledgerly-mcp                       # stdio
docker run --rm -p 8790:8790 --env-file mcp/.env -e MCP_HTTP_PORT=8790 -e MCP_HTTP_TOKEN=... ledgerly-mcp   # HTTP on /mcp
```

The image runs as the non-root `node` user on a digest-pinned `node:22-alpine` base.

## Environment

| Variable | Purpose |
|---|---|
| `LEDGERLY_API_URL` | Ledgerly API base URL |
| `LEDGERLY_API_KEY` | The agent's `lgk_` key |
| `AGENT_SECRET` | Agent Stellar secret key. Removed from `process.env` after start-up. |
| `CONTRACT_ID` | Ledgerly group contract, the only contract expense transactions may call |
| `NETWORK`, `STELLAR_RPC_URL`, `USDC_CONTRACT_ID` | Network, RPC and asset, testnet defaults |
| `MCP_HTTP_PORT`, `MCP_HTTP_TOKEN` | Optional stateless streamable HTTP on `/mcp`, requires `Authorization: Bearer <token>` |

## How `ledgerly_settle` pays

1. It posts `{ to, amount }` to the API and gets `402 Payment Required`.
2. It decodes `PAYMENT-REQUIRED` and compares every offered option with the intent it asked for: scheme `exact`, network, asset (USDC contract), amount in base units and `payTo`. Any difference aborts the payment before anything is signed.
3. It builds the payment with `@x402/stellar`'s `ExactStellarScheme` client. That simulates a USDC `transfer(agent, creditor, amount)` and signs only the Soroban authorization entry, with an expiry of about 60 seconds of ledgers. It does not sign or submit a full transaction. The facilitator does that and pays the fee.
4. It retries with `PAYMENT-SIGNATURE` and returns the tx hash and a stellar.expert link from `PAYMENT-RESPONSE`.

The x402 SDK's own spend controls are turned off because the caps are enforced by the API policy engine and the intent check above.

`ledgerly_create_expense` asks the API for an unsigned `add_expense` transaction and signs it only if it is a single `add_expense` call on `CONTRACT_ID` with the agent as source.

## Register in Hermes

In `~/.hermes/config.yaml`. Keep `LEDGERLY_MCP_TOKEN` (the `MCP_HTTP_TOKEN` of the container) in `~/.hermes/.env`. The Ledgerly API key stays in the MCP container env.

```yaml
mcp_servers:
  ledgerly:
    url: "http://ledgerly-mcp:8790/mcp"
    headers:
      Authorization: "Bearer ${LEDGERLY_MCP_TOKEN}"
    trust: untrusted
    tool_costs:
      ledgerly_settle: {credits: [1, 25], note: "USDC paid to a group member"}
      ledgerly_create_expense: 0
      ledgerly_get_balances: 0
      ledgerly_list_groups: 0
    spend_limit: 25
    cost_unit: USDC
```

For stdio instead of HTTP:

```yaml
mcp_servers:
  ledgerly:
    command: "docker"
    args: ["run", "--rm", "-i", "--env-file", "/path/to/ledgerly-mcp.env", "ledgerly-mcp"]
    trust: untrusted
    tool_costs:
      ledgerly_settle: {credits: [1, 25], note: "USDC paid to a group member"}
```

To give an agent expense rights without payment rights, add `tools: { exclude: [ledgerly_settle] }`.
