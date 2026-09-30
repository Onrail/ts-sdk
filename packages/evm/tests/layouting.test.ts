import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { encodeAbiParameters, decodeAbiParameters, getAddress,
         parseSignature, serializeCompactSignature, signatureToCompactSignature } from "viem";
import { utf8, hex, bignum } from "@onrail-xyz/utils";
import { serialize, deserialize, calcStaticSize, boolItem } from "@onrail-xyz/binary-layout";
import { keccak256 } from "../src/hashing.js";
import { type AbiParamValue, wordSize,
         selectorLength, selectorOf, paddedSlotLayout,
         paddedFields, abiEncodedBytesItem, addressItem,
         sigSwitchItem, signatureItem, abiSignatureItem,
         compactSignatureItem, uint256Item, abiParam,
         addressParam, amountParam, paramOf,
         sigVariant, addressConversion, bytesNItem, mappingSlot } from "../src/layouting.js";

describe("abiEncodedBytesItem", () => {
  const item = abiEncodedBytesItem();
  const viemEncode = (data: Uint8Array) =>
    hex.decode(encodeAbiParameters([{ type: "bytes" }], [hex.encode(data, true) as Hex]));

  //regression: postPadding was previously serialized as empty, so any payload length not
  //  divisible by 32 produced unaligned (i.e. invalid) abi encoding
  for (const len of [0, 1, 31, 32, 33, 64])
    it(`serializes a ${len}-byte payload identically to viem's abi.encode`, () => {
      const data = Uint8Array.from({ length: len }, (_, i) => i + 1);
      assert.deepStrictEqual(serialize(item, data), viemEncode(data));
    });

  it("round-trips", () => {
    const data = Uint8Array.from({ length: 5 }, (_, i) => i + 1);
    assert.deepStrictEqual(deserialize(item, serialize(item, data)), data);
  });

  //regression: the padding after the payload was dropped without a look, so a truncated
  //  encoding and a nonzero suffix both decoded
  it("rejects missing and nonzero padding", () => {
    const data = Uint8Array.from([1]);
    const canonical = serialize(item, data);
    assert.strictEqual(canonical.length, 96);
    assert.throws(() => deserialize(item, canonical.subarray(0, 65)), /padding bytes/);
    const dirty = Uint8Array.from(canonical);
    dirty[95] = 1;
    assert.throws(() => deserialize(item, dirty), /padding bytes/);
  });

  it("pads based on the serialized size of a nested layout", () => {
    const inner = {
      a: { binary: "uint",  size: 8 },
      b: { binary: "bytes", size: 3 },
    } as const;
    const nestedItem = abiEncodedBytesItem({ layout: inner });
    const value = { a: 42n, b: Uint8Array.from([1, 2, 3]) };

    assert.deepStrictEqual(serialize(nestedItem, value), viemEncode(serialize(inner, value)));
    assert.deepStrictEqual(deserialize(nestedItem, serialize(nestedItem, value)), value);
  });
});

describe("paddedSlotLayout", () => {
  it("throws on an item wider than a word", () => {
    assert.throws(() => paddedSlotLayout(signatureItem)); //65 bytes
  });

  it("throws on a dynamically sized item", () => {
    assert.throws(() => paddedSlotLayout({ binary: "bytes" }));
  });
});

describe("bytesNItem", () => {
  const tag = Uint8Array.from([1, 2, 3, 4]);

  //regression: a bare 4-byte bytes item on a slot was left-padded, which is bytesN's encoding
  //  read backwards - the ABI right-pads it, alone among the static types
  it("right-pads onto its word like the ABI's bytesN, where a bare bytes item is left-padded", () => {
    const viemWord = hex.decode(encodeAbiParameters([{ type: "bytes4" }], ["0x01020304"]));
    assert.deepStrictEqual(serialize(bytesNItem(4), tag), viemWord);
    assert.deepStrictEqual(serialize(paddedSlotLayout(bytesNItem(4)), tag), viemWord);
    assert.notDeepStrictEqual(serialize(paddedSlotLayout({ binary: "bytes", size: 4 }), tag), viemWord);
  });

  it("reads the bytes back", () => {
    assert.deepStrictEqual(deserialize(bytesNItem(4), serialize(bytesNItem(4), tag)), tag);
  });

  it("spells bytes32 as the plain word", () => {
    const word = new Uint8Array(wordSize).fill(0xab);
    assert.deepStrictEqual(serialize(bytesNItem(32), word), word);
  });

  it("rejects widths outside the ABI's", () => {
    assert.throws(() => bytesNItem(0), /not an ABI type/);
    assert.throws(() => bytesNItem(33), /not an ABI type/);
  });
});

