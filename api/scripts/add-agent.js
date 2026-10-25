// Usage: node scripts/add-agent.js <agent G address> <owner> <group,group> [perTxCap] [dailyCap]
// Prints the new API key once. Only its sha256 hash is stored.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StrKey } from '@stellar/stellar-sdk';

const [address, owner, groups, perTxCap = '25', dailyCap = '50'] = process.argv.slice(2);
if (!StrKey.isValidEd25519PublicKey(address ?? '') || !owner || !groups) {
  console.error('usage: node scripts/add-agent.js <G address> <owner> <group,group> [perTxCap] [dailyCap]');
  process.exit(1);
}
const file = process.env.AGENTS_FILE ?? new URL('../data/agents.json', import.meta.url).pathname;
const agents = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const key = `lgk_${randomBytes(24).toString('base64url')}`;
agents[createHash('sha256').update(key).digest('hex')] = {
  address, owner, groups: groups.split(',').map(Number), policy: { perTxCap, dailyCap },
};
writeFileSync(file, `${JSON.stringify(agents, null, 2)}\n`, { mode: 0o600 });
console.log(key);
