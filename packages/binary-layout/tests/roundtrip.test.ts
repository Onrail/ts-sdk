import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { RoArray } from "@onrail-xyz/utils";
import type { Layout } from "../src/index.js";
import { serialize, deserialize, fitsInBits, readNum, writeNum,
         calcSize, calcStaticSize, withCustom, uintItem,
         arrayItem, switchItem, leb128Codec, leb128, compactU16 } from "../src/index.js";

const roundtrip = <const L extends Layout>(layout: L, data: any, expectedHex?: string) => {
  const encoded = serialize(layout, data);
  if (expectedHex !== undefined)
    assert.equal(encoded.toHex(), expectedHex);

  assert.deepEqual(deserialize(layout, encoded), data);
  assert.equal(calcSize(layout, data), encoded.length);
  return encoded;
};

describe("num items", () => {
  it("roundtrips uints in both endiannesses", () => {
    roundtrip({ binary: "uint", size: 2 } as const, 0x1234, "1234");
    roundtrip({ binary: "uint", size: 2, endianness: "little" } as const, 0x1234, "3412");
    roundtrip({ binary: "uint", size: 8 } as const, 0x1234n, "0000000000001234");
  });

  it("roundtrips signed ints", () => {
    roundtrip({ binary: "int", size: 2 } as const, -2, "fffe");
    roundtrip({ binary: "int", size: 9 } as const, -2n, "fffffffffffffffffe");
  });

  it("checks fixed values", () => {
    const layout = { version: { binary: "uint", size: 1, fixed: 3 } } as const;
    const encoded = roundtrip(layout, {}, "03");
    encoded[0] = 4;
    assert.throws(() => deserialize(layout, encoded));
  });

  it("applies conversions", () => {
    const layout = {
      binary: "uint", size: 1,
      custom: { to: (raw: number) => raw !== 0, from: (val: boolean) => val ? 1 : 0 },
    } as const;
    roundtrip(layout, true, "01");
    roundtrip(layout, false, "00");
  });

  it("composes fixed with custom (surfaced constant)", () => {
    const layout = {
      binary: "uint", size: 1, fixed: 0,
      custom: { to: () => "legacy" as const, from: () => 0 },
    } as const;
    roundtrip(layout, "legacy", "00");
  });
});

