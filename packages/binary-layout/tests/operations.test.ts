import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { RoUint8Array, Brand } from "@onrail-xyz/utils";
import type { DeriveType, Layout, Conversion, CustomizableBytes } from "../src/index.js";
import { serialize, deserialize,
         setEndianness, withCustom, pin, pipedConversion,
         spreadLayout, unwrapSingleton, buildDiscriminator,
         buildDeserializer, hasFixed, hasAs, hasCustom,
         uintItem, intItem, bytesItem, arrayItem, packedItem,
         switchItem, codecItem, customizableBytes, paddingItem,
         boolItem, enumItem, nicheItem, aliasItem, optionItem,
         defaultOptionItem, brandConversion, utf8Conversion, compactU16 } from "../src/index.js";
import { pinEq, typeOnly } from "./typeAssert.js";

describe("serialize return type", () => {
  it("tracks whether an output buffer is supplied", () => {
    const layout = uintItem(1);
    const buffer = new Uint8Array(1);
    const allocated = serialize(layout, 7);
    const explicitUndefined = serialize(layout, 7, undefined);
    const written = serialize(layout, 7, buffer);
    pinEq<typeof allocated, Uint8Array>(true);
    pinEq<typeof explicitUndefined, Uint8Array>(true);
    pinEq<typeof written, number>(true);

    const encode = (output: Uint8Array | undefined) => serialize(layout, 7, output);
    pinEq<ReturnType<typeof encode>, Uint8Array | number>(true);
    assert.deepEqual(allocated, new Uint8Array([7]));
    assert.deepEqual(explicitUndefined, allocated);
    assert.deepEqual(encode(undefined), allocated);
    assert.equal(encode(buffer), 1);
    assert.equal(written, 1);
    assert.deepEqual(buffer, allocated);
  });
});

describe("setEndianness", () => {
  it("flips nums, prefixes, and packed words; skips bits and codecs", () => {
    const layout = {
      a: uintItem(2),
      b: { binary: "bytes", size: uintItem(2), layout: { c: uintItem(4) } },
      d: arrayItem({ binary: "uint", size: 2 } as const, uintItem(2)),
      e: packedItem({ hi: uintItem.bits(8), lo: uintItem.bits(8) }),
      f: uintItem(1),
      g: compactU16,
    } as const;

    const le = setEndianness(layout, "little");
    assert.equal(le.a.endianness, "little");
    assert.equal(le.b.size.endianness, "little");
    assert.equal(le.b.layout.c.endianness, "little");
    assert.equal(le.d.length.endianness, "little");
    assert.equal(le.e.endianness, "little");
    assert.equal(le.f.endianness, "little"); //single-byte: byte order is moot but set uniformly
    assert.ok(!("endianness" in le.g)); //codec

    const data = { a: 0x0102, b: { c: 5 }, d: [1], e: { hi: 1, lo: 2 }, f: 9, g: 3 } as const;
    assert.equal(serialize(le, data).toHex(), "0201" + "0400" + "05000000" + "0100" + "0100" + "0201" + "09" + "03");

    //byte order is orthogonal to bit order: the bit order survives the flip
    const lsbWord = setEndianness(packedItem({ x: uintItem.bits(8) }, { bitOrder: "lsbFirst" }), "little");
    pinEq<typeof lsbWord.bitOrder, "lsbFirst">(true);
    assert.equal(lsbWord.bitOrder, "lsbFirst");

    //embedded byte items are bit-ranges of the word's logical integer: an inner endianness
    //  is a rejected shape, so the flip must not recurse into the packed layout
    //  (this previously stamped `endianness` onto embedded items)
    const embedded = setEndianness(packedItem({ ts: uintItem(4) }), "little");
    assert.equal(embedded.endianness, "little");
    assert.ok(!("endianness" in embedded.layout.ts));
    pinEq<typeof embedded.layout.ts.size, 4>(true);
  });

  it("reaches a byte lane's own byte order", () => {
    //a lane owns a byte order only by declaring one - here by stating its width in bytes
    const layout =
      packedItem({ tag: uintItem.bits(8), word: packedItem({ x: uintItem.bits(16) }, 2) });
    const data = { tag: 0xff, word: { x: 0x1234 } };
    assert.equal(serialize(layout, data).toHex(), "ff1234");

    //both words flip: the inner renders 3412 into the lane, the outer then reverses all three
    const le = setEndianness(layout, "little");
    assert.equal(le.layout.word.endianness, "little");
    assert.equal(serialize(le, data).toHex(), "1234ff");
  });

  it("leaves a default lane alone - a bit range has no byte order to be given one", () => {
    //a lane that declares neither size nor endianness is a bit range of the word around it, so
    //  the flip must not stamp one onto it: that would silently promote it to a byte lane
    //  (which previously happened, and made the flip disagree with the hand-written layout)
    const lane = packedItem.bits({ a: uintItem.bits(8), b: uintItem.bits(8) });
    const layout = packedItem({ lane, tail: uintItem.bits(8) });
    const data = { lane: { a: 0x12, b: 0x34 }, tail: 0x56 };
    assert.equal(serialize(layout, data).toHex(), "123456");

    const le = setEndianness(layout, "little");
    assert.ok(!("endianness" in le.layout.lane));
    assert.equal(serialize(le, data).toHex(), "563412");
    //identical to spelling the little-endian word out by hand
    assert.equal(
      serialize(packedItem({ lane, tail: uintItem.bits(8) }, { endianness: "little" }), data).toHex(),
      "563412",
    );
  });

  it("flipping to the order a layout already has leaves it serializable", () => {
    //stamping endianness onto a sub-byte lane used to make it a byte lane, which then failed
    //  the byte-alignment a wire-facing word owes - even when nothing about the order changed
    const layout =
      packedItem({ lane: packedItem.bits({ a: uintItem.bits(4) }), tail: uintItem.bits(4) });
    const data = { lane: { a: 1 }, tail: 2 };
    for (const endianness of ["big", "little"] as const)
      assert.equal(serialize(setEndianness(layout, endianness), data).toHex(), "12");
  });

  it("reaches a bytes lane's standalone content", () => {
    const layout = packedItem({
      flag: uintItem.bits(8),
      blob: bytesItem({ size: 2, layout: { x: uintItem(2) } }),
    });
    const data = { flag: 1, blob: { x: 0x1234 } };
    assert.equal(serialize(layout, data).toHex(), "011234");

    //a lane's content is deserialized standalone, so ordinary byte order applies inside it
    const le = setEndianness(layout, "little");
    assert.equal(le.layout.blob.layout.x.endianness, "little");
    assert.equal(serialize(le, data).toHex(), "123401");
  });

  it("keeps a bit group's fields in the word", () => {
    const layout = packedItem({
      flag: uintItem.bits(8),
      group: bytesItem({ layout: { x: uintItem(2) } }),
    });
    const data = { flag: 1, group: { x: 0x1234 } };
    assert.equal(serialize(layout, data).toHex(), "011234");
    //a group is bits of the word, so only the word's byte order applies
    const le = setEndianness(layout, "little");
    assert.equal((le.layout.group.layout.x as { endianness?: unknown }).endianness, undefined);
    assert.equal(serialize(le, data).toHex(), "341201");
  });

  it("leaves a sub-byte lane alone - it has no byte order to set", () => {
    const lane = packedItem.bits({ a: uintItem.bits(4) }, 4);
    const untouched = setEndianness(lane, "little");
    pinEq<typeof untouched, typeof lane>(true);
    assert.ok(!("endianness" in untouched));
  });

  it("flips a wide bool but not a padding-emulated one", () => {
    assert.equal(serialize(setEndianness(boolItem(4), "little"), true).toHex(), "01000000");

    //key order is wire order, so the flip cannot reorder the fields: the emulated spelling
    //  keeps its big-endian shape and comes out silently wrong
    const emulated = setEndianness({ _pad: paddingItem(3), value: boolItem() }, "little");
    assert.equal(serialize(emulated, { value: true }).toHex(), "00000001");
  });

  it("flips switch ids and variant layouts", () => {
    const layout = switchItem("cmd", uintItem(2), [[1, "a", { x: uintItem(2) }]]);
    const le = setEndianness(layout, "little");
    pinEq<DeriveType<typeof le>, DeriveType<typeof layout>>(true);
    assert.equal(le.id.endianness, "little");
    assert.equal(le.variants[0].layout.x.endianness, "little");
    assert.equal(serialize(le, { cmd: "a", x: 0x0304 }).toHex(), "01000403");

    //recursion reaches through a switch body in variant position
    const nested = switchItem("cmd", uintItem(2), [[1, "a", switchItem("sub", uintItem(2), [[2, "b", { x: uintItem(2) }]])]]);
    const nle = setEndianness(nested, "little");
    pinEq<DeriveType<typeof nle>, DeriveType<typeof nested>>(true);
    assert.equal(nle.variants[0].layout.id.endianness, "little");
    assert.equal(nle.variants[0].layout.variants[0].layout.x.endianness, "little");
    assert.equal(serialize(nle, { cmd: "a", sub: "b", x: 0x0304 }).toHex(), "010002000403");
    assert.deepEqual(deserialize(nle, Uint8Array.fromHex("010002000403")),
      { cmd: "a", sub: "b", x: 0x0304 });

    //@ts-expect-error a switch still requires its tag and fields after changing endianness
    typeOnly(() => serialize(le, {}));
    //@ts-expect-error nested tags are required too
    typeOnly(() => serialize(nle, { cmd: "a", x: 1 }));
  });
});

