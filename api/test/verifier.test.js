import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';
import { checkTransfer } from '../src/verifier.js';

const usdc = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const other = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const agent = Keypair.random().publicKey();
const creditor = Keypair.random().publicKey();
const facilitator = Keypair.random();

function fixture({ asset = usdc, fn = 'transfer', from = agent, to = creditor, amount = 250000000n, ops = 1, passphrase = Networks.TESTNET } = {}) {
  const b = new TransactionBuilder(new Account(facilitator.publicKey(), '7'), { fee: '1000', networkPassphrase: passphrase });
  for (let i = 0; i < ops; i++) {
    b.addOperation(Operation.invokeContractFunction({
      contract: asset, function: fn,
      args: [new Address(from).toScVal(), new Address(to).toScVal(), nativeToScVal(amount, { type: 'i128' })],
    }));
  }
  const tx = b.setTimeout(60).build();
  tx.sign(facilitator);
  return { txHash: tx.hash().toString('hex'), envelopeXdr: tx.toXDR() };
}

const expect = { passphrase: Networks.TESTNET, asset: usdc, from: agent, to: creditor, amount: 250000000n };

test('accepts the matching transfer', () => {
  assert.deepEqual(checkTransfer({ ...fixture(), ...expect }), { ok: true });
});

test('rejects each mismatch', () => {
  const cases = [
    [{ asset: other }, 'wrong asset contract'],
    [{ fn: 'burn' }, 'not a transfer call'],
    [{ from: creditor }, 'payer mismatch'],
    [{ to: agent }, 'payee mismatch'],
    [{ amount: 250000001n }, 'amount mismatch'],
    [{ ops: 2 }, 'expected exactly one operation'],
    [{ passphrase: Networks.PUBLIC }, 'hash mismatch (wrong network or envelope)'],
  ];
  for (const [over, reason] of cases) {
    assert.deepEqual(checkTransfer({ ...fixture(over), ...expect }), { ok: false, reason }, reason);
  }
});

test('rejects a hash that does not belong to the envelope', () => {
  const f = fixture();
  assert.equal(checkTransfer({ ...f, txHash: '00'.repeat(32), ...expect }).ok, false);
  assert.equal(checkTransfer({ ...f, envelopeXdr: 'garbage', ...expect }).reason, 'envelope does not decode');
});
