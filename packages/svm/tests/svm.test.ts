import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { getProgramDerivedAddress, getAddressEncoder,
         pipe, createTransactionMessage,
         setTransactionMessageFeePayer,
         setTransactionMessageLifetimeUsingBlockhash,
         appendTransactionMessageInstruction, compileTransaction } from "@solana/kit";
import { serialize, deserialize, calcStaticSize } from "@onrail-xyz/binary-layout";
import { base58 } from "../src/encoding.js";
import { sha256 } from "../src/hashing.js";
import { findPdaAndBump, calcPda, findAta, composeCreateAtaIx,
         discriminatorOf, anchorEmitCpiDiscriminator,
         minimumBalanceForRentExemption, mintAccountLayout,
         tokenAccountLayout, offchainMessageLayout,
         minTxSize, maxUsableTxSize, maxTxSize,
         systemProgramId, tokenProgramId,
         token2022ProgramId, associatedTokenProgramId, allAddresses } from "../src/index.js";

const addrEnc = getAddressEncoder();

describe("PDA derivation", () => {
  //cross-checked against @solana/kit's own getProgramDerivedAddress (the oracle)
  it("findPdaAndBump matches getProgramDerivedAddress for a string seed", async () => {
    const [pda, bump] = findPdaAndBump("metadata", tokenProgramId);
    const [kitPda, kitBump] = await getProgramDerivedAddress({
      programAddress: tokenProgramId,
      seeds: [new TextEncoder().encode("metadata")],
    });
    assert.strictEqual(pda, kitPda);
    assert.strictEqual(bump, kitBump);
  });

  it("findAta matches the canonical [owner, tokenProgram, mint] derivation", async () => {
    const owner = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
    const mint  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address; //USDC
    for (const tokenProgram of [undefined, tokenProgramId, token2022ProgramId]) {
      const ata = findAta(tokenProgram === undefined
        ? { owner, mint }
        : { owner, mint, tokenProgram });
      const [kitAta] = await getProgramDerivedAddress({
        programAddress: associatedTokenProgramId,
        seeds: [
          addrEnc.encode(owner),
          addrEnc.encode(tokenProgram ?? tokenProgramId),
          addrEnc.encode(mint),
        ],
      });
      assert.strictEqual(ata, kitAta);
    }
  });

  //a single vector can't catch a wrong off-curve predicate (bump 255 is off-curve ~50% of the
  //  time), so sweep a deterministic pseudo-random corpus that exercises many bumps
  it("findPdaAndBump matches the oracle across a deterministic corpus", async () => {
    let entropy = sha256(new Uint8Array([0x5e, 0xed]));
    const next = (n: number) => {
      const out = entropy.subarray(0, n);
      entropy = sha256(entropy);
      return out;
    };
    const bumpsSeen = new Set<number>();
    for (let i = 0; i < 64; ++i) {
      const seeds = Array.from({ length: 1 + (i % 3) }, () => next(1 + (i % 32)));
      const programId = base58.encode(next(32)) as Address;
      const [pda, bump] = findPdaAndBump(seeds[0]!, ...seeds.slice(1), programId);
      const [kitPda, kitBump] =
        await getProgramDerivedAddress({ programAddress: programId, seeds });
      assert.strictEqual(pda, kitPda, `seed set ${i}`);
      assert.strictEqual(bump, kitBump, `seed set ${i}`);
      assert.strictEqual(calcPda(seeds[0]!, ...seeds.slice(1), bump, programId), pda);
      bumpsSeen.add(bump);
    }
    assert(bumpsSeen.size > 1, "corpus must exercise more than one bump");
  });
});

