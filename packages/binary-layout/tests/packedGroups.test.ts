import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { RoUint8Array } from "@onrail-xyz/utils";
import type { DeriveType, Layout } from "../src/index.js";
import { serialize, deserialize, calcSize,
         calcStaticSize, withCustom, pin, spreadLayout, unwrapSingleton,
         uintItem, intItem, bytesItem, packedItem, paddingItem, boolItem } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

const roundtrip = <const L extends Layout>(layout: L, data: any, expectedHex: string) => {
  const encoded = serialize(layout, data);
  assert.equal(encoded.toHex(), expectedHex);
  assert.deepEqual(deserialize(layout, encoded), data);
  assert.equal(calcSize(layout, data), encoded.length);
  assert.equal(calcStaticSize(layout), encoded.length);
  return encoded;
};

//a struct's item form is the struct: inside a word it is a group of the word's bits
describe("struct item forms inside packed", () => {
  const padded = { _pad: paddingItem.bits(2), v: uintItem.bits(5) } as const;

  it("an unwrapped padded group round-trips as bits of the word", () => {
    const layout = packedItem({ flag: boolItem.bits(), level: unwrapSingleton(padded) });
    pinEq<DeriveType<typeof layout>, { readonly flag: boolean, readonly level: number }>(true);
    roundtrip(layout, { flag: true, level: 3 }, "83");
  });

  it("matches the lane spelling on the wire", () => {
    const viaGroup = packedItem({ flag: boolItem.bits(), level: unwrapSingleton(padded) });
    const viaLane = packedItem({
      flag:  boolItem.bits(),
      level: withCustom(packedItem.bits(padded), {
        to:   raw => raw.v,
        from: (v: number) => ({ v }),
      }),
    });
    for (const level of [0, 3, 31]) {
      const data = { flag: level % 2 === 0, level };
      assert.equal(serialize(viaGroup, data).toHex(), serialize(viaLane, data).toHex());
      assert.deepEqual(deserialize(viaGroup, serialize(viaLane, data)), data);
    }
  });

  it("withCustom converts a group without changing its bits", () => {
    const version = { major: uintItem.bits(4), minor: uintItem.bits(4) } as const;
    const plain = packedItem({ version, rest: uintItem(1) });
    const converted = packedItem({
      version: withCustom(version, {
        to:   ({ major, minor }) => `${major}.${minor}`,
        from: (v: string) => ({ major: Number(v[0]), minor: Number(v[2]) }),
      }),
      rest: uintItem(1),
    });
    pinEq<DeriveType<typeof converted>["version"], string>(true);
    const encoded = roundtrip(converted, { version: "1.2", rest: 7 }, "1207");
    assert.equal(serialize(plain, { version: { major: 1, minor: 2 }, rest: 7 }).toHex(),
      encoded.toHex());
  });

  it("spreadLayout flattens a group of the word", () => {
    const record = { head: { a: uintItem.bits(3), b: uintItem.bits(5) }, c: uintItem.bits(4) };
    const layout = packedItem({ record: spreadLayout(record, "head"), d: uintItem.bits(4) });
    roundtrip(layout, { record: { a: 5, b: 1, c: 0xa }, d: 0xb }, "a1ab");
  });

  it("nests groups within groups", () => {
    const inner = unwrapSingleton({ _p: paddingItem.bits(1), v: uintItem.bits(3) });
    const outer = withCustom({ inner, w: uintItem.bits(4) }, {
      to:   ({ inner, w }) => [inner, w] as const,
      from: ([inner, w]: readonly [number, number]) => ({ inner, w }),
    });
    const layout = packedItem({ outer, tail: intItem.bits(8) });
    roundtrip(layout, { outer: [5, 9], tail: -1 }, "59ff");
  });

  it("inherits the word's bit order, as the plain struct does", () => {
    const group = { lo: uintItem.bits(3), hi: uintItem.bits(1) } as const;
    const opts = { bitOrder: "lsbFirst" } as const;
    const plain = packedItem({ a: uintItem.bits(4), group }, opts);
    const converted = packedItem({
      a: uintItem.bits(4),
      group: withCustom(group, {
        to:   ({ lo, hi }) => hi * 8 + lo,
        from: (v: number) => ({ lo: v % 8, hi: v >> 3 }),
      }),
    }, opts);
    //lsbFirst: a in bits 0-3, lo in 4-6, hi in 7
    roundtrip(converted, { a: 1, group: 0xd }, "d1");
    assert.equal(serialize(plain, { a: 1, group: { lo: 5, hi: 1 } }).toHex(), "d1");

    //byte-sized fields of a group follow the word's bit order too - no standalone byte order
    const bytePair = { x: uintItem(1), y: uintItem(1) } as const;
    const identity = { to: (v: { x: number, y: number }) => v, from: (v: any) => v };
    for (const bitOrder of ["msbFirst", "lsbFirst"] as const) {
      const viaGroup = packedItem({ pair: withCustom(bytePair, identity) }, { bitOrder });
      const viaStruct = packedItem({ pair: bytePair }, { bitOrder });
      const data = { pair: { x: 1, y: 2 } };
      assert.equal(serialize(viaGroup, data).toHex(), serialize(viaStruct, data).toHex());
      assert.deepEqual(deserialize(viaGroup, serialize(viaStruct, data)), data);
    }
  });

  it("holds lanes and byte-sized fields", () => {
    const group = withCustom({ hi: uintItem(1), lane: packedItem.bits({ x: uintItem.bits(4) }) }, {
      to:   ({ hi, lane }) => hi * 16 + lane.x,
      from: (v: number) => ({ hi: v >> 4, lane: { x: v % 16 } }),
    });
    roundtrip(packedItem({ group, _pad: paddingItem.bits(4) }), { group: 0x12a }, "12a0");
  });

  for (const bitOrder of ["msbFirst", "lsbFirst"] as const)
    it(`a pinned group is a constant of the word (${bitOrder})`, () => {
      const magic = pin({ a: uintItem.bits(2), b: uintItem.bits(2) }, { a: 1, b: 2 });
      const layout = packedItem({ magic, rest: uintItem.bits(4) }, { bitOrder });
      const expected = bitOrder === "msbFirst" ? "63" : "39";
      const encoded = roundtrip(layout, { magic: { a: 1, b: 2 }, rest: 3 }, expected);
      encoded[0]! ^= bitOrder === "msbFirst" ? 0x10 : 0x01;
      assert.throws(() => deserialize(layout, encoded), /packed group does not match/);
    });

  it("an omitted fixed group surfaces nothing", () => {
    const layout = packedItem({
      _magic: bytesItem({ layout: { a: uintItem.bits(4) }, fixed: { a: 0xc } }),
      rest:   uintItem.bits(4),
    });
    roundtrip(layout, { rest: 5 }, "c5");
  });

  it("renders groups inside fixed words and fixed lanes", () => {
    const group = unwrapSingleton({ _p: paddingItem.bits(4), v: uintItem.bits(4) });
    roundtrip({ word: packedItem({ g: group }, { fixed: { g: 5 } }) }, {}, "05");

    const lane = packedItem.bits({ g: group }, { fixed: { g: 6 } });
    const layout = packedItem({ lane, rest: uintItem.bits(8) });
    roundtrip(layout, { rest: 1 }, "0601");
    assert.throws(() => deserialize(layout, new Uint8Array([0x07, 0x01])),
      /packed lane does not match/);
  });

  it("a sized bytes item stays a standalone byte lane", () => {
    const content = { x: uintItem(2, { endianness: "little" }) } as const;
    const layout = packedItem({
      lane: bytesItem({ size: 2, layout: content }),
      rest: uintItem.bits(8),
    });
    roundtrip(layout, { lane: { x: 0x1234 }, rest: 1 }, "341201");

    //the group form owns no byte order - its fields are bits of the word
    const asGroup = packedItem({
      group: withCustom(content, { to: v => v.x, from: (x: number) => ({ x }) }),
      rest:  uintItem.bits(8),
    });
    assert.throws(() => serialize(asGroup, { group: 0x1234, rest: 1 }),
      /must not specify endianness/);
  });

  it("rejects what a plain struct inside packed rejects", () => {
    const flexy = packedItem({ g: withCustom({ b: bytesItem() }, {
      to:   v => v.b,
      from: (b: RoUint8Array) => ({ b }),
    }) });
    assert.throws(() => calcStaticSize(flexy), /must have a static size/);
  });
});