//a field wider than the layout's number path derives bigint, but writeNum's signature admits
//  any NumType at any size - a number there is legitimate and used to be rejected outright,
//  though every safe integer encodes fine once it continues as a bigint
describe("readNum / writeNum", () => {
  const write = (val: number | bigint, size: number, signed = false) => {
    const bytes = new Uint8Array(size);
    assert.equal(writeNum(val, bytes, 0, size, "big", signed), size);
    return bytes.toHex();
  };

  //a field past numberMaxSize holds a bigint - the rule NumSizeToPrimitive derives and readNum
  //  returns, enforced here too rather than quietly promoting the number
  it("holds each width to the primitive it derives", () => {
    assert.equal(write(2 ** 47, 6), "800000000000");
    assert.throws(() => write(2 ** 50, 8), /holds a bigint/);
    assert.throws(() => write(2.5, 4), /does not fit in u32/);

    assert.equal(write(2n ** 64n - 1n, 8), "ffffffffffffffff");
    assert.throws(() => write(2n ** 64n, 8), /does not fit in u64/);
    //sign extension comes from the two's complement, not a fill loop
    assert.equal(write(-(2n ** 47n) - 1n, 8, true), "ffff7fffffffffff");
  });

  it("fitsInBits answers for both primitives, and is sign-aware", () => {
    assert.equal(fitsInBits(255, 8, false), true);
    assert.equal(fitsInBits(256, 8, false), false);
    assert.equal(fitsInBits(-1, 8, false), false);
    assert.equal(fitsInBits(127, 8, true), true);
    assert.equal(fitsInBits(128, 8, true), false);
    assert.equal(fitsInBits(-128, 8, true), true);
    assert.equal(fitsInBits(-129, 8, true), false);
    //numberMaxBits is the widest field a number is checked against
    assert.equal(fitsInBits(Number.MAX_SAFE_INTEGER, 53, false), true);
    assert.equal(fitsInBits(2 ** 53, 53, false), false);
    assert.equal(fitsInBits(-(2 ** 52), 53, true), true);
    assert.equal(fitsInBits(2 ** 52, 53, true), false);
    // @ts-expect-error - a wider field holds a bigint, so the question is refused for a number
    fitsInBits(1, 54, false);
    // @ts-expect-error - a width known only at runtime may be wide, too
    fitsInBits(1, 8 as number, false);

    //past the number path the same answers come from truncation round-tripping
    assert.equal(fitsInBits(2n ** 64n - 1n, 64, false), true);
    assert.equal(fitsInBits(2n ** 64n, 64, false), false);
    assert.equal(fitsInBits(-1n, 64, false), false);
    assert.equal(fitsInBits(-(2n ** 63n), 64, true), true);
    assert.equal(fitsInBits(-(2n ** 63n) - 1n, 64, true), false);
  });

  it("reads back what it wrote, and reports the new offset", () => {
    const bytes = Uint8Array.fromHex("00" + "0004000000000000");
    assert.deepEqual(readNum(bytes, 1, 8), [2n ** 50n, 9]);
    assert.deepEqual(readNum(Uint8Array.fromHex("3412"), 0, 2, "little"), [0x1234, 2]);
  });

  //a typed array silently drops writes past its end and yields undefined for reads there, so
  //  writeNum(0x1234, oneByte, 0, 2) used to report success with half the value on the floor
  it("refuses positions outside the buffer", () => {
    const bytes = new Uint8Array(2);
    for (const offset of [-1, 0.5, 1, 3])
      assert.throws(() => writeNum(0x12, bytes, offset, 2), /outside the buffer/);
    for (const offset of [-1, 0.5, 1, 3])
      assert.throws(() => readNum(bytes, offset, 2), /outside the buffer/);
    assert.deepEqual(bytes, new Uint8Array(2));
    assert.equal(writeNum(0x1234, bytes, 0, 2), 2);
    assert.deepEqual(readNum(bytes, 0, 2), [0x1234, 2]);
  });
});

describe("bytes items", () => {
  it("roundtrips raw bytes with fixed size", () => {
    roundtrip({ binary: "bytes", size: 3 } as const, new Uint8Array([1, 2, 3]), "010203");
  });

  it("roundtrips size-prefixed bytes", () => {
    roundtrip(
      { binary: "bytes", size: { binary: "uint", size: 2 } } as const,
      new Uint8Array([5, 6]),
      "00020506",
    );
  });

  it("roundtrips little-endian prefixes", () => {
    roundtrip(
      { binary: "bytes", size: { binary: "uint", size: 2, endianness: "little" } } as const,
      new Uint8Array([5, 6]),
      "02000506",
    );
  });

  it("roundtrips flex bytes", () => {
    roundtrip({ binary: "bytes" } as const, new Uint8Array([7, 8, 9]), "070809");
  });

  it("roundtrips bytes with layout (inline framing)", () => {
    const layout = {
      binary: "bytes",
      size: { binary: "uint", size: 1 },
      layout: { a: { binary: "uint", size: 2 }, b: { binary: "uint", size: 1 } },
    } as const;
    roundtrip(layout, { a: 0x0102, b: 3 }, "03010203");
  });

  it("checks fixed bytes", () => {
    const layout = { magic: { binary: "bytes", fixed: new Uint8Array([0xca, 0xfe]) } } as const;
    const encoded = roundtrip(layout, {}, "cafe");
    encoded[1] = 0;
    assert.throws(() => deserialize(layout, encoded));
  });

  it("scales prefix counts through conversions", () => {
    //length prefix counts 4-byte words instead of bytes
    const layout = {
      binary: "bytes",
      size: {
        binary: "uint", size: 1,
        custom: { to: (words: number) => words * 4, from: (bytes: number) => bytes / 4 },
      },
    } as const;
    roundtrip(layout, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "020102030405060708");
  });
});