//these pin the *derived* types, which the return types of spreadLayout/unwrapSingleton only started
//  stating precisely once their conversions carried it - before that the conditional stayed
//  deferred and the final cast went unchecked
const _pinNested = { label: uintItem(1),
                     coords: bytesItem({ layout: { x: uintItem(1), y: uintItem(1) } }) };
pinEq<
  DeriveType<ReturnType<typeof spreadLayout<typeof _pinNested, "coords">>>,
  { readonly label: number; readonly x: number; readonly y: number }
>(true);

const _pinSlot = { _pad: paddingItem(3), value: uintItem(1) };
pinEq<
  DeriveType<ReturnType<typeof unwrapSingleton<typeof _pinSlot>>>, number
>(true);
pinEq<
  ReturnType<typeof unwrapSingleton<{ _pad: ReturnType<typeof paddingItem> }>>, never
>(true);

describe("manipulate", () => {
  it("withCustom gives a struct its item-form to carry the conversion", () => {
    const swapped = withCustom({ a: uintItem(1), b: uintItem(1) } as const, {
      to:   ({ a, b }) => ({ a: b, b: a }),
      from: ({ a, b }) => ({ a: b, b: a }),
    });
    assert.equal(swapped.binary, "bytes");
    assert.equal(serialize(swapped, { a: 2, b: 1 }).toHex(), "0102");
    assert.deepEqual(deserialize(swapped, new Uint8Array([1, 2])), { a: 2, b: 1 });
  });

  it("withCustom attaches to an item in place - no wrapper node", () => {
    const flag = withCustom(uintItem(1), { to: n => n !== 0, from: b => b ? 1 : 0 });
    pinEq<typeof flag, Readonly<{ binary: "uint", size: 1, custom: Conversion<number, boolean> }>>(true);
    pinEq<DeriveType<typeof flag>, boolean>(true);
    assert.ok(!("layout" in flag));
    assert.equal(serialize(flag, true).toHex(), "01");

    //aggregates included: the CompactSize-style prefix is a bare switch with a conversion
    const counted = withCustom(arrayItem(uintItem(1), 2), {
      to:   ([a, b]) => a * 256 + b,
      from: n => [Math.floor(n / 256), n % 256] as const,
    });
    assert.equal(counted.binary, "array");
    pinEq<DeriveType<typeof counted>, number>(true);
    assert.equal(deserialize(counted, serialize(counted, 0x1234)), 0x1234);
  });

  it("withCustom composes onto an existing conversion", () => {
    const onOff = withCustom(boolItem(), { to: b => b ? "on" : "off", from: s => s === "on" });
    pinEq<DeriveType<typeof onOff>, "on" | "off">(true);
    pinEq<Parameters<typeof onOff.custom.to>[0], number>(true);
    assert.equal(onOff.custom.to(1), "on");
    assert.equal(serialize(onOff, "off").toHex(), "00");
    assert.equal(deserialize(onOff, new Uint8Array([1])), "on");
  });

  it("withCustom on a pinned item converts the raw constant", () => {
    const zero = withCustom(uintItem(1, { fixed: 0 }), {
      to:   n => n === 0 ? "zero" as const : "nonzero" as const,
      from: s => s === "zero" ? 0 : 1,
    });
    pinEq<Parameters<typeof zero.custom.to>[0], number>(true);
    pinEq<DeriveType<typeof zero>, "zero" | "nonzero">(true);
    assert.equal(deserialize(zero, new Uint8Array([0])), "zero");

    //a stated surfaced value is converted once, at construction, and folded into `as`
    const legacy = uintItem(1, { fixed: 0, as: "legacy" });
    const shouted = withCustom(legacy, { to: s => s.toUpperCase(), from: () => "legacy" as const });
    assert.deepEqual(shouted, { binary: "uint", size: 1, fixed: 0, as: "LEGACY" });
    pinEq<DeriveType<typeof shouted>, string>(true);
    assert.equal(deserialize(shouted, new Uint8Array([0])), "LEGACY");
  });

  it("pin states a constant in the surfaced vocabulary", () => {
    const mode = enumItem([["off", 0], ["on", 3]]);
    const alwaysOn = pin(mode, "on");
    pinEq<DeriveType<typeof alwaysOn>, "on">(true);
    assert.deepEqual(alwaysOn, { binary: "uint", size: 1, fixed: 3, as: "on" });
    assert.equal(serialize(alwaysOn, "on").toHex(), "03");
    assert.equal(deserialize(alwaysOn, new Uint8Array([3])), "on");
    assert.throws(() =>
      // @ts-expect-error - not a member of the enum
      pin(mode, "dim"), /Invalid enum name/);

    //without a conversion the two sides coincide: a surfaced constant
    const five = pin(compactU16, 5);
    pinEq<DeriveType<typeof five>, 5>(true);
    assert.equal(deserialize(five, new Uint8Array([5])), 5);

    //a struct gets its item-form, like withCustom
    const origin = pin({ x: uintItem(1), y: uintItem(1) }, { x: 0, y: 0 });
    assert.equal(origin.binary, "bytes");
    pinEq<DeriveType<typeof origin>, { readonly x: 0, readonly y: 0 }>(true);
    assert.equal(serialize(origin, { x: 0, y: 0 }).toHex(), "0000");
  });

  it("pipedConversion chains wire-outward", () => {
    type Name = Brand<string, "Name">;
    const named = pipedConversion(utf8Conversion, brandConversion<Name>());
    pinEq<typeof named, Readonly<{ to: (val: RoUint8Array) => Name, from: (val: Name) => RoUint8Array }>>(true);
    assert.equal(named.to(new Uint8Array([104, 105])), "hi");
    assert.equal(named.from("hi" as Name).toHex(), "6869");
  });

  it("spreadLayout flattens a nested field (bytes-with-layout, packed, inline)", () => {
    const packedLane = packedItem({ hi: uintItem.bits(8), lo: uintItem.bits(8) });
    const framed = { binary: "bytes", layout: { x: uintItem(1) } } as const;
    const inline = { y: uintItem(1) } as const;

    for (const [layout, data, expected] of [
      [{ head: uintItem(1), rest: packedLane } as const,
        { head: 1, hi: 2, lo: 3 }, "010203"],
      [{ head: uintItem(1), rest: framed } as const, { head: 1, x: 2 }, "0102"],
      [{ head: uintItem(1), rest: inline } as const, { head: 1, y: 2 }, "0102"],
    ] as const) {
      const spreaded = spreadLayout(layout as any, "rest") as any;
      assert.equal(serialize(spreaded, data).toHex(), expected);
      assert.deepEqual(deserialize(spreaded, serialize(spreaded, data)), data);
    }
  });

  //regression: the layout spread cast through `any` into utils' spread, whose disjointness
  //  guard is type-level, so a shared key decoded to one value and reconstructed into the wrong
  //  nesting
  it("spreadLayout rejects a key the outer and the inner struct share", () => {
    const layout = { x: uintItem(1), n: { x: uintItem(1) } } as const;
    assert.throws(() => spreadLayout(layout as any, "n"), /not distinct/);
  });

  //omitted fields derive no key, so a name they share collides with nothing
  it("spreadLayout lets padding share a name across levels", () => {
    const both = {
      reserved: paddingItem(1),
      header:   { reserved: paddingItem(1), a: uintItem(1) },
      b:        uintItem(1),
    } as const;
    const spread = spreadLayout(both, "header");
    assert.deepEqual(deserialize(spread, new Uint8Array([0, 0, 1, 2])), { a: 1, b: 2 });
    assert.deepEqual(serialize(spread, { a: 1, b: 2 }), new Uint8Array([0, 0, 1, 2]));

    const outerPad = { a: paddingItem(1), inner: { a: uintItem(1) } } as const;
    const spreadPad = spreadLayout(outerPad, "inner");
    assert.deepEqual(deserialize(spreadPad, new Uint8Array([0, 7])), { a: 7 });
  });

  it("spreadLayout derives the flattened type", () => {
    const layout = { head: uintItem(1), rest: { y: uintItem(2) } } as const;
    const spreaded = spreadLayout(layout, "rest");
    pinEq<DeriveType<typeof spreaded>, { readonly head: number, readonly y: number }>(true);
  });

  it("unwrapSingleton extracts the lone non-omitted field", () => {
    const slot = { _padding: paddingItem(3), value: uintItem(1) } as const;
    const unwrapped = unwrapSingleton(slot);
    pinEq<DeriveType<typeof unwrapped>, number>(true);
    assert.equal(serialize(unwrapped, 7).toHex(), "00000007");
    assert.equal(deserialize(unwrapped, serialize(unwrapped, 7)), 7);
  });

  it("unwrapSingleton rejects multi-field structs", () => {
    assert.throws(() => unwrapSingleton({ a: uintItem(1), b: uintItem(1) } as any), /exactly one/);
  });
});

