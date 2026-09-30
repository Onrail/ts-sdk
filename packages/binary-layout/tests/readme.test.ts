//Every code example in README.md lives here first: the README shows nothing this suite
//  doesn't execute, so the two can't drift apart silently. The one exemption is the Future
//  Direction section, which shows what does not exist yet - each sketch joins the suite
//  when it ships.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Brand, RoUint8Array, RoArray,
              RoPair, Existential, OptionalArg } from "@onrail-xyz/utils";
import type { DeriveType, Layout, Conversion, CustomizableBytes } from "../src/index.js";
import { serialize, deserialize, calcSize, calcStaticSize,
         buildDiscriminator, buildDeserializer, setEndianness, withCustom,
         pin, uintItem, intItem, bytesItem, arrayItem, packedItem,
         switchItem, boolItem, paddingItem, enumItem, optionItem,
         timestampItem, codecItem, brandConversion, utf8Conversion,
         customizableBytes, leb128Codec, compactU16, rlpUint } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

// ---- In a Nutshell ----

describe("README: in a nutshell", () => {
  it("serializes bare items", () => {
    assert.equal(serialize(uintItem(2), 42).toHex(), "002a");

    const decoded = deserialize(uintItem(8), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 42]));
    pinEq<typeof decoded, bigint>(true);
    assert.equal(decoded, 42n);
  });

  it("round-trips the dns entry", () => {
    const dnsEntryLayout = {
      domain: bytesItem({ size: uintItem(1), custom: utf8Conversion }),
      ip:     arrayItem(uintItem(1), 4),
    };
    type DnsEntry = DeriveType<typeof dnsEntryLayout>;
    pinEq<DnsEntry, {
      readonly domain: string,
      readonly ip: readonly [number, number, number, number],
    }>(true);

    const entry = { domain: "localhost", ip: [127, 0, 0, 1] } as const satisfies DnsEntry;
    const encoded = serialize(dnsEntryLayout, entry);
    assert.equal(encoded.toHex(), "09" + "6c6f63616c686f7374" + "7f000001");
    assert.deepEqual(deserialize(dnsEntryLayout, encoded), entry);
  });
});

// ---- Showcase ----

const ipV4Item = arrayItem(uintItem(1), 4);
const ipV6Item = arrayItem(uintItem(2), 8);
const domainItem = bytesItem({ size: uintItem(1), custom: utf8Conversion });

const socks5RequestLayout = {
  version:  uintItem(1, { fixed: 5 }),
  command:  enumItem([["connect", 1], ["bind", 2], ["udpAssociate", 3]]),
  reserved: paddingItem(1),
  address:  switchItem("type", uintItem(1), [
    [1, "IPv4",   { ip:   ipV4Item   }],
    [3, "domain", { name: domainItem }],
    [4, "IPv6",   { ip:   ipV6Item   }],
  ]),
  port:     uintItem(2),
};

describe("README: showcase", () => {
  it("derives the request type", () => {
    type Socks5Request = DeriveType<typeof socks5RequestLayout>;
    pinEq<Socks5Request, {
      readonly command: "connect" | "bind" | "udpAssociate",
      readonly address:
        { readonly type: "IPv4",   readonly ip: readonly [number, number, number, number] } |
        { readonly type: "domain", readonly name: string } |
        { readonly type: "IPv6",
          readonly ip: readonly [number, number, number, number, number, number, number, number] },
      readonly port: number,
    }>(true);
  });

  it("serializes a domain request", () => {
    const encoded = serialize(socks5RequestLayout, {
      command: "connect",
      address: { type: "domain", name: "example.com" },
      port: 443,
    });
    assert.equal(encoded.toHex(), "05" + "01" + "00" + "03" + "0b" + "6578616d706c652e636f6d" + "01bb");
  });

  it("deserializes an IPv4 request", () => {
    assert.deepEqual(
      deserialize(socks5RequestLayout, new Uint8Array([5, 3, 0, 1, 127, 0, 0, 1, 0, 53])),
      { command: "udpAssociate", address: { type: "IPv4", ip: [127, 0, 0, 1] }, port: 53 },
    );
  });
});

// ---- Showcase teasers ----