describe("structs", () => {
  const entry = { key: { binary: "uint", size: 1 }, value: { binary: "uint", size: 2 } } as const;

  it("serializes fields in key order", () => {
    roundtrip(entry, { key: 1, value: 0x0203 }, "010203");
  });

  it("supports inline struct nesting", () => {
    const layout = { header: entry, tail: { binary: "uint", size: 1 } } as const;
    roundtrip(layout, { header: { key: 1, value: 2 }, tail: 3 }, "01000203");
  });

  it("throws on missing fields with the field path", () => {
    assert.throws(() => serialize(entry, { key: 1 } as any), /value/);
  });
});

describe("array items", () => {
  const element = { binary: "uint", size: 2 } as const;

  it("roundtrips fixed-length arrays", () => {
    roundtrip({ binary: "array", length: 2, layout: element } as const, [1, 2], "00010002");
  });

  it("roundtrips count-prefixed arrays", () => {
    roundtrip(
      { binary: "array", length: { binary: "uint", size: 1 }, layout: element } as const,
      [1, 2, 3],
      "03000100020003",
    );
  });

  it("roundtrips flex arrays", () => {
    roundtrip({ binary: "array", layout: element } as const, [1, 2], "00010002");
  });

  it("rejects length mismatches", () => {
    assert.throws(() => serialize({ binary: "array", length: 2, layout: element } as const,
      [1] as any));
  });
});

describe("switch items", () => {
  const u8 = { binary: "uint", size: 1 } as const;
  const layout = {
    binary: "switch",
    id: u8,
    tag: "cmd",
    variants: [
      { id: 1, as: "ping", layout: {} },
      { id: 2, as: "pong", layout: { nonce: { binary: "uint", size: 2 } } },
      { id: [0x80, 0xff], layout: { payload: { binary: "bytes", size: 1 } } },
    ],
  } as const;

  it("roundtrips scalar variants with surfaced tags", () => {
    roundtrip(layout, { cmd: "ping" }, "01");
    roundtrip(layout, { cmd: "pong", nonce: 5 }, "020005");
  });

  it("roundtrips range variants surfacing the wire value", () => {
    roundtrip(layout, { cmd: 0x9a, payload: new Uint8Array([7]) }, "9a07");
  });

  it("rejects unknown ids and tag values", () => {
    assert.throws(() => deserialize(layout, new Uint8Array([0x03])), /unknown id/);
    assert.throws(() => serialize(layout, { cmd: "nope" } as any), /unknown tag/);
  });

  it("resolves overlapping variant ids first-match in both directions", () => {
    const overlapping = {
      binary: "switch",
      tag: "kind",
      id: u8,
      variants: [
        { id: 5, as: "exact", layout: {} },
        { id: [0, 10], layout: {} },
      ],
    } as const;
    //the scalar variant precedes the range, so 5 resolves to it on read and write
    assert.deepEqual(deserialize(overlapping, serialize(overlapping, { kind: "exact" })),
      { kind: "exact" });
    assert.deepEqual(deserialize(overlapping, new Uint8Array([6])), { kind: 6 });
  });

  it("defaults the tag value to the id", () => {
    const plain = {
      binary: "switch",
      tag: "kind",
      id: u8,
      variants: [{ id: 7, layout: {} }],
    } as const;
    roundtrip(plain, { kind: 7 }, "07");
  });

  it("merges a switch body in variant position into the tag row", () => {
    const inner = {
      binary: "switch",
      id: u8,
      tag: "side",
      variants: [
        { id: 0, as: "redemption", layout: { tokens: { binary: "uint", size: 2 } } },
        { id: 1, as: "deposit",    layout: { usdc:   { binary: "uint", size: 2 } } },
      ],
    } as const;
    const outer = {
      binary: "switch",
      id: u8,
      tag: "cmd",
      variants: [
        { id: 1, as: "cancel", layout: inner },
        { id: 2, as: "noop",   layout: {} },
      ],
    } as const;
    roundtrip(outer, { cmd: "cancel", side: "deposit", usdc: 0x1234 }, "01011234");
    roundtrip(outer, { cmd: "cancel", side: "redemption", tokens: 7 }, "01000007");
    roundtrip(outer, { cmd: "noop" }, "02");
  });
});