describe("signed slot", () => {
  const int8 = paddedSlotLayout({ binary: "int", size: 1 });
  const word = (n: bigint) => serialize({ binary: "int", size: wordSize }, n);

  it("encodes and decodes within the declared width", () => {
    assert.deepStrictEqual(serialize(int8, -128), word(-128n));
    assert.strictEqual(deserialize(int8, word(127n)), 127);
  });

  //regression: only encoding was bounded, so a word outside the declared width decoded to a
  //  value the same layout refuses to encode
  it("rejects a word outside the declared width in both directions", () => {
    assert.throws(() => serialize(int8, 128), /does not fit/);
    assert.throws(() => deserialize(int8, word(128n)), /does not fit/);
    assert.throws(() => deserialize(int8, word(-129n)), /does not fit/);
  });
});

describe("paddedFields", () => {
  const alice = "0x1111111111111111111111111111111111111111";
  const layout = paddedFields({
    to: addressItem,
    amount: { binary: "uint", size: 8 },
    flag: boolItem()
  });
  const data = { to: alice, amount: 7n, flag: true } as const;

  it("puts every field on a slot of its own, in field order", () => {
    assert.equal(calcStaticSize(layout), 3 * wordSize);
    assert.equal(
      hex.encode(serialize(layout, data), true),
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint64" }, { type: "bool" }],
        [alice, 7n, true],
      ),
    );
  });

  it("reads the fields back", () => {
    assert.deepEqual(deserialize(layout, serialize(layout, data)), data);
  });
});

describe("sigSwitchItem", () => {
  const unauthorized = "Unauthorized()";
  const invalidNonce = "InvalidNonce(address,uint256)";
  const errorItem = sigSwitchItem(selectorLength, "error")([
    [unauthorized, {}],
    [invalidNonce, { sender: addressItem, provided: uint256Item }],
  ]);

  const sender = "0x0000000000000000000000000000000000000042" as const;

  it("encodes the selector as the id and abi-pads the params", () => {
    const encoded = serialize(errorItem, { error: "InvalidNonce", sender, provided: 7n });
    assert.deepStrictEqual(
      encoded,
      hex.decode(
        hex.encode(selectorOf(invalidNonce)) +
        sender.slice(2).padStart(2 * wordSize, "0") +
        (7).toString(16).padStart(2 * wordSize, "0"),
      ),
    );
    assert.deepStrictEqual(deserialize(errorItem, encoded), {
      error: "InvalidNonce", sender, provided: 7n,
    });
  });

  it("round-trips a paramless variant to its bare selector", () => {
    const encoded = serialize(errorItem, { error: "Unauthorized" });
    assert.deepStrictEqual(encoded, selectorOf(unauthorized));
    assert.deepStrictEqual(deserialize(errorItem, encoded), { error: "Unauthorized" });
  });

  it("switches on a full-word id, letting events keep their untruncated topic0", () => {
    const transferred = "AdminTransferred(address)";
    const eventItem = sigSwitchItem(wordSize, "event")([
      [transferred, { newAdmin: addressItem }],
    ]);
    const encoded = serialize(eventItem, { event: "AdminTransferred", newAdmin: sender });

    assert.deepStrictEqual(encoded.subarray(0, wordSize), keccak256(utf8.encode(transferred)));
    assert.deepStrictEqual(deserialize(eventItem, encoded), {
      event: "AdminTransferred", newAdmin: sender,
    });
  });

  it("rejects a prefix wider than the hash", () => {
    assert.throws(() => sigSwitchItem(33, "error")([[unauthorized, {}]]));
  });
});

describe("sigVariant", () => {
  it("spells the signature from the params and keeps them in wire order", () => {
    const moved = sigVariant("Moved",
      abiParam("who", "address", addressItem),
      abiParam("by", "uint256", uint256Item),
      abiParam("done", "bool", boolItem()));
    const sig: "Moved(address,uint256,bool)" = moved[0];
    assert.equal(sig, "Moved(address,uint256,bool)");
    assert.deepEqual(Object.keys(moved[1]), ["who", "by", "done"]);
    assert.equal(moved[1].who, addressItem);
    assert.equal(moved[1].by, uint256Item);
    assert.equal(moved[1].done.binary, "uint");
  });

  it("takes no params for a bare name", () => {
    assert.deepEqual(sigVariant("Paused"), ["Paused()", {}]);
  });

  //a repeated name folded two params into one struct field while the signature kept both
  it("rejects a repeated param name", () => {
    assert.throws(
      () => sigVariant(
        "Twice",
        abiParam("x", "uint256", uint256Item),
        abiParam("x", "bool", boolItem())
      ),
      /not distinct/,
    );
  });
});

