import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Address, Lamports, Signature, Blockhash } from "@solana/kit";
import { address, setTransactionMessageLifetimeUsingBlockhash,
         signTransaction, compileTransaction,
         getBase64EncodedWireTransaction, generateKeyPairSigner } from "@solana/kit";
import { Amount, kind } from "@onrail-xyz/amount";
import { Sol, sol } from "@onrail-xyz/common";
import { base58, type Client,
         tokenProgramId, systemProgramId, findAta,
         minimumBalanceForRentExemption, nativeMint } from "@onrail-xyz/svm";
import { ForkSvm, FailedTransactionMetadata } from "../src/forkSvm.js";
import { assertTxSuccess, createCurried } from "../src/utils.js";

//airdrops must leave the recipient rent-exempt or the transaction fails
const rentExempt = minimumBalanceForRentExemption(0);

// Helper to test unavailable field access
const testUnavailableField = (
  getValue: () => any,
  fieldPath: string,
  fieldName: string
) => {
  //the read of the field itself must throw: a stand-in value would answer truthiness, typeof
  //  and Array.isArray with something, and only a later property read could object
  it(`should throw when accessing ${fieldPath}`, () => {
    assert.throws(
      () => getValue(),
      (err: Error) => {
        return err.message.includes(`${fieldName} is not provided by ForkSvm`);
      }
    );
  });
};