describe("README: teasers", () => {
  it("packs a register word", () => {
    const statusRegister = packedItem({
      ready:   boolItem.bits(),
      error:   boolItem.bits(),
      _pad:    paddingItem.bits(2),
      channel: uintItem.bits(4),
    }, { bitOrder: "lsbFirst" });

    assert.equal(serialize(statusRegister, { ready: true, error: false, channel: 5 }).toHex(), "51");
  });

  it("size-prefixes an MQTT packet body with a varint", () => {
    const mqttBody = bytesItem(leb128Codec(28));
    const body = new Uint8Array(130).fill(7);
    const encoded = serialize(mqttBody, body);
    assert.equal(encoded.subarray(0, 2).toHex(), "8201");
    assert.equal(encoded.length, 2 + 130);
  });

  it("flattens a subcommand switch into a multi-tag union", () => {
    const icmpItem = switchItem("type", uintItem(1), [
      [8, "echo", { id: uintItem(2), seq: uintItem(2) }],
      [3, "unreachable", switchItem("code", uintItem(1), [
        [1, "host", {}],
        [4, "fragmentationNeeded", { nextHopMtu: uintItem(2) }],
      ])],
    ]);

    pinEq<DeriveType<typeof icmpItem>,
      { readonly type: "echo", readonly id: number, readonly seq: number } |
      { readonly type: "unreachable", readonly code: "host" } |
      { readonly type: "unreachable", readonly code: "fragmentationNeeded",
        readonly nextHopMtu: number }>(true);

    assert.equal(
      serialize(icmpItem,
        { type: "unreachable", code: "fragmentationNeeded", nextHopMtu: 1492 }).toHex(),
      "03" + "04" + "05d4");
  });
});

// ---- Automatic discrimination teaser ----

describe("README: discrimination teaser", () => {
  it("tells the two address types apart by size alone", () => {
    const discriminator = buildDiscriminator([ipV4Item, ipV6Item]);
    assert.deepEqual([4, 16, 5].map(size => new Uint8Array(size)).map(discriminator), [0, 1, null]);
  });
});

// ---- Factories and raw literals ----

describe("README: factories and raw literals", () => {
  it("a raw literal is exactly what the factory returns", () => {
    const rawU16 = { binary: "uint", size: 2 } as const satisfies Layout;
    const factoryU16 = uintItem(2);
    pinEq<typeof rawU16, typeof factoryU16>(true);
    assert.deepEqual(rawU16, factoryU16);
  });

  //canary for the README's claim that a gratuitous satisfies degrades inference in generic
  //  code: its contextual typing widens a type-parameter-typed sub-layout to the Layout
  //  constraint (microsoft/TypeScript#52394; reproduced under TS 7.0). If the second pin
  //  ever fails, TS fixed it — update the README.
  it("a gratuitous satisfies widens a generic sub-layout to Layout", () => {
    const plain = <const L extends Layout>(l: L) =>
      ({ binary: "bytes", layout: l } as const);
    const gratuitous = <const L extends Layout>(l: L) =>
      ({ binary: "bytes", layout: l } as const satisfies Layout);
    const inner = { x: uintItem(2) };
    pinEq<ReturnType<typeof plain<typeof inner>>["layout"], typeof inner>(true);
    pinEq<ReturnType<typeof gratuitous<typeof inner>>["layout"], Layout>(true);
  });
});

// ---- fixed and custom ----

describe("README: fixed and custom", () => {
  //pins the README's verbatim source quote of the Conversion definition against the real one
  it("Conversion is exactly the quoted definition", () => {
    type Quoted<FromType = Existential, ToType = Existential> = Readonly<{
      to:   (val: FromType) => ToType,
      from: (val: ToType  ) => FromType,
    }>;
    pinEq<Conversion<number, string>, Quoted<number, string>>(true);
    pinEq<Conversion, Quoted>(true);
  });
});

// ---- (u)int ----