describe("buildDiscriminator", () => {
  it("uses the fixed bytes of pinned aggregates", () => {
    const a = { magic: { ...arrayItem(uintItem(1), { length: 2 }), fixed: [1, 2] }, rest: bytesItem() } as const;
    const sw = switchItem("k", uintItem(1), [[9, "x", { v: uintItem(1) }]]);
    const b = { magic: { ...sw, fixed: { k: "x", v: 3 } }, rest: bytesItem() } as const;
    const discriminator = buildDiscriminator([a, b]);
    assert.equal(discriminator(new Uint8Array([1, 2, 0])), 0);
    assert.equal(discriminator(new Uint8Array([9, 3, 0])), 1);
    assert.equal(discriminator(new Uint8Array([5, 5, 0])), null);
  });

  it("discriminates by fixed byte", () => {
    const a = { magic: { ...uintItem(1), fixed: 1 }, rest: bytesItem() } as const;
    const b = { magic: { ...uintItem(1), fixed: 2 }, rest: bytesItem() } as const;
    const discriminator = buildDiscriminator([a, b]);
    assert.equal(discriminator(serialize(a, { rest: new Uint8Array([9]) })), 0);
    assert.equal(discriminator(serialize(b, { rest: new Uint8Array([9]) })), 1);
    assert.equal(discriminator(new Uint8Array([3, 9])), null);
  });

  it("discriminates by size", () => {
    const a = { x: uintItem(1) } as const;
    const b = { x: uintItem(2) } as const;
    const discriminator = buildDiscriminator([a, b]);
    assert.equal(discriminator(new Uint8Array(1)), 0);
    assert.equal(discriminator(new Uint8Array(2)), 1);
    assert.equal(discriminator(new Uint8Array(3)), null);
  });

  it("uses packed and codec bounds", () => {
    const a = packedItem({ order: arrayItem(uintItem.bits(4), 16) }); //static 8 bytes
    const b = { n: compactU16 } as const;                  //1-3 bytes
    const discriminator = buildDiscriminator([a, b]);
    assert.equal(discriminator(new Uint8Array(8)), 0);
    assert.equal(discriminator(new Uint8Array([5])), 1);
  });

  it("emits switch id bytes as fixed-byte discriminators", () => {
    const a = switchItem("cmd", uintItem(1), [[1, "x", { p: uintItem(2) }]]);
    const b = switchItem("cmd", uintItem(1), [[2, "y", { p: uintItem(2) }]]);
    const discriminator = buildDiscriminator([a, b]);
    assert.equal(discriminator(serialize(a, { cmd: "x", p: 5 })), 0);
    assert.equal(discriminator(serialize(b, { cmd: "y", p: 5 })), 1);
  });

  it("renders negative switch ids into their two's-complement wire bytes", () => {
    //ids are serialized eagerly at construction, so signedness must thread through here too
    const a = switchItem("code", intItem(1), [[-1, "err",  { errno:  uintItem(1) }]]);
    const b = switchItem("code", intItem(1), [[-2, "warn", { detail: uintItem(1) }]]);
    const discriminator = buildDiscriminator([a, b]);
    assert.equal(discriminator(new Uint8Array([0xff, 7])), 0);
    assert.equal(discriminator(new Uint8Array([0xfe, 7])), 1);
    assert.equal(discriminator(new Uint8Array([0x00, 7])), null);
  });

  it("size-filters the survivors of a perfect byte discriminator", () => {
    //the fast path previously returned size-incompatible survivors: a maybe-too-short layout
    //  on short input, and the value-matched layout regardless of the encoding's length
    const a = { pre: uintItem(2), magic: uintItem(1, { fixed: 7 }) } as const;
    const b = { pre: uintItem(2), magic: uintItem(1, { fixed: 8 }), v: uintItem(1) } as const;
    const c = uintItem(1);
    const discriminator = buildDiscriminator([a, b, c]); //perfect byte discriminator at position 2
    assert.equal(discriminator(new Uint8Array([0])), 2);
    assert.equal(discriminator(new Uint8Array([0, 0])), null);       //c is 1 byte, a/b need byte 2
    assert.equal(discriminator(new Uint8Array([0, 0, 7])), 0);
    assert.equal(discriminator(new Uint8Array([0, 0, 8, 9])), 1);
    assert.equal(discriminator(new Uint8Array([0, 0, 7, 9])), null); //a fixes byte 2 but is 3 bytes
  });

  it("rejects indistinguishable layouts unless ambiguity is allowed", () => {
    const a = { x: uintItem(1) } as const;
    assert.throws(() => buildDiscriminator([a, a]));
    const ambiguous = buildDiscriminator([a, a], true);
    assert.deepEqual(ambiguous(new Uint8Array(1)), [0, 1]);
  });
});

