import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { encodeAbiParameters, decodeAbiParameters, getAddress,
         parseSignature, serializeCompactSignature, signatureToCompactSignature } from "viem";
import type { RoUint8Array } from "@onrail-xyz/utils";
import { utf8, hex, bignum } from "@onrail-xyz/utils";
import type { DeriveType } from "@onrail-xyz/binary-layout";
import { serialize, deserialize,
         calcStaticSize, boolItem, withCustom, paddingItem } from "@onrail-xyz/binary-layout";
import { keccak256 } from "../src/hashing.js";
import { type AbiParamValue, type SigNameOf, wordSize, selectorLength,
         selectorOf, selectorItem, selectorIdOf, selectorEnumItem,
         paddedSlotLayout, paddedFields, abiEncodedBytesItem,
         abiStringItem, abiOffsetItem, abiTailItem, addressItem,
         sigSwitchItem, signatureItem, abiSignatureItem,
         compactSignatureItem, uint256Item, abiParam, addressParam,
         amountParam, paramOf, stringParam, paramsLayout,
         sigVariant, addressConversion, bytesNItem, mappingSlot } from "../src/layouting.js";
import { pinEq } from "./typeAssert.js";

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

  //regression: a union of records was read as a whole, whose keyof drops a key not common to
  //  all of them, so a payload that may be decoded typed as raw bytes only. Declared types, since
  //  a union of fresh literals is normalized to carry every key
  it("types a content layout that may be absent as either payload", () => {
    const inner = { binary: "uint", size: 1 } as const;
    const withLayout: { readonly layout: typeof inner } = { layout: inner };
    const without: {} = {};
    const opts = (layout: boolean): typeof withLayout | typeof without =>
      layout ? withLayout : without;
    const declared: { readonly layout?: typeof inner } = { layout: inner };
    const fromUnion    = abiEncodedBytesItem(opts(true));
    const fromOptional = abiEncodedBytesItem(declared);
    pinEq<DeriveType<typeof fromUnion>,    number | RoUint8Array>(true);
    pinEq<DeriveType<typeof fromOptional>, number | RoUint8Array>(true);
    assert.equal(deserialize(fromUnion, serialize(fromUnion, 7)), 7);
  });
});

describe("abiStringItem", () => {
  pinEq<DeriveType<typeof abiStringItem>, string>(true);

  for (const text of ["", "USD Coin", "ü".repeat(20)])
    it(`serializes ${JSON.stringify(text)} identically to viem's abi.encode, and back`, () => {
      const encoded = serialize(abiStringItem, text);
      assert.deepStrictEqual(
        encoded, hex.decode(encodeAbiParameters([{ type: "string" }], [text])));
      assert.strictEqual(deserialize(abiStringItem, encoded), text);
    });
});

describe("paramsLayout", () => {
  //an output layout too: a return of several values, one of them dynamic
  it("places a dynamic param's tail after the head wherever the param sits", () => {
    const layout = paramsLayout([stringParam("name"), abiParam("count", "uint256", uint256Item)]);
    const value = { name: "USD Coin", count: 7n };
    pinEq<DeriveType<typeof layout>, { readonly name: string, readonly count: bigint }>(true);
    const encoded = hex.decode(
      encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [value.name, value.count]));
    assert.deepStrictEqual(serialize(layout, value), encoded);
    assert.deepStrictEqual(deserialize(layout, encoded), value);
  });

  //the dynamic marker and the item were two answers to one question: a plain param with a tail
  //  item got no offset word
  it("takes any param whose item is a tail as the dynamic one", () => {
    const layout = paramsLayout([abiParam("data", "bytes", abiTailItem())]);
    const data = Uint8Array.from([0xc0, 0xff, 0xee]);
    assert.deepStrictEqual(
      serialize(layout, { data }),
      hex.decode(encodeAbiParameters([{ type: "bytes" }], ["0xc0ffee"])),
    );
  });

  it("rejects a second dynamic param", () => {
    assert.throws(
      () => paramsLayout([stringParam("a"), stringParam("b")]),
      /b: a param list admits one dynamic parameter only/,
    );
  });

  it("rejects a param named like the generated offset word", () => {
    assert.throws(
      () => paramsLayout([abiParam("_offset", "uint256", uint256Item), stringParam("note")]),
      /not distinct: _offset, _offset, note/,
    );
  });
});