describe("ForkSvm", () => {
  let forkSvm: ForkSvm;
  let payer: Address;
  let payerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let mint: Address;
  let tokenAccount: Address;
  const nonExistentAddress = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

  beforeEach(async () => {
    forkSvm = new ForkSvm();
    payerSigner = await generateKeyPairSigner();
    payer = payerSigner.address;
    mint = address("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
    tokenAccount = findAta({ owner: payer, mint });
  });

  describe("constructor", () => {
    it("should create a ForkSvm instance with default settings", () => {
      const instance = new ForkSvm();
      assert(instance instanceof ForkSvm);
    });

    it("should create a ForkSvm instance with an upstream url", () => {
      const instance = new ForkSvm("https://api.mainnet-beta.solana.com");
      assert(instance instanceof ForkSvm);
    });
  });

  describe("save and load", () => {
    it("should save and load a snapshot", async () => {
      const balance = 10n**9n;
      await forkSvm.airdrop(payer, balance);
      const curried = createCurried(forkSvm);
      curried.createMint(mint, { mintAuthority: payer });

      const snapshot = forkSvm.save();
      assert(snapshot.blockhash);
      assert(snapshot.accounts);
      assert(snapshot.clock);

      const newForkSvm = ForkSvm.load(snapshot);
      const account = await newForkSvm.getAccount(payer);
      assert(account);
      assert.strictEqual(account.lamports, balance);
    });

    //load() on a reused instance must fully reset: known accounts absent from the snapshot
    //  would otherwise linger in the underlying liteSvm
    it("clears accounts absent from the loaded snapshot", async () => {
      const emptySnapshot = forkSvm.save();
      await forkSvm.airdrop(payer, rentExempt);

      forkSvm.load(emptySnapshot);
      assert.strictEqual(await forkSvm.getAccount(payer), null);
    });

    //load() used to write the accounts onto the running VM, so a transaction sent after the
    //  save stayed in its history (AlreadyProcessed on replay) and an expired blockhash stayed
    //  expired while the balances looked correctly reset
    it("restores transaction history and blockhash along with the accounts", async () => {
      await forkSvm.airdrop(payer, rentExempt + 1_000_000n);
      const txMsg = await createCurried(forkSvm).createTx([], payerSigner);
      const lifetime = {
        blockhash:            forkSvm.latestBlockhash() as Blockhash,
        lastValidBlockHeight: 0n,
      };
      const signed = await signTransaction(
        [payerSigner.keyPair],
        compileTransaction(setTransactionMessageLifetimeUsingBlockhash(lifetime, txMsg)),
      );
      const snapshot = forkSvm.save();
      const balance = (await forkSvm.getAccount(payer))!.lamports;

      await forkSvm.sendTransaction(signed);
      await assert.rejects(() => forkSvm.sendTransaction(signed));
      forkSvm.expireBlockhash();
      assert.notStrictEqual(forkSvm.latestBlockhash(), snapshot.blockhash);

      forkSvm.load(snapshot);
      assert.strictEqual(forkSvm.latestBlockhash(), snapshot.blockhash);
      assert.strictEqual((await forkSvm.getAccount(payer))!.lamports, balance);
      await forkSvm.sendTransaction(signed);
    });
  });

  describe("setAccount", () => {
    //non-system accounts used to be topped up to rent exemption on the way in
    it("stores the account verbatim", async () => {
      const acc = {
        executable: false,
        owner:      tokenProgramId,
        lamports:   1n as Lamports,
        space:      0n,
        data:       new Uint8Array(),
      };
      forkSvm.setAccount(nonExistentAddress, acc);
      assert.deepStrictEqual(await forkSvm.getAccount(nonExistentAddress), acc);
    });
  });

  describe("getAccount", () => {
    it("should return account info for a single address", async () => {
      await forkSvm.airdrop(payer, rentExempt);
      const account = await forkSvm.getAccount(payer);
      assert(account);
      assert.strictEqual(account.lamports, rentExempt);
    });

    it("should return account info for multiple addresses", async () => {
      const signer2 = await generateKeyPairSigner();
      const payer2 = signer2.address;
      await forkSvm.airdrop(payer, rentExempt);
      await forkSvm.airdrop(payer2, rentExempt + 1000n);

      const accounts = await forkSvm.getAccount([payer, payer2]);
      assert(Array.isArray(accounts));
      assert.strictEqual(accounts.length, 2);
      assert.strictEqual(accounts[0]?.lamports, rentExempt);
      assert.strictEqual(accounts[1]?.lamports, rentExempt + 1000n);
    });

    it("should return token account data", async () => {
      await forkSvm.airdrop(payer, 1000000n);
      const curried = createCurried(forkSvm);
      curried.createMint(mint, { mintAuthority: payer });
      curried.createAta(payer, mint, 1000n);

      const account = await forkSvm.getAccount(tokenAccount);
      assert(account);
      assert.strictEqual(account.owner, tokenProgramId);
      assert(account.data.length > 0);
    });
  });

  describe("airdrop", () => {
    it("should airdrop lamports to an address", async () => {
      await forkSvm.airdrop(payer, rentExempt);
      const account = await forkSvm.getAccount(payer);
      assert(account);
      assert.strictEqual(account.lamports, rentExempt);
    });

    //a failed airdrop used to be swallowed, leaving the account silently absent
    it("throws when the airdrop leaves the recipient below rent exemption", async () => {
      await assert.rejects(
        () => forkSvm.airdrop(payer, rentExempt - 1n),
        (err: unknown) => err instanceof FailedTransactionMetadata,
      );
      assert.strictEqual(await forkSvm.getAccount(payer), null);
    });
  });

  describe("setClock", () => {
    it("should set the clock timestamp and slot", () => {
      const timestamp = new Date("2024-01-01T00:00:00Z");
      const slot = 100n;
      forkSvm.setClock({ timestamp, slot });

      const clockTimestamp = forkSvm.latestTimestamp();
      const clockSlot = forkSvm.latestSlot();

      assert.strictEqual(clockTimestamp.getTime(), timestamp.getTime());
      assert.strictEqual(clockSlot, slot);
    });

    it("floors a sub-second timestamp instead of throwing", () => {
      forkSvm.setClock({ timestamp: new Date("2024-01-01T00:00:00.500Z") });
      assert.strictEqual(
        forkSvm.latestTimestamp().getTime(),
        Date.parse("2024-01-01T00:00:00Z"),
      );
    });
  });

  describe("sendTransaction", () => {
    it("should send a transaction and return metadata", async () => {
      await forkSvm.airdrop(payer, 1000000n);
      const curried = createCurried(forkSvm);
      const tx = await curried.createAndSendTx([], payerSigner);

      assert(tx);
      assert(typeof tx.signature === 'function');
      assert(typeof tx.logs === 'function');
      assert(typeof tx.computeUnitsConsumed === 'function');
    });
  });

  describe("simulateTransaction", () => {
    it("should simulate a transaction and return metadata", async () => {
      await forkSvm.airdrop(payer, 1000000n);
      const curried = createCurried(forkSvm);
      const tx = await curried.createTx([], payerSigner);
      const blockhashStr = forkSvm.latestBlockhash();
      const slot = forkSvm.latestSlot();
      const blockhash = { blockhash: blockhashStr as Blockhash, lastValidBlockHeight: slot };
      const txWithLifetime = setTransactionMessageLifetimeUsingBlockhash(blockhash, tx);
      const compiled = compileTransaction(txWithLifetime);
      const signed = await signTransaction([payerSigner.keyPair], compiled);

      const result = await forkSvm.simulateTransaction(signed);
      assert(result);
      assert(typeof result.logs === 'function');
      assert(typeof result.computeUnitsConsumed === 'function');
      const logs = result.logs();
      assert(Array.isArray(logs));
    });
  });

  describe("RPC client", () => {
    let rpc: Client;

    beforeEach(() => {
      rpc = forkSvm.createForkRpc();
    });

    describe("getAccountInfo", () => {
      it("should return account info via RPC", async () => {
        await forkSvm.airdrop(payer, rentExempt);

        const accountInfo = await rpc.getAccountInfo(payer, { encoding: "base64" }).send();

        assert(accountInfo.value);
        assert.strictEqual(accountInfo.value.lamports, rentExempt);
        assert(accountInfo.value.data);
      });

      it("should return null for non-existent account", async () => {
        const accountInfo =
          await rpc.getAccountInfo(nonExistentAddress, { encoding: "base64" }).send();
        assert.strictEqual(accountInfo.value, null);
      });

      it("should return token account info", async () => {
        await forkSvm.airdrop(payer, 1000000n);
        const curried = createCurried(forkSvm);
        curried.createMint(mint, { mintAuthority: payer });
        curried.createAta(payer, mint, 5000n);

        const accountInfo = await rpc.getAccountInfo(tokenAccount, { encoding: "base64" }).send();

        assert(accountInfo.value);
        assert.strictEqual(accountInfo.value.owner, tokenProgramId);
      });
    });

    describe("getMultipleAccounts", () => {
      it("should return multiple account infos via RPC", async () => {
        const signer2 = await generateKeyPairSigner();
        const payer2 = signer2.address;
        await forkSvm.airdrop(payer, rentExempt);
        await forkSvm.airdrop(payer2, rentExempt + 1000n);

        const accounts =
          await rpc.getMultipleAccounts([payer, payer2], { encoding: "base64" }).send();

        assert.strictEqual(accounts.value.length, 2);
        assert(accounts.value[0]);
        assert.strictEqual(accounts.value[0]?.lamports, rentExempt);
        assert(accounts.value[1]);
        assert.strictEqual(accounts.value[1]?.lamports, rentExempt + 1000n);
      });
    });

    describe("getBalance", () => {
      it("should return account balance via RPC", async () => {
        await forkSvm.airdrop(payer, rentExempt);

        const balance = await rpc.getBalance(payer).send();

        assert.strictEqual(balance.value, rentExempt);
      });

      it("should return 0 for non-existent account", async () => {
        const balance = await rpc.getBalance(nonExistentAddress).send();
        assert.strictEqual(balance.value, 0n);
      });
    });

    describe("getLatestBlockhash", () => {
      it("should return latest blockhash via RPC", async () => {
        const blockhash = await rpc.getLatestBlockhash().send();

        assert(blockhash.value.blockhash);
        assert(typeof blockhash.value.blockhash === "string");
        //a fork's blockhash expires on expireBlockhash alone, never by height
        assert.strictEqual(blockhash.value.lastValidBlockHeight, 2n ** 64n - 1n);
      });
    });

    describe("sendTransaction", () => {
      it("should send a transaction and return a signature", async () => {
        await forkSvm.airdrop(payer, 1000000n);
        const curried = createCurried(forkSvm);
        const tx = await curried.createTx([], payerSigner);
        const blockhashStr = forkSvm.latestBlockhash();
        const slot = forkSvm.latestSlot();
        const blockhash = { blockhash: blockhashStr as Blockhash, lastValidBlockHeight: slot };
        const txWithLifetime = setTransactionMessageLifetimeUsingBlockhash(blockhash, tx);
        const compiled = compileTransaction(txWithLifetime);
        const signed = await signTransaction([payerSigner.keyPair], compiled);
        const wireTx = getBase64EncodedWireTransaction(signed);

        const signature = await rpc.sendTransaction(wireTx, { encoding: "base64" }).send();

        assert(signature, `Expected signature but got: ${signature}`);
        assert(
          typeof signature === "string",
          `Expected string but got type: ${typeof signature}, value: ${signature}`
        );

        // Decode the base58 signature to verify it's 64 bytes
        const signatureBytes = base58.decode(signature);
        assert.strictEqual(
          signatureBytes.length,
          64,
          `Expected signature to decode to 64 bytes but got: ${signatureBytes.length}`
        );
      });
    });

    describe("simulateTransaction", () => {
      it("should simulate a successful transaction", async () => {
        await forkSvm.airdrop(payer, 1000000n);
        const curried = createCurried(forkSvm);
        const tx = await curried.createTx([], payerSigner);
        const blockhashStr = forkSvm.latestBlockhash();
        const slot = forkSvm.latestSlot();
        const blockhash = { blockhash: blockhashStr as Blockhash, lastValidBlockHeight: slot };
        const txWithLifetime = setTransactionMessageLifetimeUsingBlockhash(blockhash, tx);
        const compiled = compileTransaction(txWithLifetime);
        const signed = await signTransaction([payerSigner.keyPair], compiled);
        const wireTx = getBase64EncodedWireTransaction(signed);

        const result = await rpc.simulateTransaction(wireTx, { encoding: "base64" }).send();

        assert.strictEqual(result.value.err, null);
        assert(Array.isArray(result.value.logs));
        assert(typeof result.value.unitsConsumed === "bigint");
      });

      it("should include innerInstructions when requested", async () => {
        await forkSvm.airdrop(payer, 1000000n);
        const curried = createCurried(forkSvm);
        const tx = await curried.createTx([], payerSigner);
        const blockhashStr = forkSvm.latestBlockhash();
        const slot = forkSvm.latestSlot();
        const blockhash = { blockhash: blockhashStr as Blockhash, lastValidBlockHeight: slot };
        const txWithLifetime = setTransactionMessageLifetimeUsingBlockhash(blockhash, tx);
        const compiled = compileTransaction(txWithLifetime);
        const signed = await signTransaction([payerSigner.keyPair], compiled);
        const wireTx = getBase64EncodedWireTransaction(signed);

        const result = await rpc.simulateTransaction(wireTx, {
          encoding: "base64",
          innerInstructions: true,
        }).send();

        assert.strictEqual(result.value.err, null);
        assert(result.value.innerInstructions === null ||
               Array.isArray(result.value.innerInstructions));
      });
    });

    describe("getTransaction", () => {
      it("should return transaction metadata for a sent transaction", async () => {
        await forkSvm.airdrop(payer, 1000000n);
        const curried = createCurried(forkSvm);
        const tx = await curried.createAndSendTx([], payerSigner);
        const signature = base58.encode(tx.signature()) as Signature;

        const result = await rpc.getTransaction(signature, { encoding: "base64" }).send();

        assert(result);
        assert.strictEqual(result.slot, forkSvm.latestSlot());
        assert(result.meta);
        assert.strictEqual(result.meta.err, null);
        assert(Array.isArray(result.meta.logMessages));
      });

      it("should return null for non-existent transaction", async () => {
        const fakeSignature = base58.encode(new Uint8Array(64).fill(1)) as Signature;
        const result = await rpc.getTransaction(fakeSignature, { encoding: "base64" }).send();
        assert.strictEqual(result, null);
      });
    });

    describe("unavailable fields", () => {
      let transactionResult: any;

      beforeEach(async () => {
        await forkSvm.airdrop(payer, 1000000n);
        const curried = createCurried(forkSvm);
        const tx = await curried.createAndSendTx([], payerSigner);
        const signature = base58.encode(tx.signature()) as Signature;
        const response = await rpc.getTransaction(signature, { encoding: "base64" }).send();
        assert(response, "getTransaction should return a result");
        // Handle both wrapped and unwrapped responses
        transactionResult = (response as any).value ?? response;
        assert(transactionResult, "transaction result should exist");
        assert(transactionResult.meta, "meta should exist on transaction result");
      });

      testUnavailableField(
        () => transactionResult.transaction,
        "transaction",
        "transaction"
      );

      testUnavailableField(
        () => transactionResult.meta.fee,
        "meta.fee",
        "fee"
      );

      testUnavailableField(
        () => transactionResult.meta.preBalances,
        "meta.preBalances",
        "preBalances"
      );

      testUnavailableField(
        () => transactionResult.meta.preBalances[0],
        "meta.preBalances[0]",
        "preBalances"
      );

      testUnavailableField(
        () => transactionResult.meta.postBalances,
        "meta.postBalances",
        "postBalances"
      );

      testUnavailableField(
        () => transactionResult.meta.preTokenBalances,
        "meta.preTokenBalances",
        "preTokenBalances"
      );

      testUnavailableField(
        () => transactionResult.meta.postTokenBalances,
        "meta.postTokenBalances",
        "postTokenBalances"
      );

      testUnavailableField(
        () => transactionResult.meta.rewards,
        "meta.rewards",
        "rewards"
      );
    });

    describe("encoding validation", () => {
      it("should reject non-base64 encoding for getAccountInfo", async () => {
        await assert.rejects(
          () => rpc.getAccountInfo(payer, { encoding: "base58" }).send(),
          /Unsupported encoding: base58, expected "base64"/
        );
      });

      it("should reject non-base64 encoding for getMultipleAccounts", async () => {
        await assert.rejects(
          () => rpc.getMultipleAccounts([payer], { encoding: "base58" }).send(),
          /Unsupported encoding: base58, expected "base64"/
        );
      });
    });
  });
});

const TestToken = kind(
  "TestToken",
  [ { symbols: [{ symbol: "TOK"  }] },
    { symbols: [{ symbol: "µTOK" }], oom:  -6 } ],
  { human: "TOK", atomic: "µTOK" },
);

describe("forkSvm utils", () => {
  let forkSvm: ForkSvm;
  let mint: Address;
  let curried: ReturnType<typeof createCurried<undefined>>;

  beforeEach(async () => {
    forkSvm = new ForkSvm();
    mint = (await generateKeyPairSigner()).address;
    curried = createCurried(forkSvm);
  });

  describe("assertTxSuccess", () => {
    it("should return metadata on success", async () => {
      const signer = await generateKeyPairSigner();
      await forkSvm.airdrop(signer.address, 10n ** 9n);

      const metadata = await assertTxSuccess(
        curried.createAndSendTx([], signer)
      );

      assert(metadata);
      assert(typeof metadata.computeUnitsConsumed === "function");
    });

    it("should throw FailedTransactionMetadata on failure", async () => {
      const signer = await generateKeyPairSigner();
      // No airdrop - transaction will fail due to insufficient funds for fee

      await assert.rejects(
        assertTxSuccess(curried.createAndSendTx([], signer)),
        (err: Error) => err.message.includes("tx should succeed but failed")
      );
    });
  });

  describe("createCurried without solKind", () => {
    it("should create accounts with bigint lamports", async () => {
      const { address: addr } = await generateKeyPairSigner();

      curried.createAccount(addr, {
        data: new Uint8Array(0),
        programId: systemProgramId,
        lamports: 1_000_000n as Lamports,
      });

      const account = await forkSvm.getAccount(addr);
      assert(account);
      assert.strictEqual(account.lamports, 1_000_000n);
    });

    it("should get balance as bigint", async () => {
      const { address: addr } = await generateKeyPairSigner();
      await forkSvm.airdrop(addr, 5_000_000n);

      const balance = await curried.getBalance(addr);

      assert.strictEqual(balance, 5_000_000n);
    });

    it("should return 0n for non-existent account balance", async () => {
      const { address: addr } = await generateKeyPairSigner();

      const balance = await curried.getBalance(addr);
      assert.strictEqual(balance, 0n);
    });

    it("should return 0n for non-existent accounts in array", async () => {
      const existing = await generateKeyPairSigner();
      const nonExistent = await generateKeyPairSigner();
      await forkSvm.airdrop(existing.address, 5_000_000n);

      const balances = await curried.getBalance([existing.address, nonExistent.address]);

      assert(Array.isArray(balances));
      assert.strictEqual(balances[0], 5_000_000n);
      assert.strictEqual(balances[1], 0n);
    });

    it("should create and send transactions", async () => {
      const signer = await generateKeyPairSigner();
      await forkSvm.airdrop(signer.address, 10n ** 9n);

      const metadata = await curried.createAndSendTx([], signer);

      assert(metadata);
      const logs = metadata.logs();
      assert(Array.isArray(logs));
    });
  });

  describe("createCurried with solKind (Amount support)", () => {
    it("should create accounts with Amount lamports", async () => {
      const { address: addr } = await generateKeyPairSigner();
      const curried = createCurried(forkSvm, Sol);

      curried.createAccount(addr, {
        data: new Uint8Array(0),
        programId: systemProgramId,
        lamports: sol(1),
      });

      const account = await forkSvm.getAccount(addr);
      assert(account);
      assert.strictEqual(account.lamports, 10n ** 9n);
    });

    it("should get balance as Amount when kind is passed", async () => {
      const { address: addr } = await generateKeyPairSigner();
      await forkSvm.airdrop(addr, 10n ** 9n);

      const curried = createCurried(forkSvm, Sol);
      const balance = await curried.getBalance(addr);

      assert(balance instanceof Amount);
      assert.strictEqual(balance.in("atomic"), 10n ** 9n);
    });

    it("should return zero Amount for non-existent account when solKind provided", async () => {
      const { address: addr } = await generateKeyPairSigner();
      const curried = createCurried(forkSvm, Sol);
      const balance = await curried.getBalance(addr);

      assert(balance instanceof Amount);
      assert.strictEqual(balance.in("atomic"), 0n);
    });
  });

  describe("createAta", () => {
    it("should create ATA with bigint balance", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner });

      const ata = curried.createAta(owner, mint, 1000n);

      const account = await forkSvm.getAccount(ata);
      assert(account);
      assert.strictEqual(account.owner, tokenProgramId);
    });

    it("should create native SOL ATA with rent + balance", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(nativeMint, { mintAuthority: owner });

      const tokenBalance = 500_000n;
      const ata = curried.createAta(owner, nativeMint, tokenBalance);

      const account = await forkSvm.getAccount(ata);
      assert(account);
      // Native SOL ATAs have lamports = rent + token balance
      assert(account.lamports > tokenBalance);
    });

    it("accepts a native-mint balance of solKind", async () => {
      const { address: owner } = await generateKeyPairSigner();
      const kinded = createCurried(forkSvm, Sol);
      kinded.createMint(nativeMint, { mintAuthority: owner });

      const ata = kinded.createAta(owner, nativeMint, sol(1));

      const account = await forkSvm.getAccount(ata);
      assert(account);
      assert(account.lamports > 10n ** 9n);
    });

    it("rejects a native-mint balance whose kind mismatches solKind", async () => {
      const { address: owner } = await generateKeyPairSigner();
      const kinded = createCurried(forkSvm, Sol);
      kinded.createMint(nativeMint, { mintAuthority: owner });

      //with a solKind set, the native mint pins the balance to that kind at the type level -
      //  the runtime guard remains for js callers and is what these assertions exercise
      assert.throws(
        //@ts-expect-error bigint balance while solKind is set
        () => kinded.createAta(owner, nativeMint, 1000n),
        /native mint/,
      );
      assert.throws(
        //@ts-expect-error Amount of a non-SOL kind
        () => kinded.createAta(owner, nativeMint, Amount.from(1, TestToken)),
        /native mint/,
      );
      assert.throws(
        //@ts-expect-error Amount balance while solKind is unset
        () => curried.createAta(owner, nativeMint, Amount.from(1, TestToken)),
        /native mint/,
      );
    });
  });

  describe("getTokenBalance", () => {
    it("should get token balance as bigint", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner });

      const tokenAmount = 42_000_000n;
      const ata = curried.createAta(owner, mint, tokenAmount);

      const balance = await curried.getTokenBalance()(ata);
      assert.strictEqual(balance, tokenAmount);
    });

    it("should get token balance as Amount with kind", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner });

      const atomicAmount = 42_000_000n;
      const ata = curried.createAta(owner, mint, atomicAmount);

      const balance = await curried.getTokenBalance(TestToken)(ata);

      assert(balance instanceof Amount);
      assert.strictEqual(balance.in("atomic"), atomicAmount);
    });

    it("should return 0 for non-existent token account", async () => {
      const { address: addr } = await generateKeyPairSigner();

      const balance = await curried.getTokenBalance()(addr);
      assert.strictEqual(balance, 0n);
    });

    it("should return 0 for non-existent token accounts in array", async () => {
      const { address: owner } = await generateKeyPairSigner();
      const nonExistent = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner });

      const tokenAmount = 42_000_000n;
      const ata = curried.createAta(owner, mint, tokenAmount);

      const balances = await curried.getTokenBalance()([ata, nonExistent.address]);

      assert(Array.isArray(balances));
      assert.strictEqual(balances[0], tokenAmount);
      assert.strictEqual(balances[1], 0n);
    });
  });

  describe("createTx and sendTx", () => {
    it("should create transaction with fee payer address", async () => {
      const signer = await generateKeyPairSigner();
      const addr = signer.address;
      await forkSvm.airdrop(addr, 10n ** 9n);

      const tx = await curried.createTx([], addr);

      assert(tx);
      assert.strictEqual(tx.feePayer.address, addr);
    });

    it("should create transaction with KeyPairSigner", async () => {
      const signer = await generateKeyPairSigner();
      await forkSvm.airdrop(signer.address, 10n ** 9n);

      const tx = await curried.createTx([], signer);

      assert(tx);
      assert.strictEqual(tx.feePayer.address, signer.address);
    });

    it("should send transaction and return metadata", async () => {
      const signer = await generateKeyPairSigner();
      await forkSvm.airdrop(signer.address, 10n ** 9n);

      const tx = await curried.createTx([], signer);
      const metadata = await curried.sendTx(tx, signer);

      assert(metadata);
      assert(typeof metadata.signature === "function");
    });
  });

  describe("createMint", () => {
    it("should create mint with bigint supply and default decimals", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner, supply: 1_000_000n });

      const mintData = await curried.getMint()(mint);

      assert(mintData);
      assert.strictEqual(mintData.mintAuthority, owner);
      assert.strictEqual(mintData.supply, 1_000_000n as Lamports);
      assert.strictEqual(mintData.decimals, 9);
    });

    it("should respect an explicit decimals option with bigint supply", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner, supply: 1_000_000n, decimals: 6 });

      const mintData = await curried.getMint()(mint);

      assert(mintData);
      assert.strictEqual(mintData.decimals, 6);
    });

    it("should create mint with Amount supply and calculate decimals from kind", async () => {
      const { address: owner } = await generateKeyPairSigner();
      const supplyAmount = Amount.from(1000, TestToken, "TOK");
      curried.createMint(mint, { mintAuthority: owner, supply: supplyAmount });

      const mintData = await curried.getMint()(mint);

      assert(mintData);
      assert.strictEqual(mintData.mintAuthority, owner);
      assert.strictEqual(mintData.decimals, 6);
      assert.strictEqual(mintData.supply, supplyAmount.in("atomic"));
    });
  });

  describe("getMint and getTokenAccount", () => {
    it("should get mint account", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner, supply: 1_000_000n });

      const mintData = await curried.getMint()(mint);

      assert(mintData);
      assert.strictEqual(mintData.mintAuthority, owner);
      assert.strictEqual(mintData.supply, 1_000_000n as Lamports);
      assert.strictEqual(mintData.decimals, 9);
    });

    it("should get token account", async () => {
      const { address: owner } = await generateKeyPairSigner();
      curried.createMint(mint, { mintAuthority: owner });

      const ata = curried.createAta(owner, mint, 500n);

      const tokenAccount = await curried.getTokenAccount()(ata);

      assert(tokenAccount);
      assert.strictEqual(tokenAccount.mint, mint);
      assert.strictEqual(tokenAccount.owner, owner);
      assert.strictEqual(tokenAccount.amount, 500n as Lamports);
    });
  });
});