describe("README: (u)int", () => {
  const biasConversion = (bias: number) => ({
    to:   (encoded: number) => encoded + bias,
    from: (decoded: number) => decoded - bias,
  } as const satisfies Conversion<number, number>);

  const hexConversion = {
    to:   (encoded: bigint) => "0x" + encoded.toString(16),
    from: (decoded: string) => BigInt(decoded),
  } as const satisfies Conversion<bigint, string>;

  const numericsLayout = {
    fixedU8: uintItem(1, { fixed: 42 }),
    leI16:   intItem(2, { endianness: "little" }),
    leU64:   uintItem(8, { endianness: "little" }),
    year:    uintItem(1, { custom: biasConversion(1900) }),
    hexnum:  uintItem(9, { custom: hexConversion }),
  };

  it("derives and round-trips the numerics", () => {
    type Numerics = DeriveType<typeof numericsLayout>;
    pinEq<Numerics, {
      readonly leI16:  number,
      readonly leU64:  bigint,
      readonly year:   number,
      readonly hexnum: string,
    }>(true);

    const numerics: Numerics = { leI16: -2, leU64: 258n, year: 2026, hexnum: "0x1001" };
    const encoded = serialize(numericsLayout, numerics);
    assert.equal(encoded.toHex(),
      "2a" + "feff" + "0201000000000000" + "7e" + "000000000000001001");
    assert.deepEqual(deserialize(numericsLayout, encoded), numerics);
  });

  it("surfaces a fixed value by name or through a conversion", () => {
    const versionItem = uintItem(1, { fixed: 0, as: "legacy" });
    pinEq<DeriveType<typeof versionItem>, "legacy">(true);
    assert.equal(serialize(versionItem, "legacy").toHex(), "00");
    assert.equal(deserialize(versionItem, new Uint8Array([0])), "legacy");
    assert.throws(() => deserialize(versionItem, new Uint8Array([1])));

    //pinning an already-converted item raw-side surfaces the conversion's target type...
    const alwaysOn = { ...boolItem(), fixed: 1 } as const;
    pinEq<DeriveType<typeof alwaysOn>, boolean>(true);
    assert.equal(deserialize(alwaysOn, new Uint8Array([1])), true);
    //...pin states it surfaced-side and derives the literal
    const pinnedOn = pin(boolItem(), true);
    assert.deepEqual(pinnedOn, { binary: "uint", size: 1, fixed: 1, as: true });
    pinEq<DeriveType<typeof pinnedOn>, true>(true);
  });
});

// ---- bytes ----

describe("README: bytes", () => {
  const magic = new TextEncoder().encode("magic");
  const bytesExampleLayout = {
    raw: {
      vanilla:  bytesItem(3),
      prefixed: bytesItem(uintItem(2, { endianness: "little" })),
    },
    fixed: {
      vanilla:   bytesItem({ fixed: new Uint8Array([0, 42]) }),
      converted: bytesItem({ fixed: magic, as: "magic" }),
    },
    flex: bytesItem({ custom: utf8Conversion }),
  };

  it("derives and serializes the bytes example", () => {
    type BytesExample = DeriveType<typeof bytesExampleLayout>;
    pinEq<BytesExample, {
      readonly raw:   { readonly vanilla: RoUint8Array, readonly prefixed: RoUint8Array },
      readonly fixed: { readonly converted: "magic" },
      readonly flex:  string,
    }>(true);

    const bytesExample: BytesExample = {
      raw: { vanilla: new Uint8Array([1, 2, 3]), prefixed: new Uint8Array([5, 6]) },
      fixed: { converted: "magic" },
      flex: "utf8",
    };

    assert.equal(serialize(bytesExampleLayout, bytesExample).toHex(),
      "010203" + "0200" + "0506" + "002a" + "6d61676963" + "75746638");
  });
});

// ---- array ----

describe("README: array", () => {
  it("round-trips a string map", () => {
    const stringItem = bytesItem({ size: uintItem(1), custom: utf8Conversion });
    const entriesItem = arrayItem(arrayItem(stringItem, 2));
    pinEq<DeriveType<typeof entriesItem>, RoArray<RoPair<string, string>>>(true);

    const stringMapItem = withCustom(entriesItem, {
      to:   entries => new Map(entries),
      from: map => [...map.entries()],
    });
    pinEq<DeriveType<typeof stringMapItem>, Map<string, string>>(true);
    assert.equal(stringMapItem.binary, "array");

    const encoded = serialize(stringMapItem, new Map([["m", "milli"], ["k", "kilo"]]));
    assert.equal(encoded.toHex(), "016d" + "056d696c6c69" + "016b" + "046b696c6f");
    assert.deepEqual(deserialize(stringMapItem, encoded), new Map([["m", "milli"], ["k", "kilo"]]));
  });
});

// ---- switch ----