describe("PDA seed validation", () => {
  //`new Uint8Array([bump])` wrapped silently, so calcPda(seed, 256, pid) was calcPda(seed, 0, pid)
  it("rejects a bump outside a byte", () => {
    for (const bump of [-1, 256, 1.5, NaN])
      assert.throws(() => calcPda("seed", bump, tokenProgramId), /bump must be an integer/);
  });

  //regression: any in-range bump was accepted, so a wrong bump gave a wrong, on-curve address
  it("rejects a bump that lands on the curve", () => {
    const onCurve = [];
    for (let bump = 0; bump < 256; ++bump)
      try { calcPda("seed", bump, tokenProgramId); } catch (e) { onCurve.push([bump, e]); }
    assert(onCurve.length > 0, "some bump lands on the curve");
    assert.match((onCurve[0]![1] as Error).message, /off-curve/);
    const [, bump] = findPdaAndBump("seed", tokenProgramId);
    assert(!onCurve.some(([b]) => b === bump));
  });

  it("rejects a seed longer than 32 bytes", () => {
    assert.throws(() => findPdaAndBump(new Uint8Array(33), tokenProgramId), /maximum length/);
  });

  it("rejects more than 15 non-empty seeds (the bump takes the 16th slot)", () => {
    const seeds = Array.from({ length: 15 }, () => Uint8Array.from([1]));
    assert.throws(
      () => findPdaAndBump(Uint8Array.from([1]), ...seeds, tokenProgramId),
      /Seed count/,
    );
  });

  it("accepts 15 non-empty seeds", () => {
    const seeds = Array.from({ length: 14 }, () => Uint8Array.from([1]));
    findPdaAndBump(Uint8Array.from([1]), ...seeds, tokenProgramId);
  });

  //empty seeds contribute nothing to the hash but still occupy a slot, exactly as in the
  //  runtime - kit rejects this same input with "Received: 17"
  it("counts empty seeds, matching the runtime's limit", () => {
    const seeds = Array.from({ length: 15 }, () => Uint8Array.from([1]));
    assert.throws(
      () => findPdaAndBump(new Uint8Array(0), ...seeds, tokenProgramId),
      /Seed count/,
    );
  });
});

describe("anchor discriminators", () => {
  it("instruction 'initialize' matches the known anchor vector", () => {
    // sha256("global:initialize")[0:8]
    assert.deepStrictEqual(
      discriminatorOf("instruction", "initialize"),
      Uint8Array.from([0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed]),
    );
  });

  //anchor's EVENT_IX_TAG = 0x1d9acb512ea545e4, emitted as its little-endian bytes
  it("anchorEmitCpiDiscriminator matches EVENT_IX_TAG_LE", () => {
    assert.deepStrictEqual(
      anchorEmitCpiDiscriminator,
      Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]),
    );
  });
});

describe("SPL account sizes", () => {
  //the canonical spl-token Mint::LEN and Account::LEN
  it("the mint and token layouts have the sizes the on-chain structs do", () => {
    assert.strictEqual(calcStaticSize(mintAccountLayout()), 82);
    assert.strictEqual(calcStaticSize(tokenAccountLayout()), 165);
  });
});

describe("rent exemption", () => {
  //the three amounts every Solana developer has memorized
  it("matches the well-known minimum balances", () => {
    assert.strictEqual(minimumBalanceForRentExemption(0), 890880n);
    assert.strictEqual(minimumBalanceForRentExemption(82), 1461600n); //mint
    assert.strictEqual(minimumBalanceForRentExemption(165), 2039280n); //token account
  });

  it("rejects a size that is not a non-negative integer", () => {
    for (const size of [-1, 1.5, NaN, 2 ** 53])
      assert.throws(() => minimumBalanceForRentExemption(size), /non-negative integer/);
  });
});

describe("create-ATA instruction", () => {
  const payer = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
  const owner = "5QxkJGkYTxkJBp575w39Qumi8v2g3bxLWaXjpJsquYky" as Address;
  const mint  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;

  it("uses the spl-associated-token-account account order and discriminant", () => {
    const ix = composeCreateAtaIx({ payer, owner, mint });
    assert.strictEqual(ix.programAddress, associatedTokenProgramId);
    assert.deepStrictEqual(ix.accounts.map(({ address }) => address), [
      payer, findAta({ owner, mint }), owner, mint, systemProgramId, tokenProgramId,
    ]);
    //WRITABLE_SIGNER, WRITABLE, then read-only
    assert.deepStrictEqual(ix.accounts.map(({ role }) => role), [3, 1, 0, 0, 0, 0]);
    assert.deepStrictEqual(ix.data, Uint8Array.from([1])); //CreateIdempotent
  });

  it("uses discriminant 0 for the non-idempotent variant and honors tokenProgram", () => {
    const tokenProgram = token2022ProgramId;
    const ix = composeCreateAtaIx({ payer, owner, mint, tokenProgram }, false);
    assert.deepStrictEqual(ix.data, Uint8Array.from([0])); //Create
    assert.strictEqual(ix.accounts[1]!.address, findAta({ owner, mint, tokenProgram }));
    assert.strictEqual(ix.accounts[5]!.address, tokenProgram);
  });
});

describe("constants", () => {
  it("are all distinct 32-byte base58 addresses", () => {
    assert.strictEqual(new Set(allAddresses).size, allAddresses.length);
    for (const address of allAddresses)
      assert.strictEqual(base58.decode(address).length, 32, address);
  });
});