//regression: only the program id was tracked, so a snapshot omitted the program data account
//  the upgradeable loader keeps the bytecode in; load returned normally and the program then
//  failed to execute. Reading that account in an offline fork likewise treated it as an
//  absent upstream account and overwrote it - the built-in programs' too
describe("added programs", () => {
  const programId = address("CustomProgram1111111111111111111111111111111");
  const programDataAddressOf = (program: { data: Uint8Array }) =>
    address(base58.encode(program.data.subarray(4, 36)));

  //the built-in token program's ELF, read out of its program data account past the loader's
  //  45-byte header (state tag, slot, upgrade authority)
  const tokenElf = async (forkSvm: ForkSvm) => {
    const token = (await forkSvm.getAccount(tokenProgramId))!;
    return (await forkSvm.getAccount(programDataAddressOf(token)))!.data.subarray(45);
  };

  const pokeProgram = async (forkSvm: ForkSvm, signed: Parameters<ForkSvm["sendTransaction"]>[0]) => {
    try {
      await forkSvm.sendTransaction(signed);
    }
    catch (err) {
      if (err instanceof FailedTransactionMetadata)
        return err;

      throw err;
    }
    throw new Error("expected the invalid instruction to fail");
  };

  it("survive save and load, program data included", async () => {
    const forkSvm = new ForkSvm();
    forkSvm.addProgram(programId, await tokenElf(forkSvm));
    const signer = await generateKeyPairSigner();
    await forkSvm.airdrop(signer.address, 10n ** 9n);
    const txMsg = await createCurried(forkSvm).createTx(
      [{ programAddress: programId, accounts: [], data: new Uint8Array([255]) }],
      signer,
    );
    const lifetime = {
      blockhash:            forkSvm.latestBlockhash() as Blockhash,
      lastValidBlockHeight: 0n,
    };
    const signed = await signTransaction(
      [signer.keyPair],
      compileTransaction(setTransactionMessageLifetimeUsingBlockhash(lifetime, txMsg)),
    );

    const before = await pokeProgram(forkSvm, signed);
    assert.doesNotMatch(before.toString(), /not deployed|UnsupportedProgramId/);
    assert(before.meta().computeUnitsConsumed() > 0n);

    const snapshot = forkSvm.save();
    const programData = programDataAddressOf((await forkSvm.getAccount(programId))!);
    assert(programData in snapshot.accounts);

    const after = await pokeProgram(ForkSvm.load(snapshot), signed);
    assert.strictEqual(after.toString(), before.toString());
  });

  it("keep their program data through an offline read, as the built-in programs do", async () => {
    const forkSvm = new ForkSvm();
    forkSvm.addProgram(programId, await tokenElf(forkSvm));
    for (const id of [programId, tokenProgramId]) {
      const programData = programDataAddressOf((await forkSvm.getAccount(id))!);
      assert.notStrictEqual(await forkSvm.getAccount(programData), null);
    }
  });
});


