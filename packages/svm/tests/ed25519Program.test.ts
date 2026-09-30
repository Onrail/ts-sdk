import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { RoUint8Array } from "@onrail-xyz/utils";
import { utf8, base64 } from "@onrail-xyz/utils";
import { base58 } from "../src/encoding.js";
import { composeEd25519VerifyIx,
         ed25519SigVerifyProgramId, maxUsableTxSize } from "../src/index.js";

const sk1 = new Uint8Array(32).fill(1);
const sk2 = new Uint8Array(32).fill(2);
const pk1 = ed25519.getPublicKey(sk1);
const pk2 = ed25519.getPublicKey(sk2);
const msgA = utf8.encode("onrail");
const msgB = utf8.encode("a slightly longer message");
const sigA1 = ed25519.sign(msgA, sk1);
const sigB1 = ed25519.sign(msgB, sk1);
const sigB2 = ed25519.sign(msgB, sk2);

const offsetsSize = 14;
const headerSize = (count: number) => 2 + count * offsetsSize;
const ownIx = 0xffff;

//parses the instruction data per the precompile's own definition (all fields u16 little-endian),
//  independently of the layout the implementation uses to write it
const parse = (roData: RoUint8Array) => {
  const data = roData as Uint8Array;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = data[0]!;
  assert.strictEqual(data[1], 0, "byte 1 must be padding");
  return {
    count,
    offsets: Array.from({ length: count }, (_, i) => {
      const at = 2 + i * offsetsSize;
      const u16 = (j: number) => dv.getUint16(at + 2 * j, true);
      return {
        signatureOffset:           u16(0),
        signatureInstructionIndex: u16(1),
        publicKeyOffset:           u16(2),
        publicKeyInstructionIndex: u16(3),
        messageDataOffset:         u16(4),
        messageDataSize:           u16(5),
        messageInstructionIndex:   u16(6),
      };
    }),
  };
};