describe("signature items", () => {
  //r ‖ s ‖ v with distinguishable words; s's top bit clear, as in a canonical (low-s) signature
  const packed = new Uint8Array([
    ...new Uint8Array(32).fill(0x11), ...new Uint8Array(32).fill(0x22), 28,
  ]);

  it("signatureItem is the packed form as is", () => {
    assert.deepStrictEqual(serialize(signatureItem, packed), packed);
  });

  it("abiSignatureItem spreads the packed bytes over the v, r, s words, and folds back", () => {
    const encoded = serialize(abiSignatureItem, packed);
    assert.strictEqual(encoded.length, 3 * wordSize);
    assert.deepStrictEqual(
      encoded,
      hex.decode(encodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
        [28, hex.encode(packed.subarray(0, 32), true), hex.encode(packed.subarray(32, 64), true)],
      )),
    );
    assert.deepStrictEqual(deserialize(abiSignatureItem, encoded), packed);
  });

  it("compactSignatureItem agrees with viem's EIP-2098 encoding, and folds back", () => {
    for (const v of [27, 28]) {
      const sig = new Uint8Array(packed); sig[64] = v;
      const encoded = serialize(compactSignatureItem, sig);
      assert.strictEqual(encoded.length, 64);
      assert.strictEqual(
        hex.encode(encoded, true),
        serializeCompactSignature(
          signatureToCompactSignature(parseSignature(hex.encode(sig, true))),
        ),
      );
      assert.deepStrictEqual(deserialize(compactSignatureItem, encoded), sig);
    }
  });

  //regression: the parity bit was OR-ed in unchecked, so v=29 folded to 27 and an s with its
  //  top bit set came back with the bit rewritten as the parity
  it("compactSignatureItem rejects a v outside {27, 28} and an s with its top bit set", () => {
    const badV = new Uint8Array(packed); badV[64] = 29;
    assert.throws(() => serialize(compactSignatureItem, badV), /v must be 27 or 28/);
    const highS = new Uint8Array(packed); highS[32] = 0x80;
    assert.throws(() => serialize(compactSignatureItem, highS), /top bit set/);
  });
});

describe("amountParam", () => {
  type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;

  it("states the ABI type and the item's width independently", () => {
    const word = amountParam("value", "uint256");
    const slim = amountParam("fee",   "uint256", undefined, 8);
    assert.strictEqual(word.type, "uint256");
    assert.strictEqual(calcStaticSize(word.item), wordSize);
    assert.strictEqual(slim.type, "uint256");
    assert.strictEqual(calcStaticSize(slim.item), 8);
  });

  //regression: the stated value type was bigint at every width, while an item of up to six
  //  bytes derives (and decodes to) a number
  it("states the primitive the item's width derives when no kind is given", () => {
    const word = amountParam("value", "uint256");
    const slim = amountParam("fee",   "uint256", undefined, 8);
    const tiny = amountParam("tip",   "uint32",  undefined, 4);
    const pin: [
      Mutual<AbiParamValue<typeof word>, bigint>,
      Mutual<AbiParamValue<typeof slim>, bigint>,
      Mutual<AbiParamValue<typeof tiny>, number>,
    ] = [true, true, true];
    assert.ok(pin);
    assert.strictEqual(deserialize(tiny.item, serialize(tiny.item, 7)), 7);
  });

  //the literal types survive a contextual type, which would otherwise supply an inference
  //  candidate from the return position and widen the signature to `${string}`
  it("keeps its literal type inside a contextually typed argument list", () => {
    const [sig] = sigVariant("Paid", amountParam("value", "uint256"),
                                     amountParam("fee", "uint64", undefined, 8));
    const sigPin: Mutual<typeof sig, "Paid(uint256,uint64)"> = true;
    assert.ok(sigPin);
    assert.strictEqual(sig, "Paid(uint256,uint64)");
  });
});