describe("ForkSvm review regressions", () => {
  let forkSvm: ForkSvm;
  let payer: Address;
  let payerSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;

  beforeEach(async () => {
    forkSvm = new ForkSvm();
    payerSigner = await generateKeyPairSigner();
    payer = payerSigner.address;
  });

  //a snapshot records how many expirations lead to its blockhash, so load replays exactly that
  //  many and a mismatch is reported as one, not as "not on the chain"
  it("restores a snapshot taken after many expirations and names a mismatch", () => {
    for (let i = 0; i < 70_000; ++i)
      forkSvm.expireBlockhash();
    const snapshot = forkSvm.save();
    assert.strictEqual(snapshot.expirations, 70_000);
    const restored = ForkSvm.load(snapshot);
    assert.strictEqual(restored.latestBlockhash(), snapshot.blockhash);
    assert.throws(() => ForkSvm.load({ ...snapshot, blockhash: "bogus" }), /70000 expirations/);
  });

  //load builds the replacement in full before committing, so a snapshot that fails to restore
  //  leaves the instance as it was
  it("keeps the current VM when a load fails", async () => {
    await forkSvm.airdrop(payer, 1_000_000n);
    const snapshot = forkSvm.save();
    assert.throws(() => forkSvm.load({ ...snapshot, blockhash: "bogus" }));
    assert.strictEqual((await forkSvm.getAccount(payer))!.lamports, 1_000_000n);
  });

  //an address becomes known once its write succeeded, so a failed set does not suppress a
  //  later fetch of the same address or record a null in the snapshot
  it("does not track an address whose write failed", () => {
    const bad = "not an address" as Address;
    assert.throws(() => forkSvm.setAccount(bad, null));
    assert(!(bad in forkSvm.save().accounts));
  });

  //the slot and time of a sent transaction are recorded when it runs, not read off the
  //  current clock when it is queried
  it("reports the slot a transaction ran at after the clock moved on", async () => {
    await forkSvm.airdrop(payer, 1_000_000n);
    const tx = await createCurried(forkSvm).createAndSendTx([], payerSigner);
    const signature = base58.encode(tx.signature()) as Signature;
    const sentAt = forkSvm.latestSlot();
    forkSvm.setClock({ slot: sentAt + 1_000n });
    const rpc: Client = forkSvm.createForkRpc();
    const result = await rpc.getTransaction(signature, { encoding: "base64" }).send();
    assert.strictEqual(result!.slot, sentAt);
  });

  describe("RPC options", () => {
    it("honors dataSlice and keeps space whole", async () => {
      await forkSvm.airdrop(payer, 1_000_000n);
      forkSvm.setAccount(payer, { ...(await forkSvm.getAccount(payer))!, data: new Uint8Array([1, 2, 3, 4]) });
      const rpc: Client = forkSvm.createForkRpc();
      const sliced = await rpc.getAccountInfo(payer, { encoding: "base64", dataSlice: { offset: 1, length: 2 } }).send();
      assert.deepStrictEqual(sliced.value!.data[0], "AgM=");
      assert.strictEqual(sliced.value!.space, 4n);
      const none = await rpc.getMultipleAccounts([payer], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send();
      assert.strictEqual(none.value[0]!.data[0], "");
    });

    it("refuses an option it would otherwise silently ignore", async () => {
      const rpc: Client = forkSvm.createForkRpc();
      await assert.rejects(
        rpc.simulateTransaction("" as any, { encoding: "base64", replaceRecentBlockhash: true }).send(),
        /Unsupported option for simulateTransaction: replaceRecentBlockhash/,
      );
    });

    it("checks minContextSlot against the fork's slot", async () => {
      const rpc: Client = forkSvm.createForkRpc();
      const slot = forkSvm.latestSlot();
      await rpc.getBalance(payer, { minContextSlot: slot }).send();
      await assert.rejects(rpc.getBalance(payer, { minContextSlot: slot + 1n }).send(), /Minimum context slot/);
    });

    it("checks the config of a method that takes it as its only argument", async () => {
      const rpc: Client = forkSvm.createForkRpc();
      const slot = forkSvm.latestSlot();
      await rpc.getLatestBlockhash({ minContextSlot: slot }).send();
      await assert.rejects(rpc.getLatestBlockhash({ minContextSlot: slot + 1n }).send(), /Minimum context slot/);
      await assert.rejects(
        rpc.getLatestBlockhash({ bogus: true } as any).send(),
        /Unsupported option for getLatestBlockhash: bogus/,
      );
    });
  });
});