describe("packed items", () => {
  it("roundtrips the pausedAndBps shape without manual masking", () => {
    //1 bit flag, 1 padding bit, 14 bit fee - MSB-first: fee is most significant
    const layout = {
      binary: "packed",
      layout: {
        serviceFee: { binary: "uint", bits: 14 },
        _pad:       { binary: "uint", bits: 1, fixed: 0 },
        isPaused:   {
          binary: "uint", bits: 1,
          custom: { to: (raw: number) => raw !== 0, from: (val: boolean) => val ? 1 : 0 },
        },
      },
    } as const;

    //fee = 300 bps, paused: word = 300 << 2 | 1
    roundtrip(layout, { serviceFee: 300, isPaused: true },
      ((300 << 2) | 1).toString(16).padStart(4, "0"));
    assert.equal(calcStaticSize(layout), 2);
  });

  it("roundtrips packed arrays of bit fields", () => {
    //16 4-bit fields in a u64 (the orderItem shape)
    const layout = {
      binary: "packed",
      layout: { order: { binary: "array", length: 16, layout: { binary: "uint", bits: 4 } } },
    } as const;
    const order = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    const encoded = roundtrip(layout, { order });
    assert.equal(encoded.length, 8);
    assert.equal(encoded.toHex(), "fedcba9876543210");
  });

  it("roundtrips little-endian packed words", () => {
    const layout = {
      binary: "packed",
      endianness: "little",
      layout: { hi: { binary: "uint", bits: 8 }, lo: { binary: "uint", bits: 8 } },
    } as const;
    roundtrip(layout, { hi: 0xab, lo: 0xcd }, "cdab");
  });

  it("embeds byte-sized items verbatim", () => {
    const layout = {
      binary: "packed",
      layout: {
        count: { binary: "uint", size: 2 },
        flag:  { binary: "uint", bits: 8 },
      },
    } as const;
    roundtrip(layout, { count: 0x0102, flag: 3 }, "010203");
  });

  it("roundtrips signed bit fields", () => {
    const layout = {
      binary: "packed",
      layout: { a: { binary: "int", bits: 4 }, b: { binary: "uint", bits: 4 } },
    } as const;
    roundtrip(layout, { a: -1, b: 2 }, "f2");
  });

  it("sizes byte-granular fixed bytes from their constants", () => {
    //size-less fixed bytes (paddingItem's shape) were rejected despite their static constant
    const layout = {
      binary: "packed",
      layout: {
        flag:  { binary: "uint", bits: 8 },
        _pad:  { binary: "bytes", fixed: new Uint8Array(1) },
        magic: { binary: "bytes", fixed: new Uint8Array([0xab]), as: "magic" },
      },
    } as const;
    roundtrip(layout, { flag: 5, magic: "magic" }, "0500ab");
    assert.equal(calcStaticSize(layout), 3);
  });

  it("verifies fixed arrays and applies array conversions inside packed words", () => {
    //serialization crashed on a fixed array's omitted data, deserialization skipped the
    //  constant check, and an array's own conversion was ignored in both directions
    const layout = {
      binary: "packed",
      layout: {
        magic: { binary: "array", length: 2, layout: { binary: "uint", bits: 4 }, fixed: [0xa, 0xb] },
        mask:  {
          binary: "array", length: 8, layout: { binary: "uint", bits: 1 },
          custom: {
            to:   (raw: RoArray<number>) => raw.join(""),
            from: (bits: string) => bits.split("").map(Number),
          },
        },
      },
    } as const;
    roundtrip(layout, { mask: "10100110" }, "aba6");
    assert.throws(() => deserialize(layout, Uint8Array.fromHex("bba6")), /fixed value/);
  });

  it("rejects unaligned layouts and width overflows", () => {
    assert.throws(() => calcStaticSize(
      { binary: "packed", layout: { a: { binary: "uint", bits: 3 } } } as const),
      /byte-aligned/);
    assert.throws(() => serialize(
      { binary: "packed", layout: { a: { binary: "uint", bits: 8 } } } as const,
      { a: 256 } as any));
    assert.throws(() => calcStaticSize(
      { binary: "packed", size: 1, layout: { a: { binary: "uint", bits: 16 } } } as const),
      /too small/);
  });

  it("orders fields from the LSB when asked", () => {
    const layout = {
      binary: "packed", bitOrder: "lsbFirst",
      layout: { lo: { binary: "uint", bits: 4 }, hi: { binary: "uint", bits: 4 } },
    } as const;
    roundtrip(layout, { lo: 0x1, hi: 0x2 }, "21");
  });

  it("zero-fills the slack of an oversized size past the last field", () => {
    //the solc storage shape: first-declared field in the low bits, unused space on top
    const lsb = {
      binary: "packed", size: 4, bitOrder: "lsbFirst",
      layout: { a: { binary: "uint", size: 1 }, b: { binary: "uint", size: 2 } },
    } as const;
    roundtrip(lsb, { a: 0xaa, b: 0xbbcc }, "00bbccaa");

    const msb = {
      binary: "packed", size: 3,
      layout: { x: { binary: "uint", size: 2 } },
    } as const;
    roundtrip(msb, { x: 0x1234 }, "123400");
  });

  it("rejects nonzero slack bits when deserializing", () => {
    const lsb = { binary: "packed", size: 2, bitOrder: "lsbFirst",
      layout: { a: { binary: "uint", bits: 8 } } } as const;
    assert.throws(() => deserialize(lsb, new Uint8Array([0x01, 0xab])), /slack/);

    const msb = { binary: "packed", size: 2,
      layout: { a: { binary: "uint", bits: 8 } } } as const;
    assert.throws(() => deserialize(msb, new Uint8Array([0xab, 0x01])), /slack/);
  });

  it("lifts the byte-alignment requirement when the slack is bit-granular", () => {
    const lsb = { binary: "packed", size: 1, bitOrder: "lsbFirst",
      layout: { a: { binary: "uint", bits: 3 } } } as const;
    roundtrip(lsb, { a: 0b101 }, "05");

    const msb = { binary: "packed", size: 1,
      layout: { a: { binary: "uint", bits: 3 } } } as const;
    roundtrip(msb, { a: 0b101 }, "a0");
  });

  it("inline structs and arrays inherit the bit order", () => {
    //the solc flattening: declaring everything in declaration order just works
    const layout = {
      binary: "packed", bitOrder: "lsbFirst",
      layout: {
        s: { a: { binary: "uint", bits: 8 }, b: { binary: "uint", bits: 8 } },
        c: { binary: "uint", bits: 8 },
      },
    } as const;
    roundtrip(layout, { s: { a: 1, b: 2 }, c: 3 }, "030201");

    const arr = {
      binary: "packed", bitOrder: "lsbFirst",
      layout: { order: { binary: "array", length: 2, layout: { binary: "uint", bits: 4 } } },
    } as const;
    roundtrip(arr, { order: [1, 2] }, "21");
  });

  it("combines lsbFirst with a little-endian word (the C bitfield on x86)", () => {
    const layout = {
      binary: "packed", bitOrder: "lsbFirst", endianness: "little",
      layout: { a: { binary: "uint", bits: 8 }, b: { binary: "uint", bits: 8 } },
    } as const;
    roundtrip(layout, { a: 0xab, b: 0xcd }, "abcd");
  });

  it("nested packed lanes keep their own bit order", () => {
    const layout = {
      binary: "packed", bitOrder: "lsbFirst",
      layout: {
        inner: { binary: "packed",
          layout: { hi: { binary: "uint", bits: 4 }, lo: { binary: "uint", bits: 4 } } },
        top: { binary: "uint", bits: 8 },
      },
    } as const;
    roundtrip(layout, { inner: { hi: 0x1, lo: 0x2 }, top: 3 }, "0312");
  });

  it("nested packed lanes keep their own byte order", () => {
    const layout = {
      binary: "packed",
      layout: {
        tag:  { binary: "uint", bits: 8 },
        word: { binary: "packed", endianness: "little",
          layout: { x: { binary: "uint", bits: 16 } } },
      },
    } as const;
    roundtrip(layout, { tag: 0xff, word: { x: 0x1234 } }, "ff3412");
  });

  it("nested packed lanes carry fixed and custom", () => {
    const version = {
      binary: "packed", fixed: { major: 1, minor: 2 },
      layout: { major: { binary: "uint", bits: 4 }, minor: { binary: "uint", bits: 4 } },
    } as const;
    //a conversion on a group of bits - the whole point of a lane over an inline struct
    const scaled = {
      binary: "packed",
      layout: { whole: { binary: "uint", bits: 12 }, frac: { binary: "uint", bits: 4 } },
      custom: {
        to:   (raw: { whole: number, frac: number }) => raw.whole + raw.frac / 16,
        from: (val: number) => ({ whole: Math.floor(val), frac: Math.round((val % 1) * 16) }),
      },
    } as const;
    const layout = { binary: "packed", layout: { version, value: scaled } } as const;

    roundtrip(layout, { value: 3.5 }, "120038");
    assert.throws(() => deserialize(layout, new Uint8Array([0x13, 0x00, 0x38])),
      /packed lane does not match its fixed value/);
  });

  //byte alignment is an obligation of the wire; a lane inside a word does not face it
  it("derives a nested packed lane's exact bit width", () => {
    const group = { a: { binary: "uint", bits: 2 }, b: { binary: "uint", bits: 2 } } as const;
    const layout = {
      binary: "packed",
      layout: {
        group: { binary: "packed", layout: group },
        rest:  { binary: "uint", bits: 4 },
      },
    } as const;
    const data = { group: { a: 1, b: 2 }, rest: 3 };
    roundtrip(layout, data, "63");
    assert.equal(calcStaticSize(layout), 1);

    //claiming a byte order makes it a byte lane, which owes that alignment again
    const asByteLane = {
      binary: "packed",
      layout: {
        group: { binary: "packed", endianness: "little", layout: group },
        rest:  { binary: "uint", bits: 4 },
      },
    } as const;
    assert.throws(() => serialize(asByteLane, data), /not byte-aligned/);

    //a bit width and a byte order describe the lane in incompatible units
    const bothUnits = {
      binary: "packed",
      layout: {
        group: { binary: "packed", bits: 4, endianness: "little", layout: group },
        rest:  { binary: "uint", bits: 4 },
      },
    } as const;
    assert.throws(() => serialize(bothUnits, data), /whole bytes/);
  });

  it("sub-byte lanes are legal once they state their bit width", () => {
    const layout = {
      binary: "packed",
      layout: {
        group: { binary: "packed", bits: 4, bitOrder: "lsbFirst",
          layout: { a: { binary: "uint", bits: 2 }, b: { binary: "uint", bits: 2 } } },
        rest:  { binary: "uint", bits: 4 },
      },
    } as const;
    //the lane's own lsbFirst applies within its 4 bits: a low, b high -> 0b1001
    roundtrip(layout, { group: { a: 1, b: 2 }, rest: 3 }, "93");
  });

  it("a sub-byte lane carries a conversion over its group of bits", () => {
    const layout = {
      binary: "packed",
      layout: {
        v: {
          binary: "packed", bits: 4,
          layout: { hi: { binary: "uint", bits: 2 }, lo: { binary: "uint", bits: 2 } },
          custom: {
            to:   (raw: { hi: number, lo: number }) => `${raw.hi}.${raw.lo}`,
            from: (val: string) => ({ hi: Number(val[0]), lo: Number(val[2]) }),
          },
        },
        rest: { binary: "uint", bits: 4 },
      },
    } as const;
    roundtrip(layout, { v: "1.2", rest: 0 }, "60");
  });

  it("a lane's stated bit width admits slack, verified zero on the wire", () => {
    const layout = {
      binary: "packed",
      layout: {
        group: { binary: "packed", bits: 6, layout: { a: { binary: "uint", bits: 4 } } },
        rest:  { binary: "uint", bits: 2 },
      },
    } as const;
    roundtrip(layout, { group: { a: 0xa }, rest: 1 }, "a1");
    assert.throws(() => deserialize(layout, new Uint8Array([0xab])), /slack/);
  });

  it("a sub-byte lane can be a constant", () => {
    const layout = {
      binary: "packed",
      layout: {
        magic: { binary: "packed", bits: 4, fixed: { a: 1, b: 2 },
          layout: { a: { binary: "uint", bits: 2 }, b: { binary: "uint", bits: 2 } } },
        rest:  { binary: "uint", bits: 4 },
      },
    } as const;
    roundtrip(layout, { rest: 3 }, "63");
    assert.throws(() => deserialize(layout, new Uint8Array([0x73])),
      /does not match its fixed value/);
  });

  it("treats an explicitly undefined bit width as absent", () => {
    const layout = {
      binary: "packed",
      layout: {
        word: { binary: "packed", bits: undefined, endianness: "little", fixed: { x: 0x1234 },
          layout: { x: { binary: "uint", bits: 16 } } },
        rest: { binary: "uint", bits: 8 },
      },
    } as const;
    //a lane would skip the byte swap - the word must still render in its own byte order
    roundtrip(layout, { rest: 2 }, "341202");
  });

  it("rejects a bit-width packed item at the wire boundary", () => {
    const lane = { binary: "packed", bits: 4, layout: { a: { binary: "uint", bits: 4 } } } as const;
    assert.throws(() => serialize(lane, { a: 1 }), /only legal inside packed layouts/);
    assert.throws(() => calcStaticSize(lane), /only legal inside packed layouts/);
  });

  it("roundtrips signed and fixed fields under lsbFirst", () => {
    const layout = {
      binary: "packed", bitOrder: "lsbFirst",
      layout: {
        a:    { binary: "int", bits: 4 },
        _pad: { binary: "uint", bits: 4, fixed: 0 },
        b:    { binary: "uint", bits: 8 },
      },
    } as const;
    roundtrip(layout, { a: -1, b: 2 }, "020f");
  });
});

