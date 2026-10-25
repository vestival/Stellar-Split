# Ledgerly API

HTTP API over the Ledgerly group contract. It reads balances from the contract, prepares expense transactions, enforces the agent spend policy and runs the x402 settlement flow with a facilitator.

Plain Node.js ES modules, built-in `http`, no build step.

## Setup

```sh
cd api
npm ci --ignore-scripts
cp .env.example .env              # fill in CONTRACT_ID, RECORDER_SECRET, FACILITATOR_API_KEY
node scripts/add-agent.js G...AGENT owner-id 1 25 50   # prints the agent API key once
npm start
npm test
```

## Environment

| Variable | Purpose |
|---|---|
| `NETWORK` | `stellar:testnet` (default) or `stellar:pubnet` |
| `STELLAR_RPC_URL` | Soroban RPC, default `https://soroban-testnet.stellar.org` |
| `CONTRACT_ID` | Ledgerly group contract id |
| `USDC_CONTRACT_ID` | SEP-41 USDC contract, defaults to testnet USDC |
| `RECORDER_SECRET` | Key allowed to call `record_x402_settlement`. It holds no funds. |
| `FACILITATOR_URL` | Default `https://channels.openzeppelin.com/x402/testnet` |
| `FACILITATOR_API_KEY` | Sent as `Authorization: Bearer` to `/verify`, `/settle` and `/supported` |
| `PORT`, `PUBLIC_URL` | Listen port and the base URL used in x402 resource URLs |
| `AGENTS_FILE`, `SPEND_LOG_FILE` | Default `data/agents.json` and `data/spend-log.jsonl` |

## API keys

Every `/v1` call needs `Authorization: Bearer lgk_...`. The API never stores the key. `data/agents.json` (gitignored, see `data/agents.example.json`) maps the sha256 hex of each key to the agent's Stellar address, its owner, the groups it may use and its spend policy. `scripts/add-agent.js` creates an entry and prints the key once.

## Endpoints

| Method and path | What it does |
|---|---|
| `GET /v1/groups` | Groups the key is scoped to |
| `GET /v1/groups/:id/balances` | Net balance per member, read from the contract with simulated `members` and `balance` calls. Positive means the member is owed. |
| `POST /v1/groups/:id/expenses` | Body `{ amount: "42.00", description, split }`. Returns the unsigned transaction to sign. |
| `POST /v1/groups/:id/settlements` | Body `{ to, amount }`. x402 settlement, see below. |

### Expenses

`amount` and exact shares are decimal strings with at most 7 decimals, converted to USDC base units with integer math. `split` is either `{ "type": "equal", "participants": [...] }` (participants default to all members, leftover base units go to the first participants in address order) or `{ "type": "exact", "shares": { "G...": "12.00" } }`, which must add up to the amount exactly.

The API computes the net deltas (payer credited the total, each participant debited its share) and the expense hash, which is the sha256 of the canonical JSON of the expense record (sorted keys, includes a nonce). It then returns a simulated, unsigned `add_expense` transaction with the payer as source account. The payer signs and submits it. Humans do that in their wallet. Agents do it through the Ledgerly MCP server, which only signs a single `add_expense` call on the configured contract. The API never holds a payer key.

## x402 settlement flow

1. The agent posts `{ to, amount }`.
2. The API checks the key, the group scope and the spend policy (`src/policy.js`): per transaction cap (default 25 USDC), rolling 24 hour cap (default 50 USDC), and the payee must be a member of the group. A denial returns `403` with the reason and is logged. No challenge is created.
3. It checks the agent owes at least that much to the payee (`409` otherwise).
4. With no `PAYMENT-SIGNATURE` header it answers `402` with a base64 `PAYMENT-REQUIRED` header (x402 v2): scheme `exact`, network `stellar:testnet`, the USDC contract as asset, the amount in base units, `payTo` set to the creditor, `extra.areFeesSponsored: true`, and a resource URL and description that carry the intent id. Intents are single use and expire after 5 minutes.
5. The agent retries with `PAYMENT-SIGNATURE`. The API checks the payload is for a live intent of this agent with the same terms, then calls the facilitator's `/verify` and `/settle`.
6. Any verify or settle failure returns a fresh `402` with the reason in `error`. Nothing is recorded.
7. On success the chain verifier (`src/verifier.js`) polls Soroban RPC for the transaction, requires `SUCCESS`, recomputes the hash with the expected network passphrase, and checks it is a single `transfer(from, to, amount)` on the USDC contract with the agent, the creditor and the intent amount. Only then does the API call `record_x402_settlement` with the recorder key.
8. The response carries `PAYMENT-RESPONSE` (the facilitator settle result) and a JSON receipt with the tx hash and a stellar.expert link.

If the chain check fails after a settle, the response is `502` with status `submitted` and nothing is recorded. If recording fails, the response is `502` with status `verified` so the operator can retry the record.

## Known limits

- Intents live in memory and the spend log is a JSONL file. Both reset or diverge across multiple instances. The PRD's PostgreSQL store replaces them.
- Approval thresholds, velocity checks, idempotency keys, rate limits and webhooks from the PRD are not in this version.