describe("ed25519 verify instruction", () => {
  it("targets the precompile with no accounts", () => {
    const ix = composeEd25519VerifyIx({ publicKey: pk1, message: msgA, signature: sigA1 });
    assert.strictEqual(ix.programAddress, ed25519SigVerifyProgramId);
    assert.deepStrictEqual(ix.accounts, []);
  });

  it("lays out a single verification with offsets relative to the instruction data", () => {
    const ix = composeEd25519VerifyIx({ publicKey: pk1, message: msgA, signature: sigA1 });
    const { count, offsets } = parse(ix.data);
    assert.strictEqual(count, 1);
    assert.strictEqual(ix.data.length, headerSize(1) + 32 + 64 + msgA.length);

    const o = offsets[0]!;
    assert.deepStrictEqual(o, {
      signatureOffset:           headerSize(1) + 32,
      signatureInstructionIndex: ownIx,
      publicKeyOffset:           headerSize(1),
      publicKeyInstructionIndex: ownIx,
      messageDataOffset:         headerSize(1) + 32 + 64,
      messageDataSize:           msgA.length,
      messageInstructionIndex:   ownIx,
    });

    //the offsets must actually point at the data
    assert.deepStrictEqual(ix.data.subarray(o.publicKeyOffset, o.publicKeyOffset + 32), pk1);
    assert.deepStrictEqual(ix.data.subarray(o.signatureOffset, o.signatureOffset + 64), sigA1);
    assert.deepStrictEqual(
      ix.data.subarray(o.messageDataOffset, o.messageDataOffset + o.messageDataSize),
      msgA,
    );
  });

  it("accepts an Address as the public key and base58-decodes it", () => {
    const asBytes   = composeEd25519VerifyIx({ publicKey: pk1, message: msgA, signature: sigA1 });
    const asAddress = composeEd25519VerifyIx({
      publicKey: base58.encode(pk1) as Address, message: msgA, signature: sigA1,
    });
    assert.deepStrictEqual(asAddress.data, asBytes.data);
  });

  it("chains offsets across multiple verifications", () => {
    const ix = composeEd25519VerifyIx([
      { publicKey: pk1, message: msgA, signature: sigA1 },
      { publicKey: pk2, message: msgB, signature: sigB2 },
    ]);
    const { count, offsets } = parse(ix.data);
    assert.strictEqual(count, 2);
    assert.strictEqual(
      ix.data.length,
      headerSize(2) + 2 * (32 + 64) + msgA.length + msgB.length,
    );

    const expected = [
      { pk: pk1, sig: sigA1, msg: msgA },
      { pk: pk2, sig: sigB2, msg: msgB },
    ];
    offsets.forEach((o, i) => {
      const { pk, sig, msg } = expected[i]!;
      assert.strictEqual(o.publicKeyInstructionIndex, ownIx);
      assert.strictEqual(o.signatureInstructionIndex, ownIx);
      assert.strictEqual(o.messageInstructionIndex, ownIx);
      assert.strictEqual(o.messageDataSize, msg.length);
      assert.deepStrictEqual(ix.data.subarray(o.publicKeyOffset, o.publicKeyOffset + 32), pk);
      assert.deepStrictEqual(ix.data.subarray(o.signatureOffset, o.signatureOffset + 64), sig);
      assert.deepStrictEqual(
        ix.data.subarray(o.messageDataOffset, o.messageDataOffset + o.messageDataSize),
        msg,
      );
    });
  });

  it("appends identical data only once", () => {
    const ix = composeEd25519VerifyIx([
      { publicKey: pk1, message: msgA, signature: sigA1 },
      { publicKey: pk1, message: msgB, signature: sigB1 },
    ]);
    const { offsets } = parse(ix.data);
    assert.strictEqual(offsets[0]!.publicKeyOffset, offsets[1]!.publicKeyOffset);
    //the shared public key is stored once
    assert.strictEqual(
      ix.data.length,
      headerSize(2) + 32 + 2 * 64 + msgA.length + msgB.length,
    );
  });

  it("passes references through verbatim and appends nothing", () => {
    const ix = composeEd25519VerifyIx({
      publicKey: { ixIndex: 0, offset: 16 },
      signature: { ixIndex: 3, offset: 48 },
      message:   { ixIndex: 7, offset: 112, size: msgA.length },
    });
    assert.strictEqual(ix.data.length, headerSize(1));
    assert.deepStrictEqual(parse(ix.data).offsets[0], {
      signatureOffset:           48,
      signatureInstructionIndex: 3,
      publicKeyOffset:           16,
      publicKeyInstructionIndex: 0,
      messageDataOffset:         112,
      messageDataSize:           msgA.length,
      messageInstructionIndex:   7,
    });
  });

  it("mixes inline data and references", () => {
    const ix = composeEd25519VerifyIx({
      publicKey: pk1,
      signature: { ixIndex: 0, offset: 48 },
      message:   msgA,
    });
    const o = parse(ix.data).offsets[0]!;
    assert.strictEqual(o.publicKeyInstructionIndex, ownIx);
    assert.strictEqual(o.publicKeyOffset, headerSize(1));
    assert.strictEqual(o.signatureInstructionIndex, 0);
    assert.strictEqual(o.signatureOffset, 48);
    assert.strictEqual(o.messageInstructionIndex, ownIx);
    //the message follows the public key directly - no gap left for the absent signature
    assert.strictEqual(o.messageDataOffset, headerSize(1) + 32);
    assert.strictEqual(ix.data.length, headerSize(1) + 32 + msgA.length);
  });

  it("rejects an empty verification list", () => {
    assert.throws(() => composeEd25519VerifyIx([]), /At least one signature/);
  });

  it("rejects mis-sized public keys and signatures", () => {
    assert.throws(
      () => composeEd25519VerifyIx({ publicKey: new Uint8Array(31), message: msgA, signature: sigA1 }),
      /Expected data size 32/,
    );
    assert.throws(
      () => composeEd25519VerifyIx({ publicKey: pk1, message: msgA, signature: new Uint8Array(63) }),
      /Expected data size 64/,
    );
  });

  it("rejects data that would not fit into a transaction", () => {
    assert.throws(
      () => composeEd25519VerifyIx({
        publicKey: pk1, message: new Uint8Array(maxUsableTxSize), signature: sigA1,
      }),
      /exceed tx max size/,
    );
  });

  //these exact byte strings were verified on mainnet via simulateTransaction (which runs the
  //  precompile): the positive cases return no error, while flipping any single byte of a
  //  signature or message yields InstructionError(Custom(2)) == PrecompileError::InvalidSignature
  it("reproduces on-chain-verified byte vectors", () => {
    const vectors = [
      [ composeEd25519VerifyIx({ publicKey: pk1, message: msgA, signature: sigA1 }),
        "AQAwAP//EAD//3AABgD//4qI4910CfGV/VLbLTy6XXLKZwm/HZQSG/N0iAG0D29cp5dl7RayR7U9emqRoCD87" +
        "UbGvPuD+GQROvipbU8mAFVB6zIetXtSMvwa1KB21dPQEYC80w+J8JAl/wmKvT97DW9ucmFpbA==" ],
      [ composeEd25519VerifyIx([
          { publicKey: pk1, message: msgA, signature: sigA1 },
          { publicKey: pk2, message: msgB, signature: sigB2 },
        ]),
        "AgA+AP//HgD//34ABgD//6QA//+EAP//5AAZAP//iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1ynl" +
        "2XtFrJHtT16apGgIPztRsa8+4P4ZBE6+KltTyYAVUHrMh61e1Iy/BrUoHbV09ARgLzTD4nwkCX/CYq9P3sNb2" +
        "5yYWlsgTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5SHfhf08K2KJiBiTC0e10ELD2c91OkIWY/vGJu" +
        "9bNmQRU06o713DE83jEkUfmHhneN91jGy7MQnlVt17EzesOsNYSBzbGlnaHRseSBsb25nZXIgbWVzc2FnZQ==" ],
      [ composeEd25519VerifyIx([
          { publicKey: pk1, message: msgA, signature: sigA1 },
          { publicKey: pk1, message: msgB, signature: sigB1 },
        ]),
        "AgA+AP//HgD//34ABgD//4QA//8eAP//xAAZAP//iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1ynl" +
        "2XtFrJHtT16apGgIPztRsa8+4P4ZBE6+KltTyYAVUHrMh61e1Iy/BrUoHbV09ARgLzTD4nwkCX/CYq9P3sNb2" +
        "5yYWlsqx2Vyu/WUF4q6jAfC/orSflZgCBwdlBxQoM5wYvNqhYxSdaARlu21F9DpS8qSDLHbncAwWlRXdkAsUH" +
        "879oMAWEgc2xpZ2h0bHkgbG9uZ2VyIG1lc3NhZ2U=" ],
    ] as const;

    for (const [ix, expected] of vectors)
      assert.deepStrictEqual(ix.data, base64.decode(expected));
  });
});