describe("buildDeserializer", () => {
  const prefixed = bytesItem(uintItem(1)); //size range [1, ∞), overlaps u16 at 2
  const u16 = uintItem(2);

  it("accepts indistinguishable sets and resolves candidates by parsing", () => {
    assert.throws(() => buildDiscriminator([prefixed, u16]));
    const deserializer = buildDeserializer([prefixed, u16]);

    //only u16 fits: prefixed announces 5 content bytes but just 1 follows
    assert.deepEqual(deserializer(new Uint8Array([5, 1])), [1, 0x0501]);
    //both parse: first match wins, like switch variant resolution
    assert.deepEqual(deserializer(new Uint8Array([1, 9])), [0, new Uint8Array([9])]);
    //nothing fits: 3 bytes rules out u16, and prefixed announces 5
    assert.equal(deserializer(new Uint8Array([5, 1, 2])), null);
  });

  it("allMatches returns every successful parse", () => {
    const deserializer = buildDeserializer([prefixed, u16], true);

    assert.deepEqual(deserializer(new Uint8Array([1, 9])), [[0, new Uint8Array([9])], [1, 0x0109]]);
    assert.deepEqual(deserializer(new Uint8Array([5, 1])), [[1, 0x0501]]);
    assert.deepEqual(deserializer(new Uint8Array([5, 1, 2])), []);
  });
});