describe("paddedSlotLayout", () => {
  it("throws on an item wider than a word", () => {
    assert.throws(() => paddedSlotLayout(signatureItem)); //65 bytes
  });

  it("throws on a dynamically sized item", () => {
    assert.throws(() => paddedSlotLayout({ binary: "bytes" }));
  });

  //a struct field of the generated padding's name was overwritten by it
  it("rejects a field named like the generated padding", () => {
    const layout = { _padding: paddingItem(1), flag: { binary: "uint", size: 1 } } as const;
    assert.throws(() => paddedSlotLayout(layout), /not distinct: _padding, _padding, flag/);
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
    //a fractional or NaN width slips past a range check alone
    assert.throws(() => bytesNItem(4.5), /not an ABI type/);
    assert.throws(() => bytesNItem(NaN), /not an ABI type/);
    assert.throws(() => bytesNItem({ binary: "bytes" }), /statically sized/);
    assert.throws(() => bytesNItem(selectorItem("f()")), /surface a value/);
  });

  it("takes an item as the bytes' content, an enum over selectors say", () => {
    const op = bytesNItem(selectorEnumItem(["pause()", "unpause(uint256)"]));
    pinEq<DeriveType<typeof op>, "pause" | "unpause">(true);
    const selector = hex.encode(selectorOf("unpause(uint256)"), true);
    const viemWord = hex.decode(encodeAbiParameters([{ type: "bytes4" }], [selector]));
    assert.deepStrictEqual(serialize(op, "unpause"), viemWord);
    assert.equal(deserialize(op, viemWord), "unpause");
    assert.equal(BigInt(selectorIdOf("unpause(uint256)")), bignum.fromBytes(selectorOf("unpause(uint256)")));
    //an overload would be two selectors under one name
    assert.throws(() => selectorEnumItem(["f()", "f(uint256)"]), /not distinct/);
  });

  //regression: SigNameOf<string> was never, so a generic caller mapping over its signatures - which
  //  map types as bare strings - got never for every name, and selectorEnumItem's return with it
  it("names a wide signature as a wide string", () => {
    pinEq<SigNameOf<string>, string>(true);
    pinEq<SigNameOf<"f(uint256)" | "g()">, "f" | "g">(true);
    const generic = <const S extends readonly [string, ...string[]]>(sigs: S) =>
      selectorEnumItem(sigs);
    pinEq<DeriveType<ReturnType<typeof generic<["f()", "g(bool)"]>>>, "f" | "g">(true);
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

  it("carries a dynamic value's offset and tail unpadded, the tail only last", () => {
    const failed = "Failed(bytes,uint256)";
    const errorOf = sigSwitchItem(selectorLength, "error");
    const item = errorOf([
      [failed, { _offset: abiOffsetItem(2 * wordSize), code: uint256Item, reason: abiTailItem() }],
    ]);
    const value = { error: "Failed", code: 7n, reason: Uint8Array.from([0xc0, 0xff, 0xee]) } as const;
    const encoded = serialize(item, value);
    assert.deepStrictEqual(
      encoded.subarray(selectorLength),
      hex.decode(encodeAbiParameters([{ type: "bytes" }, { type: "uint256" }], ["0xc0ffee", 7n])),
    );
    assert.deepStrictEqual(deserialize(item, encoded), value);
    assert.throws(
      () => errorOf([
        [failed, { _offset: abiOffsetItem(2 * wordSize), reason: abiTailItem(), code: uint256Item }],
      ]),
      /reason: an abi tail must be the only one, and come last/,
    );
    //a fixed word of one's own is no offset, so it gets paddedSlotLayout's verdict
    const lookalike = { ...uint256Item, fixed: BigInt(2 * wordSize) };
    assert.throws(
      () => errorOf([[failed, { _offset: lookalike, code: uint256Item, reason: abiTailItem() }]]),
      /surface a value/,
    );
  });

  //composing a conversion onto a tail makes a new object, which must still ride unpadded, as
  //  its type says
  it("carries a tail under a further conversion", () => {
    const failed = "Failed(bytes)";
    const reason = withCustom(abiTailItem(), {
      to:   (raw: RoUint8Array) => hex.encode(raw),
      from: (text: string) => hex.decode(text),
    });
    const item =
      sigSwitchItem(selectorLength, "error")([[failed, { _offset: abiOffsetItem(wordSize), reason }]]);
    const encoded = serialize(item, { error: "Failed", reason: "c0ffee" });
    assert.deepStrictEqual(
      encoded.subarray(selectorLength),
      hex.decode(encodeAbiParameters([{ type: "bytes" }], ["0xc0ffee"])),
    );
    assert.deepStrictEqual(deserialize(item, encoded), { error: "Failed", reason: "c0ffee" });
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
