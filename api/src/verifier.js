import { Address, FeeBumpTransaction, TransactionBuilder, scValToNative } from '@stellar/stellar-sdk';

/**
 * Checks a transaction envelope is exactly one SEP-41 `transfer(from, to, amount)` on `asset`.
 * Recomputing the hash with the expected passphrase also proves the network.
 */
export function checkTransfer({ txHash, envelopeXdr, passphrase, asset, from, to, amount }) {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  } catch {
    return fail('envelope does not decode');
  }
  if (tx.hash().toString('hex') !== txHash) return fail('hash mismatch (wrong network or envelope)');
  if (tx instanceof FeeBumpTransaction) tx = tx.innerTransaction;
  if (tx.operations.length !== 1) return fail('expected exactly one operation');

  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction' || op.func?.type !== 'hostFunctionTypeInvokeContract') {
    return fail('operation is not a contract invocation');
  }
  const call = op.func.invokeContract;
  if (Address.fromScAddress(call.contractAddress).toString() !== asset) return fail('wrong asset contract');
  if (call.functionName.toString() !== 'transfer' || call.args.length !== 3) return fail('not a transfer call');

  const [gotFrom, gotTo, gotAmount] = call.args.map(scValToNative);
  if (gotFrom !== from) return fail('payer mismatch');
  if (gotTo !== to) return fail('payee mismatch');
  if (BigInt(gotAmount) !== amount) return fail('amount mismatch');
  return { ok: true };
}

export function createVerifier({ server, passphrase, asset, attempts = 20 }) {
  return {
    async verify({ txHash, from, to, amount }) {
      const res = await server.pollTransaction(txHash, { attempts });
      if (res.status !== 'SUCCESS') return fail(`transaction status ${res.status}`);
      return checkTransfer({ txHash, envelopeXdr: res.envelopeXdr.toXDR('base64'), passphrase, asset, from, to, amount });
    },
  };
}

const fail = (reason) => ({ ok: false, reason });