describe("offchain message layout", () => {
  //regression: the signing domain begins with a raw 0xff byte. Encoding "\xff..." via utf8
  //  previously produced 0xc3 0xbf (17 bytes) instead of the correct 16-byte domain.
  const expectedDomain = Uint8Array.from([0xff, ...new TextEncoder().encode("solana offchain")]);

  it("emits the correct 16-byte signing domain", () => {
    const ocm = { messageFormat: "RestrictedAscii", message: "hi" } as const;
    const encoded = serialize(offchainMessageLayout, ocm);
    assert.strictEqual(expectedDomain.length, 16);
    assert.deepStrictEqual(encoded.subarray(0, 16), expectedDomain);
    assert.strictEqual(encoded[0], 0xff);
  });

  it("round-trips format and message", () => {
    const msg = { messageFormat: "LimitedUtf8", message: "hello world" } as const;
    const decoded = deserialize(offchainMessageLayout, serialize(offchainMessageLayout, msg));
    assert.strictEqual(decoded.messageFormat, "LimitedUtf8");
    assert.strictEqual(decoded.message, "hello world");
  });

  //regression: the format and the message were independent fields, so the layout admitted
  //  what the Rust decoder rejects
  it("enforces the format's rules on the message", () => {
    const enc = (messageFormat: "RestrictedAscii" | "LimitedUtf8" | "ExtendedUtf8", message: string) =>
      serialize(offchainMessageLayout, { messageFormat, message });
    assert.throws(() => enc("RestrictedAscii", ""), /must not be empty/);
    assert.throws(() => enc("RestrictedAscii", "héllo"), /printable ASCII/);
    assert.throws(() => enc("RestrictedAscii", "tab\there"), /printable ASCII/);
    assert.throws(() => enc("LimitedUtf8", "a".repeat(1213)), /exceeds 1212/);
    enc("LimitedUtf8", "é".repeat(606));
    assert.throws(() => enc("LimitedUtf8", "é".repeat(607)), /exceeds 1212/);
    enc("ExtendedUtf8", "a".repeat(1213));
    assert.throws(() => enc("ExtendedUtf8", "a".repeat(65516)), /exceeds 65515/);
    const bytes = enc("LimitedUtf8", "ok");
    bytes[16 + 1] = 0; //reads as RestrictedAscii, which "ok" satisfies
    deserialize(offchainMessageLayout, bytes);
  });
});

describe("tx size constants", () => {
  //cross-check minTxSize against a real minimal compiled+signed wire transaction
  it("minTxSize equals the wire size of a minimal one-instruction tx", () => {
    const feePayer = "11111111111111111111111111111112" as Address;
    const program  = "ComputeBudget111111111111111111111111111111" as Address;
    const blockhash = {
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 0n,
    } as const;

    const compiled = compileTransaction(pipe(
      createTransactionMessage({ version: "legacy" }),
      m => setTransactionMessageFeePayer(feePayer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(blockhash as any, m),
      m => appendTransactionMessageInstruction(
        { programAddress: program, accounts: [], data: new Uint8Array(0) }, m),
    ));
    const numSigners = Object.keys(compiled.signatures).length;
    const wireSize = 1 + 64 * numSigners + compiled.messageBytes.length;

    assert.strictEqual(minTxSize, wireSize);
  });

  //regression: the budget was maxTxSize - minTxSize, but past 127 bytes the data count
  //  takes two bytes where minTxSize counts one, so an instruction of that size overshot
  it("maxUsableTxSize fills a minimal tx to the byte", () => {
    const feePayer = "11111111111111111111111111111112" as Address;
    const program  = "ComputeBudget111111111111111111111111111111" as Address;
    const blockhash = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n } as const;
    const wireSizeWithData = (dataSize: number) => {
      const compiled = compileTransaction(pipe(
        createTransactionMessage({ version: "legacy" }),
        m => setTransactionMessageFeePayer(feePayer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(blockhash as any, m),
        m => appendTransactionMessageInstruction(
          { programAddress: program, accounts: [], data: new Uint8Array(dataSize) }, m),
      ));
      return 1 + 64 * Object.keys(compiled.signatures).length + compiled.messageBytes.length;
    };
    assert.strictEqual(wireSizeWithData(maxUsableTxSize), maxTxSize);
    assert.strictEqual(wireSizeWithData(maxUsableTxSize + 1), maxTxSize + 1);
  });
});