describe("item factories", () => {
  it("uint/int factories build exact plain items", () => {
    const u16le = uintItem(2, { endianness: "little" });
    assert.deepEqual(u16le, { binary: "uint", size: 2, endianness: "little" });
    pinEq<DeriveType<typeof u16le>, number>(true);

    const fee = uintItem.bits(14);
    assert.deepEqual(fee, { binary: "uint", bits: 14 });
  });

  it("codecItem builds exact plain codec items and unifies the raw type", () => {
    const u16be = codecItem({
      read: (bytes, offset) => [bytes[offset]! * 256 + bytes[offset + 1]!, offset + 2],
      write: (raw, bytes, offset) => { bytes[offset] = raw >> 8; bytes[offset + 1] = raw & 0xff; return offset + 2; },
      sizeOf: () => 2,
    }, { minSize: 2, maxSize: 2 });
    pinEq<DeriveType<typeof u16be>, number>(true);
    //no phantom optional keys leak from the opts constraint
    pinEq<keyof typeof u16be, "binary" | "read" | "write" | "sizeOf" | "minSize" | "maxSize">(true);
    //wire-equivalent to the native uint item
    assert.equal(serialize(u16be, 0x1234).toHex(), serialize(uintItem(2), 0x1234).toHex());
    assert.equal(deserialize(u16be, new Uint8Array([0x12, 0x34])), 0x1234);
    //custom composes on top as usual
    const hexU16 = codecItem(u16be, { custom: { to: (v: number) => v.toString(16), from: (s: string) => parseInt(s, 16) } });
    pinEq<DeriveType<typeof hexU16>, string>(true);
    assert.equal(deserialize(hexU16, serialize(hexU16, "1234")), "1234");

    assert.throws(() => codecItem(u16be, { minSize: 3, maxSize: 2 }), /size bounds/);
  });

  it("bool bits and padding compose in packed layouts", () => {
    const layout = packedItem({ fee: uintItem.bits(14), _pad: paddingItem.bits(1), isPaused: boolItem.bits() });
    const data = { fee: 300, isPaused: true };
    assert.equal(serialize(layout, data).toHex(), ((300 << 2) | 1).toString(16).padStart(4, "0"));
    assert.deepEqual(deserialize(layout, serialize(layout, data)), data);
  });

  it("bool rejects out-of-domain values unless permissive", () => {
    assert.throws(() => deserialize(boolItem(), new Uint8Array([2])));
    assert.equal(deserialize(boolItem({ permissive: true }), new Uint8Array([2])), true);
  });

  it("bool takes any width, in bytes or in bits", () => {
    const wide = boolItem({ size: 4, endianness: "little" });
    pinEq<DeriveType<typeof wide>, boolean>(true);
    pinEq<typeof wide.endianness, "little">(true);
    //permissive selects the conversion and must not surface as an item property
    pinEq<"permissive" extends keyof typeof wide ? true : false, false>(true);
    assert.ok(!("permissive" in boolItem({ permissive: true })));
    assert.equal(serialize(wide, true).toHex(), "01000000");
    assert.throws(() => deserialize(wide, new Uint8Array([2, 0, 0, 0])));

    const rest = uintItem.bits(5);
    assert.equal(serialize(packedItem({ b: boolItem.bits(3), rest }), { b: true, rest: 0 }).toHex(), "20");
    assert.throws(() => deserialize(packedItem({ b: boolItem.bits(3), rest }), new Uint8Array([0x40])));
    const lax = packedItem({ b: boolItem.bits({ bits: 3, permissive: true }), rest });
    assert.deepEqual(deserialize(lax, new Uint8Array([0x40])), { b: true, rest: 0 });
  });

  it("enumOf maps names to values", () => {
    const tranche = enumItem([["junior", 0], ["senior", 1]]);
    pinEq<DeriveType<typeof tranche>, "junior" | "senior">(true);
    assert.equal(serialize(tranche, "senior").toHex(), "01");
    assert.equal(deserialize(tranche, new Uint8Array([0])), "junior");
    assert.throws(() => deserialize(tranche, new Uint8Array([2])), /Invalid enum value/);
  });

  it("enum rejects repeated names and values at construction", () => {
    //a repeat makes the mapping non-injective: "a" would serialize to 1 and come back as "b" -
    //  the silent round-trip break switchItem rejects for fully shadowed variants
    assert.throws(() => enumItem([["a", 1], ["b", 1]]), /not distinct: 1, 1/);
    assert.throws(() => enumItem([["a", 1], ["a", 2]]), /not distinct: a, a/);
    assert.throws(() => enumItem.bits([["a", 1], ["b", 1]], 4), /not distinct: 1, 1/);
  });

  it("enum takes any width and carries no endianness unless asked", () => {
    const mode = [["off", 0], ["on", 1], ["auto", 2]] as const;
    const plain = enumItem(mode);
    assert.ok(!("endianness" in plain));
    pinEq<"endianness" extends keyof typeof plain ? true : false, false>(true);
    assert.equal(serialize(enumItem(mode, { size: 2, endianness: "little" }), "auto").toHex(), "0200");

    //an enum that emitted a default endianness could not sit in a packed layout at all
    const packedMode = packedItem({ m: enumItem.bits(mode, 2), rest: uintItem.bits(6) });
    assert.equal(serialize(packedMode, { m: "auto", rest: 0 }).toHex(), "80");
    assert.equal(deserialize(packedMode, new Uint8Array([0x40])).m, "on");
  });

  it("option encodes presence with a leading byte", () => {
    const maybeU16 = optionItem(uintItem(2));
    pinEq<DeriveType<typeof maybeU16>, number | undefined>(true);
    assert.equal(serialize(maybeU16, 0x1234).toHex(), "011234");
    assert.equal(serialize(maybeU16, undefined).toHex(), "00");
    assert.equal(deserialize(maybeU16, new Uint8Array([1, 0x12, 0x34])), 0x1234);
    assert.equal(deserialize(maybeU16, new Uint8Array([0])), undefined);
  });

  it("option takes the tag's width and byte order", () => {
    const maybeU8 = optionItem(uintItem(1), { size: 2, endianness: "little" });
    assert.equal(serialize(maybeU8, 5).toHex(), "010005");
    assert.equal(serialize(maybeU8, undefined).toHex(), "0000");
    assert.equal(deserialize(maybeU8, new Uint8Array([1, 0, 5])), 5);
  });

  it("default option keeps the body's space, holding the default's encoding", () => {
    const maybeU16 = defaultOptionItem(uintItem(2), 0xffff);
    pinEq<DeriveType<typeof maybeU16>, number | undefined>(true);
    assert.equal(serialize(maybeU16, undefined).toHex(), "00ffff");
    assert.equal(serialize(maybeU16, 0x1234).toHex(), "011234");
    assert.equal(deserialize(maybeU16, new Uint8Array([0, 0xff, 0xff])), undefined);
    assert.equal(deserialize(maybeU16, new Uint8Array([1, 0xff, 0xff])), 0xffff);
    //any other absent body would be a second encoding of the absence
    assert.throws(() => deserialize(maybeU16, new Uint8Array([0, 0, 0])));

    const cOption = defaultOptionItem({ k: uintItem(1), v: uintItem(1) }, { k: 0, v: 0 },
                                      { size: 4, endianness: "little" });
    assert.equal(serialize(cOption, undefined).toHex(), "000000000000");
    assert.deepEqual(deserialize(cOption, serialize(cOption, { k: 1, v: 2 })), { k: 1, v: 2 });
    //permissive reads any absent body of the default's size, and writes the default
    const lenient = defaultOptionItem(uintItem(2), 0xffff, { permissive: true });
    assert.equal(deserialize(lenient, new Uint8Array([0, 1, 2])), undefined);
    assert.equal(serialize(lenient, undefined).toHex(), "00ffff");
    assert.equal(deserialize(lenient, new Uint8Array([1, 1, 2])), 0x0102);
    assert.equal("permissive" in lenient.id, false);

    // @ts-expect-error - the absent body holds a value, never the absence itself
    typeOnly(() => defaultOptionItem(uintItem(2), undefined));
  });

  it("niche surfaces reserved raw values and passes the rest through", () => {
    const budget = nicheItem([[undefined, 0xffffffff]], 4);
    pinEq<DeriveType<typeof budget>, number | undefined>(true);
    assert.equal(serialize(budget, undefined).toHex(), "ffffffff");
    assert.equal(serialize(budget, 7).toHex(), "00000007");
    assert.equal(deserialize(budget, new Uint8Array([0xff, 0xff, 0xff, 0xff])), undefined);
    assert.equal(deserialize(budget, new Uint8Array([0, 0, 0, 7])), 7);
    //the raw niche would read back as its niche
    assert.throws(() => serialize(budget, 0xffffffff), /is the niche of undefined/);
  });

  it("niche takes width, sign and primitive from its carrier", () => {
    const index = nicheItem([["none", -1]], intItem(2));
    pinEq<DeriveType<typeof index>, number | "none">(true);
    assert.equal(serialize(index, "none").toHex(), "ffff");
    assert.equal(deserialize(index, serialize(index, -2)), -2);

    const max = 2n ** 256n - 1n;
    const allowance = nicheItem([["unlimited", max], [null, 0n]], 32);
    pinEq<DeriveType<typeof allowance>, bigint | "unlimited" | null>(true);
    assert.equal(deserialize(allowance, serialize(allowance, "unlimited")), "unlimited");
    assert.equal(deserialize(allowance, serialize(allowance, null)), null);
    assert.equal(deserialize(allowance, serialize(allowance, 5n)), 5n);

    const lane = nicheItem.bits([[null, 7]], 3);
    const word = packedItem({ n: lane, rest: uintItem.bits(5) });
    assert.equal(serialize(word, { n: null, rest: 0 }).toHex(), "e0");
    assert.deepEqual(deserialize(word, new Uint8Array([0x41])), { n: 2, rest: 1 });
    //a bits item in the sized slot is the same lane
    const { custom: _, ...viaItem } = nicheItem([[null, 7]], uintItem.bits(3));
    assert.deepEqual(viaItem, { binary: "uint", bits: 3 });
  });

  it("niche and enum spell the carrier's extremes as min and max", () => {
    const budget = nicheItem([[undefined, "max"]], 4);
    pinEq<DeriveType<typeof budget>, number | undefined>(true);
    assert.equal(serialize(budget, undefined).toHex(), "ffffffff");
    assert.equal(serialize(nicheItem([[null, "min"]], intItem(4)), null).toHex(), "80000000");
    assert.equal(serialize(nicheItem([[null, "max"]], intItem(4)), null).toHex(), "7fffffff");
    assert.equal(serialize(nicheItem([["all", "max"]], 32), "all").toHex(), "ff".repeat(32));
    const word = packedItem({ n: nicheItem.bits([[null, "max"]], 3), rest: uintItem.bits(5) });
    assert.equal(serialize(word, { n: null, rest: 0 }).toHex(), "e0");
    assert.equal(serialize(enumItem([["none", "max"], ["some", 0]], 2), "none").toHex(), "ffff");
    //a bound resolves before the distinctness check
    assert.throws(() => nicheItem([[undefined, "min"], [null, 0]]), /not distinct: 0, 0/);
  });

  it("niche rejects dead and ambiguous niches", () => {
    //a widened width defers the primitive to runtime
    assert.throws(() => nicheItem([[undefined, 1]], 8 as number), /is a number, but u64 derives a bigint/);
    assert.throws(() => nicheItem([[undefined, 256]]), /Niche 256 does not fit in u8/);
    assert.throws(() => nicheItem([[undefined, 128]], intItem(1)), /does not fit in i8/);
    assert.throws(() => nicheItem([[undefined, 1], [null, 1]]), /not distinct/);
    assert.throws(() => nicheItem([[null, 1], [null, 2]]), /not distinct/);
    // @ts-expect-error - a numeric niche value would collide with the passed-through integers
    typeOnly(() => nicheItem([[5, 1]]));
    // @ts-expect-error - a raw niche is in the carrier's primitive
    assert.throws(() => nicheItem([[undefined, 1]], 8), /is a number, but u64 derives a bigint/);
    // @ts-expect-error - a pinned carrier has no values to reserve
    typeOnly(() => nicheItem([[undefined, "max"]], uintItem(1, { fixed: 2 })));
    // @ts-expect-error - nor bytes that derive a layout
    typeOnly(() => nicheItem([[undefined, 2]], bytesItem({ layout: uintItem(1) })));
    assert.throws(() => nicheItem([[null, new Uint8Array(3)]], bytesItem(4)),
                  /size mismatch: layout size: 4, data size: 3/);
    assert.throws(() => nicheItem([[null, new Uint8Array(2)], [undefined, new Uint8Array(2)]],
                                  bytesItem(2)),
                  /not distinct/);
  });

  it("niche reserves bytes by content", () => {
    const word = nicheItem([[null, new Uint8Array(4)]], bytesItem(4));
    pinEq<DeriveType<typeof word>, RoUint8Array | null>(true);
    assert.equal(serialize(word, null).toHex(), "00000000");
    assert.equal(deserialize(word, new Uint8Array(4)), null);
    assert.deepEqual(deserialize(word, new Uint8Array([0, 0, 0, 1])), new Uint8Array([0, 0, 0, 1]));
    //a fresh array with the niche's content is still the niche
    assert.throws(() => serialize(word, new Uint8Array(4)), /is the niche of null/);
    // @ts-expect-error - a bare carrier passes only its raw values through
    typeOnly(() => serialize(word, "0x00"));
  });

  it("niche surfaces the rest through the carrier's own conversion", () => {
    const hexConversion: Conversion<RoUint8Array, string> = {
      to:   bytes => bytes.toHex(),
      from: str   => Uint8Array.fromHex(str),
    };
    const hexWord = { binary: "bytes", size: 2, custom: hexConversion } as const;
    const slot = nicheItem([["any", "ffff"]], hexWord);
    pinEq<DeriveType<typeof slot>, string>(true);
    assert.equal(serialize(slot, "any").toHex(), "ffff");
    assert.equal(serialize(slot, "00ab").toHex(), "00ab");
    assert.equal(deserialize(slot, new Uint8Array([0xff, 0xff])), "any");
    assert.equal(deserialize(slot, new Uint8Array([0, 0xab])), "00ab");
    //reserved by encoding, not by spelling
    assert.throws(() => serialize(slot, "FFFF"), /FFFF is the niche of any/);

    //an integer carrier converts too: a bool with a third state
    const tristate = nicheItem([["unknown", "max"]], boolItem());
    pinEq<DeriveType<typeof tristate>, boolean | "unknown">(true);
    assert.equal(serialize(tristate, "unknown").toHex(), "ff");
    assert.equal(serialize(tristate, true).toHex(), "01");
    assert.equal(deserialize(tristate, new Uint8Array([0xff])), "unknown");
    assert.throws(() => deserialize(tristate, new Uint8Array([2])), /Invalid bool value/);

    //min/max are the carrier's own spelling where it has one: the enum's "max" was the
    //  domain extreme 0xff, leaving the enum's max (2) unnameable
    const level = enumItem([["min", 0], ["mid", 1], ["max", 2]]);
    const top = aliasItem([["top", "max"], ["floor", "min"]], level);
    assert.equal(serialize(top, "top").toHex(), "02");
    assert.equal(serialize(top, "floor").toHex(), "00");
    assert.equal(deserialize(top, new Uint8Array([2])), "top");
  });

  it("niche names must not be values of a converted carrier", () => {
    //true would serialize as the niche, so the raw 1 would read back as a value written as 0xff
    assert.throws(() => nicheItem([[true, "max"]], boolItem()),
                  /Niche true is a value of the carrier/);
    const text = { binary: "bytes", custom: utf8Conversion } as const;
    assert.throws(() => aliasItem([["none", ""]], text), /Alias none is a value/);
    const maybeText = nicheItem([[null, ""]], text);
    assert.equal(deserialize(maybeText, serialize(maybeText, "a")), "a");
    assert.throws(() => serialize(maybeText, ""), /is the niche of null/);
    //an alias over a niche must not reuse the niche's name
    assert.throws(() => aliasItem([[null, "x"]], maybeText), /Alias null is a value/);
  });

  it("an alias names a value without reserving it", () => {
    const max = 2n ** 256n - 1n;
    const allowance = aliasItem([["unlimited", "max"]], 32);
    pinEq<DeriveType<typeof allowance>, bigint | "unlimited">(true);
    assert.equal(serialize(allowance, "unlimited").toHex(), "ff".repeat(32));
    //the plain spelling is the same value, and reads back as its name
    assert.equal(serialize(allowance, max).toHex(), "ff".repeat(32));
    assert.equal(deserialize(allowance, serialize(allowance, max)), "unlimited");
    assert.equal(deserialize(allowance, serialize(allowance, 5n)), 5n);
    assert.throws(() => aliasItem([[undefined, 256]]), /Alias 256 does not fit in u8/);
    assert.throws(() => aliasItem([[undefined, 1], [null, 1]]), /not distinct/);
    // @ts-expect-error - a bare carrier passes only its raw values through
    typeOnly(() => serialize(aliasItem([[null, 1]]), "x"));
  });

  it("an alias layers over a niche", () => {
    const zero = new Uint8Array(2);
    const word = aliasItem([["max", new Uint8Array([0xff, 0xff])]],
                           nicheItem([[null, zero]], bytesItem(2)));
    pinEq<DeriveType<typeof word>, RoUint8Array | null | "max">(true);
    assert.equal(serialize(word, "max").toHex(), "ffff");
    assert.equal(deserialize(word, serialize(word, new Uint8Array([0xff, 0xff]))), "max");
    assert.equal(serialize(word, null).toHex(), "0000");
    assert.equal(deserialize(word, zero), null);
    assert.throws(() => serialize(word, new Uint8Array(2)), /is the niche of null/);
    //an alias spells its value as the carrier surfaces it: the reserved raw is null, never bytes
    assert.throws(() => aliasItem([["zero", zero]], nicheItem([[null, zero]], bytesItem(2))),
                  /is the niche of null/);
    const zeroWord = aliasItem([["zero", null]], nicheItem([[null, zero]], bytesItem(2)));
    assert.equal(deserialize(zeroWord, serialize(zeroWord, null)), "zero");
  });

  it("enum and bool take their carrier in the width slot", () => {
    const signed = enumItem([["down", -1], ["up", 1]], intItem(1));
    assert.equal(serialize(signed, "down").toHex(), "ff");
    assert.equal(deserialize(signed, new Uint8Array([1])), "up");

    const wide = enumItem([["a", 0n], ["b", 1n << 63n]], 8);
    assert.equal(serialize(wide, "b").toHex(), "8000000000000000");
    assert.equal(deserialize(wide, serialize(wide, "a")), "a");
    // @ts-expect-error - an 8-byte enum's values are bigints
    assert.throws(() => enumItem([["a", 0]], 8), /is a number, but u64 derives a bigint/);

    const littleU64 = uintItem(8, { endianness: "little" });
    const cBool = boolItem(littleU64);
    pinEq<DeriveType<typeof cBool>, boolean>(true);
    assert.equal(serialize(cBool, true).toHex(), "0100000000000000");
    assert.throws(() => deserialize(cBool, serialize(littleU64, 2n)));
    const laxBool = boolItem({ carrier: littleU64, permissive: true });
    assert.equal(deserialize(laxBool, serialize(littleU64, 2n)), true);
    assert.equal(deserialize(boolItem(intItem(4)), serialize(intItem(4), 1)), true);
    //true is written as 1, which no i1 holds
    assert.throws(() => boolItem(intItem.bits(1)), /Bool value 1 does not fit in i1/);
    // @ts-expect-error - the item brings its own byte order
    typeOnly(() => boolItem({ carrier: littleU64, endianness: "big" }));
    // @ts-expect-error - ...and its own width
    typeOnly(() => boolItem({ carrier: littleU64, size: 8 }));
    //the carrier once rode in `size`, which elsewhere means a length prefix
    // @ts-expect-error - a size is a width, never the carrier itself
    typeOnly(() => boolItem({ size: littleU64 }));
  });

  it("customizable bytes: the two shorthands, the pinned fragment, or content", () => {
    pinEq<
      CustomizableBytes,
      | undefined
      | RoUint8Array
      | { readonly fixed: RoUint8Array, readonly as?: unknown }
      | Layout
      | Conversion<RoUint8Array>
    >(true);
    const pinned = optionItem({ fixed: new Uint8Array([1, 2]), as: "magic" });
    pinEq<DeriveType<typeof pinned>, "magic" | undefined>(true);
    assert.equal(serialize(pinned, "magic").toHex(), "010102");
  });

  it("customizable bytes: the pinned arm outranks Layout, and the runtime agrees", () => {
    //a bytes item carrying `fixed` inhabits both arms - it is absorbed, not framed
    const absorbed = customizableBytes({}, paddingItem(2));
    pinEq<typeof absorbed extends { layout: unknown } ? true : false, false>(true);
    assert.deepEqual(Object.keys(absorbed), ["binary", "fixed"]);

    //a struct field merely named `fixed` is content, so that arm must test the value, not the key
    const framed = customizableBytes({}, { fixed: uintItem(1) });
    pinEq<typeof framed extends { layout: unknown } ? true : false, true>(true);
    assert.deepEqual(Object.keys(framed), ["binary", "layout"]);
  });

  it("option accepts layouts, converted layouts included", () => {
    const maybeEntry = optionItem({ k: uintItem(1), v: uintItem(1) });
    const data = { k: 1, v: 2 };
    assert.deepEqual(deserialize(maybeEntry, serialize(maybeEntry, data)), data);

    //the option is a bare switch with a conversion - no wrapper, no nuisance key
    assert.equal(maybeEntry.binary, "switch");

    const maybeString = optionItem(withCustom({ chars: bytesItem() }, {
      to:   raw => utf8Conversion.to(raw.chars),
      from: str => ({ chars: utf8Conversion.from(str) }),
    }));
    assert.equal(deserialize(maybeString, serialize(maybeString, "hi")), "hi");
  });

  it("num factories bind fixed and custom to the width's primitive", () => {
    const numberConv = { to: (x: number) => String(x), from: (s: string) => Number(s) } as const;
    const bigintConv = { to: (x: bigint) => String(x), from: (s: string) => BigInt(s) } as const;
    const eitherConv = { to: (x: number | bigint) => String(x), from: (s: string) => BigInt(s) } as const;

    const u32 = uintItem(4, { custom: numberConv });
    const u64 = uintItem(8, { custom: bigintConv });
    assert.equal(deserialize(u32, serialize(u32, "7")), "7");
    assert.equal(deserialize(u64, serialize(u64, "7")), "7");
    // @ts-expect-error - an 8-byte field hands its conversion a bigint
    typeOnly(() => uintItem(8, { custom: numberConv }));
    // @ts-expect-error - and a 4-byte field a number
    typeOnly(() => uintItem(4, { custom: bigintConv }));
    // @ts-expect-error - fixed follows the same primitive
    typeOnly(() => uintItem(8, { fixed: 5 }));
    // @ts-expect-error - a widened width may yield either, so a one-primitive conversion won't do
    typeOnly(() => uintItem(8 as number, { custom: numberConv }));
    const wide = uintItem(8 as number, { custom: eitherConv });
    assert.equal(deserialize(wide, serialize(wide, "7")), "7");
    //bit widths cut at numberMaxBits
    uintItem.bits(53, { custom: numberConv });
    // @ts-expect-error - 54 bits derive bigint
    typeOnly(() => uintItem.bits(54, { custom: numberConv }));
    //bool, enum and niche convert from their width's primitive
    const u64Bool = boolItem(8);
    pinEq<DeriveType<typeof u64Bool>, boolean>(true);
    assert.equal(serialize(u64Bool, true).toHex(), "0000000000000001");
    // @ts-expect-error - a 7-byte enum reads bigints
    assert.throws(() => enumItem([["a", 0]], 7), /is a number, but u56 derives a bigint/);
    // @ts-expect-error - and so does a 54-bit one
    assert.throws(() => enumItem.bits([["a", 0]], 54), /is a number, but u54 derives a bigint/);
  });

  it("factory opts admit only coherent surfacing spellings", () => {
    assert.equal(hasAs(uintItem(1, { fixed: 0, as: "x" })), true);
    // @ts-expect-error - as states a constant's surfaced value: it comes with fixed
    typeOnly(() => uintItem(1, { as: "x" }));
    // @ts-expect-error - as beside custom is redundant
    typeOnly(() => bytesItem({ fixed: new Uint8Array(1), as: "x", custom: utf8Conversion }));
    // @ts-expect-error - the rule holds for every kind
    typeOnly(() => packedItem({ a: uintItem.bits(8) }, { as: "x" }));
    // @ts-expect-error - switch opts included
    typeOnly(() => switchItem("k", uintItem(1), [[1, {}]], { as: "x" }));
    //raw literals stay total: a stray as is ignored, as wins over custom
    assert.equal(deserialize({ binary: "uint", size: 1, as: "stray" } as const, new Uint8Array([7])), 7);
    assert.equal(
      deserialize({ ...boolItem(), fixed: 1, as: "yes" } as const, new Uint8Array([1])), "yes");
  });

  //regression: an item passed as an opts record whose width happened to be a number, and was
  //  nested whole into the width
  it("width slots that take only numbers reject items", () => {
    // @ts-expect-error - the presence tag is a size or opts
    typeOnly(() => optionItem(uintItem(1), uintItem(2)));
    // @ts-expect-error - ...without the carrier slot's item forms
    typeOnly(() => optionItem(uintItem(1), { size: 1, carrier: uintItem(2) }));
    // @ts-expect-error - the bit form takes a bit count; an item goes into boolItem itself
    typeOnly(() => boolItem.bits(uintItem.bits(3)));
    // @ts-expect-error - a packed word's width is a byte count
    typeOnly(() => packedItem({ a: uintItem.bits(8) }, uintItem(1)));
    // @ts-expect-error - and a lane's a bit count
    typeOnly(() => packedItem.bits({ a: uintItem.bits(2) }, uintItem.bits(3)));
  });

  it("utf8 conversion is strict in both directions", () => {
    const memo = bytesItem({ size: uintItem(1), custom: utf8Conversion });
    assert.equal(deserialize(memo, serialize(memo, "héllo")), "héllo");

    //TextDecoder defaults would U+FFFD-substitute the truncated multi-byte sequence
    assert.throws(() => deserialize(memo, new Uint8Array([2, 0x68, 0xc3])));
    //...and silently swallow a leading BOM (breaking the round-trip)
    const bom = new Uint8Array([4, 0xef, 0xbb, 0xbf, 0x41]);
    assert.equal(deserialize(memo, bom), "\ufeffA");
    assert.equal(serialize(memo, "\ufeffA").toHex(), bom.toHex());
    //TextEncoder defaults would U+FFFD-substitute a lone surrogate
    assert.throws(() => serialize(memo, "\ud800"), /lone surrogates/);
  });

  it("expresses a bitset as lsbFirst-packed flags", () => {
    //the v1 bitsetItem shape (bit i = 1 << i), stated as plain data
    const flags = packedItem(
      { a: boolItem.bits(), b: boolItem.bits(), _gap: paddingItem.bits(1), d: boolItem.bits() },
      { bitOrder: "lsbFirst", size: 1 },
    );
    assert.equal(serialize(flags, { a: true, b: false, d: true }).toHex(), "09");
    assert.deepEqual(
      deserialize(flags, new Uint8Array([0x09])),
      { a: true, b: false, d: true },
    );
  });

  it("packedItem.bits derives a lane's width, and takes one only for slack", () => {
    const group = { a: uintItem.bits(2), b: uintItem.bits(2) } as const;
    const derived = packedItem({ group: packedItem.bits(group), rest: uintItem.bits(4) });
    assert.equal(serialize(derived, { group: { a: 1, b: 2 }, rest: 3 }).toHex(), "63");

    const slack = packedItem({ group: packedItem.bits(group, 6), rest: uintItem.bits(2) });
    assert.equal(serialize(slack, { group: { a: 1, b: 2 }, rest: 3 }).toHex(), "63");
    assert.throws(() => deserialize(slack, new Uint8Array([0x67])), /slack bits are not zero/);

    //the width still travels with company, like every other width slot
    const withOrder = packedItem.bits(group, { bits: 6, bitOrder: "lsbFirst" });
    pinEq<typeof withOrder.bits, 6>(true);
  });

  it("union builds tabular switch items", () => {
    const cmd = switchItem("cmd", uintItem(1), [
      [1, "ping", {}],
      [[0x80, 0xff], { payload: uintItem(1) }],
    ]);
    pinEq<
      DeriveType<typeof cmd>,
      { readonly cmd: "ping" } | { readonly cmd: number, readonly payload: number }
    >(true);
    assert.equal(serialize(cmd, { cmd: 0x81, payload: 7 }).toHex(), "8107");
  });

  it("admits signed switch ids and resolves overlapping ranges first-match", () => {
    const status = switchItem("code", intItem(1), [
      [-1, "error", { errno: uintItem(1) }],
      [[0x10, 0x1f], { reserved: uintItem(1) }],
      [[-128, 127], { raw: uintItem(1) }],
    ]);
    assert.equal(serialize(status, { code: "error", errno: 7 }).toHex(), "ff07");
    assert.deepEqual(deserialize(status, new Uint8Array([0xff, 7])), { code: "error", errno: 7 });

    //the sandwiched range carves an exception out of the trailing catch-all, in both directions
    assert.deepEqual(deserialize(status, new Uint8Array([0x15, 3])), { code: 0x15, reserved: 3 });
    assert.deepEqual(deserialize(status, new Uint8Array([0x25, 3])), { code: 0x25, raw: 3 });
    assert.equal(serialize(status, { code: 0x15, reserved: 3 }).toHex(), "1503");
    assert.equal(serialize(status, { code: 0x25, raw: 3 }).toHex(), "2503");

    //ranged tags derive as plain numbers, so this compiles without a cast: an id paired with
    //  another range variant's fields is only caught at serialization, by the routed variant
    assert.throws(() => serialize(status, { code: 0x15, raw: 3 }), /missing data/);
  });

  it("switchItem rejects deserialization-dead variants", () => {
    //a duplicate scalar is decode-dead but still encode-reachable via its tag: round-trip break
    assert.throws(() => switchItem("kind", uintItem(1), [[1, "a", {}], [1, "b", {}]]), /dead/);
    //full coverage by the union of predecessors, across interval adjacency
    assert.throws(
      () => switchItem("kind", uintItem(1), [[[0, 5], "lo", {}], [[6, 10], "hi", {}], [[3, 8], "mid", {}]]),
      /dead/);
    assert.throws(() => switchItem("kind", uintItem(1), [[[5, 3], "empty", {}]]), /dead/);
    //a later range spanning an earlier one sorts ahead of it: 35 is covered by [8, 40] alone,
    //  the swallowed [20, 30] contributes nothing to the sweep
    assert.throws(
      () => switchItem("kind", uintItem(1), [[[20, 30], "in", {}], [[8, 40], "out", {}], [35, "x", {}]]),
      /dead/);
    //the coverage sweep depends on ascending order: [0, 4] has to be visited before [3, 10] for
    //  the frontier to reach 11, though it was declared second
    assert.throws(
      () => switchItem("kind", uintItem(1),
        [[[3, 10], "b", {}], [[0, 4], "a", {}], [[0, 10], "x", {}]]),
      /dead/);
    //partial shadowing stays legal: the exception-carving sandwich
    switchItem("kind", uintItem(1), [[1, "ping", {}], [[0x00, 0xff], { payload: uintItem(1) }]]);
  });

  //raw ids are checked for reachability, but a renamed scalar's `as` is a second tag its raw id
  //  does not determine: where it names another variant too, that variant's id decodes to a tag
  //  which serializes through the renamed one (or vice versa)
  it("switchItem rejects a surfaced tag that routes to another variant", () => {
    //`as` equal to a bare scalar's id, in either order
    assert.throws(() => switchItem("kind", uintItem(1), [[1, 2, {}], [2, {}]]), /also routes/);
    assert.throws(() => switchItem("kind", uintItem(1), [[2, {}], [1, 2, {}]]), /also routes/);
    //`as` equal to another renamed scalar's
    assert.throws(
      () => switchItem("kind", uintItem(1), [[1, "same", {}], [2, "same", {}]]), /also routes/);
    //numeric `as` inside a range, in either order
    assert.throws(
      () => switchItem("kind", uintItem(1), [[1, 2, {}], [[0, 255], {}]]), /also routes/);
    assert.throws(
      () => switchItem("kind", uintItem(1), [[[0, 10], {}], [11, 5, {}]]), /also routes/);
    //a rename to its own id, and names no other variant answers to, stay legal
    switchItem("kind", uintItem(1), [[1, 1, {}], [2, "two", {}], [[3, 9], {}]]);
  });

  it("switchItem rejects ids carrying fixed or custom", () => {
    assert.throws(() => switchItem("kind", enumItem([["a", 1]]), [[1, {}]]), /read raw/);
    assert.throws(() => switchItem("kind", uintItem(1, { fixed: 0 }), [[0, {}]]), /read raw/);
  });

  it("union accepts a switch body in variant position", () => {
    const side = switchItem("side", uintItem(1), [
      [0, "redemption", { tokens: uintItem(2) }],
      [1, "deposit",    { usdc:   uintItem(2) }],
    ]);
    const cmd = switchItem("cmd", uintItem(1), [[1, "cancel", side], [2, "noop", {}]]);
    pinEq<
      DeriveType<typeof cmd>,
      | { readonly cmd: "cancel", readonly side: "redemption", readonly tokens: number }
      | { readonly cmd: "cancel", readonly side: "deposit",    readonly usdc: number }
      | { readonly cmd: "noop" }
    >(true);
    assert.equal(serialize(cmd, { cmd: "cancel", side: "deposit", usdc: 0x1234 }).toHex(), "01011234");
    assert.deepEqual(deserialize(cmd, new Uint8Array([1, 0, 0, 7])),
      { cmd: "cancel", side: "redemption", tokens: 7 });
  });

  it("treats fixed/custom undefined as absent, at both levels", () => {
    const item = { binary: "uint", size: 1, fixed: undefined, custom: undefined } as const;
    pinEq<DeriveType<typeof item>, number>(true);
    assert.equal(hasFixed(item), false);
    assert.equal(hasCustom(item), false);
    assert.deepEqual(deserialize({ x: item }, new Uint8Array([7])), { x: 7 });
  });

  it("treats as: undefined as absent, uniformly with fixed/custom", () => {
    //previously `as` had `"as" in variant` presence semantics, so an explicit undefined
    //  was "present" and surfaced undefined as the tag value
    const item = switchItem("kind", uintItem(1), [
      [1, undefined, { x: uintItem(1) }],
      [2, null, {}],
    ]);
    pinEq<DeriveType<typeof item>,
      { readonly kind: 1, readonly x: number } | { readonly kind: null }>(true);

    assert.deepEqual(deserialize(item, new Uint8Array([1, 5])), { kind: 1, x: 5 });
    assert.equal(serialize(item, { kind: 1, x: 5 }).toHex(), "0105");
    //null remains a legitimate surfaced tag value
    assert.deepEqual(deserialize(item, new Uint8Array([2])), { kind: null });
    assert.equal(serialize(item, { kind: null }).toHex(), "02");
  });

  it("union rejects tag collisions along a variant chain", () => {
    assert.throws(
      () => switchItem("cmd", uintItem(1), [[0, "a", switchItem("cmd", uintItem(1), [[0, "b", {}]])]]),
      /reused/);
    assert.throws(
      () => switchItem("cmd", uintItem(1), [[0, "a", switchItem("side", uintItem(1), [[0, "b", { cmd: uintItem(1) }]])]]),
      /collides/);
    assert.throws(() => switchItem("cmd", uintItem(1), [[0, "a", { cmd: uintItem(1) }]]), /collides/);
  });
});

//regression: a bare uint prefix wider than number was admitted and threw on both sides
describe("prefix widths", () => {
  it("admits number-deriving bare uints only", () => {
    const six = { data: bytesItem(uintItem(6)) } as const satisfies Layout;
    assert.deepEqual(deserialize(six, serialize(six, { data: new Uint8Array([1]) })), { data: new Uint8Array([1]) });
    // @ts-expect-error an 8-byte uint derives bigint, which is no count
    typeOnly(() => bytesItem(uintItem(8)));
    // @ts-expect-error same rule for array lengths
    typeOnly(() => arrayItem(uintItem(1), uintItem(8)));
  });
});