describe("abiParam", () => {
  type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;

  it("surfaces the item's type, or the one stated through the zero-argument overload", () => {
    const derived = abiParam("n", "uint256", uint256Item);
    const stated  = abiParam<string>()("n", "uint256", uint256Item);
    const pin: [
      Mutual<AbiParamValue<typeof derived>, bigint>,
      Mutual<AbiParamValue<typeof stated>, string>,
    ] = [true, true];
    assert.ok(pin);
    assert.deepEqual(stated, derived);
  });
});

describe("paramOf", () => {
  type Mutual<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;

  it("fixes the type and item and takes the name at each use", () => {
    const flag = boolItem();
    assert.deepEqual(paramOf("bool", flag)("isPaused"), abiParam("isPaused", "bool", flag));
    assert.deepEqual(addressParam("to"),                abiParam("to", "address", addressItem));
  });

  it("states the surfaced type through the zero-argument overload", () => {
    const stated = paramOf<string>()("uint256", uint256Item)("n");
    const pin: Mutual<AbiParamValue<typeof stated>, string> = true;
    assert.ok(pin);
    assert.deepEqual(stated, abiParam("n", "uint256", uint256Item));
  });

  it("keeps the name and type literal inside a contextually typed argument list", () => {
    const [sig] = sigVariant("Flagged", addressParam("who"), paramOf("bool", boolItem())("flag"));
    const sigPin: Mutual<typeof sig, "Flagged(address,bool)"> = true;
    assert.ok(sigPin);
    assert.strictEqual(sig, "Flagged(address,bool)");
  });
});

describe("addressItem", () => {
  const lower = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const bytes = hex.decode(lower);

  //viem's decoders return the checksummed spelling, so a lowercase one would make the same word
  //  decode to two strings that compare unequal
  it("surfaces the EIP-55 checksummed spelling, as viem does", () => {
    assert.strictEqual(addressConversion.to(bytes), getAddress(lower));
    assert.strictEqual(
      deserialize(addressItem, bytes),
      decodeAbiParameters([{ type: "address" }], encodeAbiParameters([{ type: "address" }],
        [lower as `0x${string}`]))[0],
    );
  });

  it("accepts either spelling on the way in, round-tripping the bytes", () => {
    assert.deepStrictEqual(serialize(addressItem, getAddress(lower)), bytes);
    assert.deepStrictEqual(serialize(addressItem, lower as `0x${string}`), bytes);
  });
});

describe("mappingSlot", () => {
  //the key's JS type selects Solidity's padding; viem's abi encoder is the reference for each
  const slot = 7n;
  const viemSlot = (type: string, key: unknown) =>
    bignum.fromBytes(keccak256(hex.decode(
      encodeAbiParameters([{ type }, { type: "uint256" }], [key, slot])
    )));
  const addr = getAddress("0x000000000000000000000000000000000000dEaD");

  it("pads each value type as Solidity does", () => {
    const deadbeef = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    assert.strictEqual(mappingSlot(42n, slot), viemSlot("uint256", 42n));
    assert.strictEqual(mappingSlot(42, slot), viemSlot("uint8", 42));
    assert.strictEqual(mappingSlot(-1n, slot), viemSlot("int256", -1n));
    assert.strictEqual(mappingSlot(-5n, slot), viemSlot("int8", -5));
    assert.strictEqual(mappingSlot(true, slot), viemSlot("bool", true));
    assert.strictEqual(mappingSlot(addr, slot), viemSlot("address", addr));
    assert.strictEqual(mappingSlot(deadbeef, slot), viemSlot("bytes4", "0xdeadbeef"));
    const word = Uint8Array.from({ length: 32 }, (_, i) => i);
    assert.strictEqual(mappingSlot(word, slot), viemSlot("bytes32", hex.encode(word, true)));
  });

  it("rejects an integer that does not fit a word", () => {
    assert.throws(() => mappingSlot(1n << 256n, slot), /does not fit/);
    assert.throws(() => mappingSlot(-(1n << 255n) - 1n, slot), /does not fit/);
  });

  //regression: any hex string passed for an address, so a hex-spelled bytesN key landed inside
  //  the address slot and hashed to a wrong slot without an error
  it("rejects a string key that is not an address", () => {
    assert.throws(() => mappingSlot("0x1122334455667788", slot), /is an address, got 8 bytes/);
    assert.throws(() => mappingSlot(`0x${"ab".repeat(32)}`, slot), /is an address, got 32 bytes/);
  });
});
