import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Address, Blockhash, KeyPairSigner, Signature, TransactionError } from "@solana/kit";
import { AccountRole, generateKeyPairSigner, compileTransaction,
         signTransaction, setTransactionMessageLifetimeUsingBlockhash,
         getBase64EncodedWireTransaction } from "@solana/kit";
import { type Ix, type Client, base58,
         systemProgramId, computeBudgetProgramId } from "@onrail-xyz/svm";
import { ForkSvm, FailedTransactionMetadata } from "../src/forkSvm.js";
import { TransactionErrorInstructionError,
         TransactionErrorProgramExecutionTemporarilyRestricted,
         InstructionErrorBorshIo } from "../src/liteSvm.js";
import { transactionErrorToRpc } from "../src/rpcErrors.js";
import { createCurried } from "../src/utils.js";

const transfer = (from: Address, to: Address, lamports: bigint): Ix => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: systemProgramId,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
};

describe("RPC transaction errors", () => {
  let fork: ForkSvm;
  let payer: KeyPairSigner;
  let recipient: Address;
  let rpc: Client;

  beforeEach(async () => {
    fork = new ForkSvm();
    payer = await generateKeyPairSigner();
    recipient = (await generateKeyPairSigner()).address;
    rpc = fork.createForkRpc();
  });

  const sign = async (instructions: Ix[]) => {
    const message = await createCurried(fork).createTx(instructions, payer);
    return signTransaction([payer.keyPair], compileTransaction(
      setTransactionMessageLifetimeUsingBlockhash({
        blockhash: fork.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n,
      }, message),
    ));
  };

  const checkFailure = async (instructions: Ix[], expected: TransactionError) => {
    const signed = await sign(instructions);
    const simulated = await rpc.simulateTransaction(
      getBase64EncodedWireTransaction(signed), { encoding: "base64" },
    ).send();
    assert.deepEqual(simulated.value.err, expected);

    let failure: FailedTransactionMetadata | undefined;
    await assert.rejects(fork.sendTransaction(signed), error => {
      assert(error instanceof FailedTransactionMetadata);
      failure = error;
      return true;
    });
    assert(failure);
    const signature = base58.encode(failure.meta().signature()) as Signature;
    const recorded = await rpc.getTransaction(signature, { encoding: "base64" }).send();
    assert(recorded?.meta);
    assert.deepEqual(recorded.meta.err, expected);
    assert.deepEqual(recorded.meta.status, { Err: expected });
  };

  it("returns a fieldless error name for an unfunded payer", async () => {
    const result = await rpc.simulateTransaction(
      getBase64EncodedWireTransaction(await sign([])), { encoding: "base64" },
    ).send();
    assert.equal(result.value.err, "AccountNotFound");
  });

  it("preserves an instruction's index and custom program code", async () => {
    await fork.airdrop(payer.address, 10_000_000n);
    await checkFailure([
      transfer(payer.address, recipient, 1_000_000n),
      transfer(payer.address, recipient, 100_000_000n),
    ], { InstructionError: [1, { Custom: 1 }] });
  });

  it("preserves a fieldless instruction error", async () => {
    await fork.airdrop(payer.address, 10_000_000n);
    await checkFailure([
      { programAddress: systemProgramId, accounts: [], data: new Uint8Array([255]) },
    ], { InstructionError: [0, "InvalidInstructionData"] });
  });

  it("uses account_index for rent failures", async () => {
    await fork.airdrop(payer.address, 10_000_000n);
    await checkFailure([
      transfer(payer.address, recipient, 1n),
    ], { InsufficientFundsForRent: { account_index: 1 } });
  });

  it("reports the index of a duplicate compute-budget instruction", async () => {
    await fork.airdrop(payer.address, 10_000_000n);
    const budget: Ix = {
      programAddress: computeBudgetProgramId,
      accounts: [],
      data: new Uint8Array([2, 0x40, 0x0d, 0x03, 0]), //200,000 compute units
    };
    const signed = await sign([budget, budget]);
    const result = await rpc.simulateTransaction(
      getBase64EncodedWireTransaction(signed), { encoding: "base64" },
    ).send();
    assert.deepEqual(result.value.err, { DuplicateInstruction: 1 });
  });

  it("encodes variants that cannot be triggered by ordinary local transactions", () => {
    //Native error classes have no public constructors; model their exposed fields/methods.
    const restricted: TransactionErrorProgramExecutionTemporarilyRestricted = Object.create(
      TransactionErrorProgramExecutionTemporarilyRestricted.prototype,
      { accountIndex: { value: 3 } },
    );
    assert.deepEqual(transactionErrorToRpc(restricted), {
      ProgramExecutionTemporarilyRestricted: { account_index: 3 },
    });
    const borsh: InstructionErrorBorshIo = Object.create(InstructionErrorBorshIo.prototype);
    const instruction: TransactionErrorInstructionError = Object.create(
      TransactionErrorInstructionError.prototype,
      { index: { value: 2 }, err: { value: () => borsh } },
    );
    assert.deepEqual(transactionErrorToRpc(instruction), { InstructionError: [2, "BorshIoError"] });
    assert.equal(transactionErrorToRpc(33), "ProgramCacheHitMaxLimit");
    assert.equal(transactionErrorToRpc(34), "CommitCancelled");
  });
});