describe("codec items", () => {
  it("roundtrips codec leaves", () => {
    roundtrip(compactU16, 5, "05");
    roundtrip(compactU16, 0x80, "8001");
    roundtrip(compactU16, 0x3fff, "ff7f");
    roundtrip(leb128, 0n, "00");
    roundtrip(leb128, 300n, "ac02");
    roundtrip(leb128, 2n ** 64n - 1n, "ffffffffffffffffff01");
  });

  it("rejects non-minimal and out-of-range varints", () => {
    //Solana's validator rejects exactly these "alias" vectors
    for (const alias of [[0x80, 0x00], [0x80, 0x80, 0x00]])
      assert.throws(() => deserialize(compactU16, new Uint8Array(alias)), /non-minimal/);

    //21 bits of payload in 3 well-formed bytes still exceeds u16
    assert.throws(() => deserialize(compactU16, new Uint8Array([0xff, 0xff, 0x7f])), /does not fit in u16/);
    //a continuing 3rd byte pushes past the 3-byte cap
    assert.throws(
      () => deserialize(compactU16, new Uint8Array([0x80, 0x80, 0x80, 0x01])), /exceeds 3 bytes/);

    //the 10th byte may only contribute 1 bit; previously the excess was silently masked
    //  to 64 bits instead of rejected
    const overflowing = new Uint8Array([...Array(9).fill(0xff), 0x7f]);
    assert.throws(() => deserialize(leb128, overflowing), /does not fit in u64/);
  });

  it("other widths fall out of the factory", () => {
    const u32 = leb128Codec(32);
    roundtrip(u32, 0xffffffff, "ffffffff0f");
    assert.throws(() => deserialize(u32, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x1f])), /does not fit in u32/);
  });

  it("permissive mode admits padded encodings", () => {
    //WASM's u32: 0x03 and 0x83 0x00 are both well-formed encodings of 3
    const wasmU32 = leb128Codec(32, { permissive: true });
    assert.equal(deserialize(wasmU32, new Uint8Array([0x03])), 3);
    assert.equal(deserialize(wasmU32, new Uint8Array([0x83, 0x00])), 3);
    assert.equal(deserialize(wasmU32, new Uint8Array([0x83, 0x80, 0x80, 0x80, 0x00])), 3);
    //serialization stays minimal
    assert.equal(serialize(wasmU32, 3).toHex(), "03");
    //the ⌈32/7⌉ = 5 byte cap and the value bound still hold
    assert.throws(
      () => deserialize(wasmU32, new Uint8Array([0x83, 0x80, 0x80, 0x80, 0x80, 0x00])),
      /exceeds 5 bytes/);
    assert.throws(
      () => deserialize(wasmU32, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x1f])), /does not fit in u32/);
  });

  it("serves as an array count prefix (Solana vec)", () => {
    const vec = { binary: "array", length: compactU16, layout: { binary: "uint", size: 1 } } as const;
    const data = Array.from({ length: 130 }, (_, i) => i % 256);
    const encoded = roundtrip(vec, data);
    assert.equal(encoded.length, 2 + 130);
    assert.equal(encoded.subarray(0, 2).toHex(), "8201");
  });

  it("serves as a bytes size prefix", () => {
    const item = { binary: "bytes", size: compactU16 } as const;
    roundtrip(item, new Uint8Array([1, 2, 3]), "03010203");
  });

  it("supports fixed and custom composition", () => {
    const layout = { sentinel: { ...compactU16, fixed: 0x80 } } as const;
    roundtrip(layout, {}, "8001");

    const converted = {
      ...compactU16,
      custom: { to: (raw: number) => `#${raw}`, from: (val: string) => Number(val.slice(1)) },
    } as const;
    roundtrip(converted, "#300", "ac02");
  });
});