describe("README: switch", () => {
  it("models known statuses and catches the rest with a range variant", () => {
    const httpResponseItem = switchItem("statusCode", uintItem(2), [
      [200, { body: bytesItem() }],
      [404, {}],
      [[100, 599], { rawBody: bytesItem() }],
    ]);

    pinEq<DeriveType<typeof httpResponseItem>,
      { readonly statusCode: 200, readonly body: RoUint8Array } |
      { readonly statusCode: 404 } |
      { readonly statusCode: number, readonly rawBody: RoUint8Array }>(true);

    assert.equal(
      serialize(httpResponseItem, { statusCode: 200, body: new Uint8Array([0, 42]) }).toHex(),
      "00c8" + "002a");
    assert.deepEqual(deserialize(httpResponseItem, new Uint8Array([1, 45, 13, 37])),
      { statusCode: 301, rawBody: new Uint8Array([13, 37]) });
  });
});

// ---- packed ----

describe("README: packed", () => {
  it("packs an IPv4-style header word", () => {
    const ipv4Start = packedItem({
      version:     uintItem.bits(4),
      ihl:         uintItem.bits(4),
      dscp:        uintItem.bits(6),
      ecn:         uintItem.bits(2),
      totalLength: uintItem(2), //byte-item embedding: 16 bits
    });

    const encoded =
      serialize(ipv4Start, { version: 4, ihl: 5, dscp: 0, ecn: 0, totalLength: 40 });
    assert.equal(encoded.toHex(), "45000028");
  });

  it("replaces v1's bitsetItem with lsbFirst flags", () => {
    const flags = packedItem(
      { foo: boolItem.bits(), _b1: paddingItem.bits(1),
        bar: boolItem.bits(), _b3: paddingItem.bits(1),
        baz: boolItem.bits() },
      { bitOrder: "lsbFirst", size: 1 },
    );
    assert.equal(serialize(flags, { foo: false, bar: true, baz: true }).toHex(), "14");
  });
});

// ---- codec ----

describe("README: codec", () => {
  //"the raw type is inferred from read and unifies all three functions"
  it("codecItem infers the raw type from read", () => {
    const u16be = codecItem({
      read: (bytes, offset) => [bytes[offset]! * 256 + bytes[offset + 1]!, offset + 2],
      write: (raw, bytes, offset) => { bytes[offset] = raw >> 8; bytes[offset + 1] = raw & 0xff; return offset + 2; },
      sizeOf: () => 2,
    }, { minSize: 2, maxSize: 2 });
    pinEq<DeriveType<typeof u16be>, number>(true);
    assert.equal(serialize(u16be, 0x1234).toHex(), "1234");
  });

});

// ---- discrimination in depth ----

describe("README: discrimination", () => {
  const layouts = [
    { magic: uintItem(2, { fixed: 0 }),                    val: uintItem(1) },
    { magic: bytesItem({ fixed: new Uint8Array([1, 1]) }), val: uintItem(1) },
    uintItem(2),
  ] as const;

  it("computes static sizes", () => {
    assert.deepEqual(layouts.map(calcStaticSize), [3, 3, 2]);
  });

  it("discriminates by first byte, then size", () => {
    const discriminator = buildDiscriminator(layouts);
    assert.deepEqual([
      new Uint8Array([0, 0, 0]),    //true positive, deserializes with the first layout
      new Uint8Array([1, 1, 0]),    //true positive, deserializes with the second layout
      new Uint8Array([0, 0]),       //true positive, deserializes with the third layout
      new Uint8Array([0, 1, 0]),    //false positive, fails deserialization on the second byte
      new Uint8Array([1, 0, 0]),    //false positive, fails deserialization on the second byte
      new Uint8Array([2, 0, 0]),    //false positive, fails deserialization on size
      new Uint8Array([1, 0, 0, 0]), //true negative
      new Uint8Array([0]),          //true negative
    ].map(discriminator), [0, 1, 2, 0, 1, 2, null, null]);
  });

  it("buildDeserializer folds discriminate-and-parse into one step", () => {
    const deserializer = buildDeserializer(layouts);

    const result = deserializer(new Uint8Array([0, 0, 3]));
    pinEq<typeof result,
      | readonly [0, { readonly val: number }]
      | readonly [1, { readonly val: number }]
      | readonly [2, number]
      | null>(true);

    assert.deepEqual(result, [0, { val: 3 }]);
    assert.deepEqual(deserializer(new Uint8Array([0, 0])), [2, 0]);
    //the false positive from the discriminator example fails to parse and yields null
    assert.equal(deserializer(new Uint8Array([0, 1, 0])), null);
  });

  it("allMatches surfaces every reading instead of committing to the first", () => {
    const forensic = buildDeserializer([bytesItem(uintItem(1)), uintItem(2)], true);

    assert.deepEqual(forensic(new Uint8Array([1, 9])), [[0, new Uint8Array([9])], [1, 0x0109]]);
    assert.deepEqual(forensic(new Uint8Array([5, 1])), [[1, 0x0501]]);
  });

  it("shows the size-range blind spot", () => {
    const even = arrayItem(uintItem(2));
    const odd = { plusOne: uintItem(1), even };
    const discriminator = buildDiscriminator([even, odd], true);
    assert.deepEqual(discriminator(new Uint8Array([0, 0, 0])), [0, 1]);
  });
});

