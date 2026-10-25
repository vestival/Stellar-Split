import { appendFileSync, existsSync, readFileSync } from 'node:fs';

// agents.json: { "<sha256 hex of API key>": { address, owner, groups: [n], policy: { perTxCap, dailyCap } } }
export function loadAgents(file) {
  if (!existsSync(file)) return new Map();
  return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))));
}

// shortcut: append-only JSONL file, swap for the PostgreSQL table from the PRD before multi-instance deploys.
export function fileSpendLog(file) {
  const rows = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return {
    history: (agent) => rows.filter((r) => r.agent === agent).map((r) => ({ amount: BigInt(r.amount), at: r.at })),
    append(entry) {
      rows.push(entry);
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    },
  };
}