describe("deserialize modes", () => {
  it("returns consumed offset when consumeAll is false", () => {
    const layout = { binary: "uint", size: 2 } as const;
    const [value, offset] = deserialize(layout, new Uint8Array([0, 5, 9, 9]), false);
    assert.equal(value, 5);
    assert.equal(offset, 2);
  });

  it("rejects trailing bytes when consuming all", () => {
    assert.throws(() =>
      deserialize({ binary: "uint", size: 2 } as const, new Uint8Array([0, 5, 9])));
  });
});

describe("fixed and custom on aggregates", () => {
  const u8 = uintItem(1);
  const rgb = arrayItem(u8, 3);
  const cmd = switchItem("cmd", u8, [[1, "ping", {}], [2, "pong", { nonce: u8 }]]);

  it("pins an array - the constant is its content, the count travels as a prefix", () => {
    const black = { ...rgb, fixed: [0, 0, 0] } as const;
    roundtrip(black, undefined, "000000");
    assert.equal(calcStaticSize(black), 3);
    assert.throws(() => deserialize(black, new Uint8Array([0, 0, 1])), /mismatch/);
    //a manual length disagreeing with the constant is caught at first use
    assert.throws(() => serialize({ ...rgb, fixed: [0, 0] } as const, undefined),
      /array length mismatch: layout length: 3, data length: 2/);

    const prefixed = { ...arrayItem(u8, { length: u8 }), fixed: [7, 8] } as const;
    roundtrip(prefixed, undefined, "020708");
    assert.equal(calcStaticSize(prefixed), 3);
    assert.throws(() => deserialize(prefixed, new Uint8Array([3, 7, 8, 9])), /length mismatch/);

    roundtrip({ ...rgb, fixed: [0, 0, 0], as: "black" } as const, "black", "000000");
  });

  it("converts an array - a count prefix measures the raw sequence", () => {
    const hex = {
      to:   (bytes: RoArray<number>) => bytes.map(b => b.toString(16).padStart(2, "0")).join(""),
      from: (str: string) => Array.from({ length: str.length / 2 }, (_, i) =>
              parseInt(str.slice(2 * i, 2 * i + 2), 16)),
    };
    roundtrip(withCustom(arrayItem(u8, 3 as number), hex), "ff8000", "ff8000");
    roundtrip(withCustom(arrayItem(u8, u8), hex), "ff80", "02ff80");
    roundtrip(withCustom(arrayItem(u8), hex), "", "");
  });

  it("pins a switch - id and variant content whole", () => {
    const pong7 = { ...cmd, fixed: { cmd: "pong", nonce: 7 } } as const;
    roundtrip(pong7, undefined, "0207");
    assert.equal(calcStaticSize(pong7), 2);
    assert.throws(() => deserialize(pong7, new Uint8Array([2, 8])), /mismatch/);
    assert.throws(() => deserialize(pong7, new Uint8Array([1, 7])), /mismatch/);

    roundtrip({ ...cmd, fixed: { cmd: "ping" }, as: "ping!" } as const, "ping!", "01");
  });

  it("converts a switch", () => {
    const maybeNonce = withCustom(cmd, {
      to:   v => v.cmd === "pong" ? v.nonce : null,
      from: n => n === null ? { cmd: "ping" } as const : { cmd: "pong", nonce: n } as const,
    });
    roundtrip(maybeNonce, null, "01");
    roundtrip(maybeNonce, 7, "0207");
  });
});