// ---- guarantees ----

describe("README: guarantees", () => {
  //"malicious length prefixes can never cause unreasonable allocations or non-terminating parses"
  it("rejects malicious length prefixes before allocating", () => {
    //a size prefix claiming ~4GB of content on a 6-byte input fails the bounds check
    const prefixed = bytesItem(uintItem(4));
    assert.throws(
      () => deserialize(prefixed, new Uint8Array([0xff, 0xff, 0xff, 0xff, 1, 2])),
      /shorter than expected/,
    );

    //a count prefix claiming ~4G elements stops at input exhaustion, not at the claim
    const counted = arrayItem(uintItem(2), uintItem(4));
    assert.throws(
      () => deserialize(counted, new Uint8Array([0xff, 0xff, 0xff, 0xff, 1, 2])),
      /shorter than expected/,
    );

    //zero-size elements are the infinite-amplification case: refused rather than spun
    const countedZeroElem = arrayItem({}, uintItem(1));
    assert.throws(() => deserialize(countedZeroElem, new Uint8Array([1])), /consumed 0 bytes/);
    const flexZeroElem = arrayItem({});
    assert.throws(() => deserialize(flexZeroElem, new Uint8Array([1])), /consumed 0 bytes/);
  });
});

// ---- sugar ----

describe("README: sugar", () => {
  it("boolItem is strict by default and carries a width", () => {
    assert.throws(() => deserialize(boolItem(), new Uint8Array([2])));
    assert.equal(deserialize(boolItem({ permissive: true }), new Uint8Array([2])), true);
    assert.equal(serialize(boolItem({ size: 4, endianness: "little" }), true).toHex(), "01000000");
  });

  it("enumItem maps names to values", () => {
    const myEnumItem = enumItem([["foo", 1], ["bar", 3]], { size: 2, endianness: "little" });
    pinEq<DeriveType<typeof myEnumItem>, "foo" | "bar">(true);
    assert.equal(serialize(myEnumItem, "bar").toHex(), "0300");
  });

  it("optionItem encodes presence with a leading byte", () => {
    const myOptionItem = optionItem(uintItem(2));
    pinEq<DeriveType<typeof myOptionItem>, number | undefined>(true);
    assert.equal(serialize(myOptionItem, undefined).toHex(), "00");
    assert.equal(serialize(myOptionItem, 42).toHex(), "01" + "002a");
  });

  it("timestampItem converts Dates and saturates", () => {
    const expiryItem = timestampItem({ saturateAs: "never" });
    assert.equal(serialize(expiryItem, new Date("2030-01-01T00:00:00Z")).toHex(), "70dbd880");
    assert.equal(serialize(expiryItem, "never").toHex(), "ffffffff");
    assert.equal(deserialize(expiryItem, new Uint8Array([0xff, 0xff, 0xff, 0xff])), "never");
  });

  it("length-prefixes a Solana vec with compact-u16", () => {
    const vecU8 = arrayItem(uintItem(1), compactU16);
    const encoded = serialize(vecU8, Array.from({ length: 130 }, () => 7));
    assert.equal(encoded.subarray(0, 2).toHex(), "8201");
    assert.equal(encoded.length, 2 + 130);
  });

  //"WebAssembly admits 0x03 and 0x83 0x00 alike for 3"
  it("permissive leb128 is WASM's u32", () => {
    const wasmU32 = leb128Codec(32, { permissive: true });
    assert.equal(deserialize(wasmU32, new Uint8Array([0x03])), 3);
    assert.equal(deserialize(wasmU32, new Uint8Array([0x83, 0x00])), 3);
    assert.throws(() => deserialize(leb128Codec(32), new Uint8Array([0x83, 0x00])), /non-minimal/);
  });

  it("round-trips an RLP integer", () => {
    assert.equal(serialize(rlpUint, 1024n).toHex(), "820400");
    assert.equal(deserialize(rlpUint, new Uint8Array([0x82, 0x04, 0x00])), 1024n);
  });

  it("utf8Conversion is a Conversion<RoUint8Array, string>", () => {
    const conversion: Conversion<RoUint8Array, string> = utf8Conversion;
    assert.equal(conversion.to(new Uint8Array([0x41])), "A");
  });

  it("brandConversion types nominal ids", () => {
    type UserId = Brand<number, "UserId">;
    const userIdItem = { ...uintItem(4), custom: brandConversion<UserId>() };
    pinEq<DeriveType<typeof userIdItem>, UserId>(true);
  });

  it("customizableBytes parameterizes a template", () => {
    const packetTemplate = <const P extends CustomizableBytes = undefined>(
      ...payload: OptionalArg<P>
    ) => ({
      srcPort: uintItem(2),
      dstPort: uintItem(2),
      payload: customizableBytes({ size: uintItem(2) }, ...payload),
    } as const);

    const rawPacket = packetTemplate();
    pinEq<DeriveType<typeof rawPacket>["payload"], RoUint8Array>(true);

    const stringPacket = packetTemplate(utf8Conversion);
    pinEq<DeriveType<typeof stringPacket>["payload"], string>(true);

    const numberArrayItem = arrayItem(uintItem(4));
    const numberPacket = packetTemplate(numberArrayItem);
    pinEq<DeriveType<typeof numberPacket>["payload"], RoArray<number>>(true);

    const setConversion = {
      to:   (encoded: RoArray<number>) => new Set<number>(encoded),
      from: (decoded: Set<number>) => [...decoded],
    } as const satisfies Conversion<RoArray<number>, Set<number>>;
    const setPacket = packetTemplate(withCustom(numberArrayItem, setConversion));
    pinEq<DeriveType<typeof setPacket>["payload"], Set<number>>(true);
    //the conversion sits on the array itself, the frame only frames
    assert.equal(setPacket.payload.layout.custom, setConversion);

    //a pinned payload, surfaced by name
    const pingPacket = packetTemplate({ fixed: new TextEncoder().encode("ping"), as: "ping" });
    pinEq<DeriveType<typeof pingPacket>["payload"], "ping">(true);
    assert.equal(
      serialize(pingPacket, { srcPort: 4242, dstPort: 80, payload: "ping" }).toHex(),
      "1092" + "0050" + "0004" + "70696e67");
  });
});

// ---- operations ----

describe("README: operations", () => {
  //"serialize(layout, data, target) writes into target and returns the number of bytes written"
  it("serializes in place into a provided buffer", () => {
    const layout = { x: uintItem(1), y: uintItem(2) };
    const data = { x: 1, y: 0x0203 };
    assert.equal(calcSize(layout, data), 3);

    const buffer = new Uint8Array(5);
    const written = serialize(layout, data, buffer.subarray(1));
    assert.equal(written, 3);
    assert.equal(buffer.toHex(), "0001020300");
  });

  it("withCustom stringifies coordinates", () => {
    const coordinatesLayout = { x: uintItem(1), y: uintItem(1) };
    const stringifiedItem = withCustom(coordinatesLayout, {
      to:   ({ x, y }) => `${x},${y}`,
      from: value => { const [x, y] = value.split(",").map(Number); return { x: x!, y: y! }; },
    });
    assert.equal(stringifiedItem.binary, "bytes");
    assert.equal(serialize(stringifiedItem, "1,2").toHex(), "0102");
  });

  it("pin states a constant by its surfaced value", () => {
    const modeItem = enumItem([["off", 0], ["on", 3]]);
    const alwaysOn = pin(modeItem, "on");
    assert.deepEqual(alwaysOn, { binary: "uint", size: 1, fixed: 3, as: "on" });
    pinEq<DeriveType<typeof alwaysOn>, "on">(true);
    assert.equal(serialize(alwaysOn, "on").toHex(), "03");
  });

  it("setEndianness flips a whole layout", () => {
    const messageLayout = {
      version:   uintItem(1),
      timestamp: uintItem(4),
      payload:   bytesItem(uintItem(2)),
    } satisfies Layout;
    const le = setEndianness(messageLayout, "little");
    assert.equal(serialize(le, { version: 1, timestamp: 0x01020304, payload: new Uint8Array() }).toHex(),
      "01" + "04030201" + "0000");
  });
});
