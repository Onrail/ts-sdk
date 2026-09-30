//Acceptance tests: constructs transcribed from the onrail onchain SDK (the design
//  oracle) plus the stretch goals - each one either impossible or painful in v1.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { inflateRawSync } from "node:zlib";
import type { RoUint8Array } from "@onrail-xyz/utils";
import type { Layout, Item, Struct, DeriveType, Conversion } from "../src/index.js";
import { serialize, deserialize,
         calcStaticSize, withCustom, unwrapSingleton, uintItem,
         bytesItem, arrayItem, packedItem, switchItem, boolItem,
         paddingItem, enumItem, rlpBytes, rlpUint, rlpListHeader } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

const roundtrip = <const L extends Layout>(layout: L, data: any, expectedHex?: string) => {
  const encoded = serialize(layout, data);
  if (expectedHex !== undefined)
    assert.equal(encoded.toHex(), expectedHex);

  assert.deepEqual(deserialize(layout, encoded), data);
  return encoded;
};

// ---- shared EVM-ish items ----

const wordSize = 32;

const addressConversion = {
  to:   (raw: RoUint8Array) => `0x${raw.toHex()}`,
  from: (addr: string) => Uint8Array.fromHex(addr.slice(2)),
} as const satisfies Conversion<RoUint8Array, string>;

const addressItem = bytesItem({ size: 20, custom: addressConversion });

describe("pausedAndBps (vault service slot bit packing)", () => {
  //v1 required hand-written mask arithmetic in a custom conversion; the bps amount
  //  conversion here stands in for amountItem(2, Percentage, "bps")
  const bpsConversion = {
    to:   (raw: number) => `${raw}bps`,
    from: (val: string) => Number.parseInt(val),
  } as const satisfies Conversion<number, string>;

  const pausedAndBpsItem = packedItem({
    serviceFee: uintItem.bits(14, { custom: bpsConversion }),
    _gap:       paddingItem.bits(1),
    isPaused:   boolItem.bits(),
  });

  it("derives the unpacked type and roundtrips without manual masking", () => {
    pinEq<
      DeriveType<typeof pausedAndBpsItem>,
      { readonly serviceFee: string, readonly isPaused: boolean }
    >(true);

    roundtrip(
      pausedAndBpsItem,
      { serviceFee: "300bps", isPaused: true },
      ((300 << 2) | 1).toString(16).padStart(4, "0"),
    );
    assert.equal(calcStaticSize(pausedAndBpsItem), 2);
  });
});

describe("orderItem (16 packed bucket indexes)", () => {
  const orderItem = packedItem({
    order: arrayItem(uintItem.bits(4), 16),
  });

  it("roundtrips a full permutation in a u64", () => {
    const order = [3, 1, 4, 15, 9, 2, 6, 5, 8, 7, 0, 10, 11, 12, 13, 14];
    const encoded = roundtrip(orderItem, { order });
    assert.equal(encoded.length, 8);
  });
});

describe("paddedSlotLayout via unwrapSingleton (v1-impossible)", () => {
  //v1's evm package wanted exactly this and couldn't: "tsc chokes hard on assigning the
  //  spread". Two-level generic wrapping, zero incantations.
  const paddedSlot = <const I extends Item>(item: I) => {
    const size = calcStaticSize(item);
    if (size === null || size > wordSize)
      throw new Error("item must have a static size of at most one word");

    return unwrapSingleton({ _padding: paddingItem(wordSize - size), value: item });
  };

  it("derives the unwrapped value type", () => {
    const slotAddress = paddedSlot(addressItem);
    pinEq<DeriveType<typeof slotAddress>, string>(true);

    const addr = `0x${"11".repeat(20)}`;
    roundtrip(slotAddress, addr, "00".repeat(12) + "11".repeat(20));
  });

  it("composes into storage structs", () => {
    const authorityLayout = {
      admin:        paddedSlot(addressItem),
      pendingAdmin: paddedSlot(addressItem),
    } as const;
    assert.equal(calcStaticSize(authorityLayout), 2 * wordSize);
  });
});

describe("execCmdItem-style command table", () => {
  const trancheItem = enumItem([["junior", 0], ["senior", 1]]);
  const usdcItem = uintItem(8);

  const trancheSwitch = <const J extends Struct, const S extends Struct>(junior: J, senior: S) =>
    switchItem("tranche", uintItem(1), [[0, "junior", junior], [1, "senior", senior]]);

  const tokensLayout = { tokens: uintItem(8) } as const;
  const acceptLayout = { owner: addressItem, usdc: usdcItem } as const;

  const execCmdItem = switchItem("cmd", uintItem(1), [
    [0x01, "requestDeposit",    { tranche: trancheItem, usdc: usdcItem }],
    [0x02, "requestRedemption", { on: trancheSwitch(tokensLayout, tokensLayout) }],
    [0x06, "accrue",            {}],
    [0x20, "settle",            { accepts: arrayItem(acceptLayout, uintItem(2)) }],
    [0x30, "pause",             {}],
    [0x40, "setOperator",       { operator: addressItem }],
    [0x50, "issue",             { on: trancheSwitch(
                                    { owner: addressItem, ...tokensLayout },
                                    { owner: addressItem, ...tokensLayout }) }],
  ]);

  type ExecCommand = DeriveType<typeof execCmdItem>;

  it("derives the full tagged union", () => {
    pinEq<
      Extract<ExecCommand, { cmd: "requestDeposit" }>,
      { readonly cmd: "requestDeposit", readonly tranche: "junior" | "senior",
        readonly usdc: bigint }
    >(true);
    pinEq<Extract<ExecCommand, { cmd: "pause" }>, { readonly cmd: "pause" }>(true);
    pinEq<
      Extract<ExecCommand, { cmd: "requestRedemption" }>["on"],
      | { readonly tranche: "junior", readonly tokens: bigint }
      | { readonly tranche: "senior", readonly tokens: bigint }
    >(true);
  });

  it("roundtrips representative commands", () => {
    const addr = `0x${"22".repeat(20)}`;
    const commands: ExecCommand[] = [
      { cmd: "requestDeposit", tranche: "senior", usdc: 1000n },
      { cmd: "requestRedemption", on: { tranche: "junior", tokens: 5n } },
      { cmd: "accrue" },
      { cmd: "settle", accepts: [{ owner: addr, usdc: 7n }, { owner: addr, usdc: 8n }] },
      { cmd: "pause" },
      { cmd: "setOperator", operator: addr },
      { cmd: "issue", on: { tranche: "senior", owner: addr, tokens: 9n } },
    ];
    for (const command of commands)
      roundtrip(execCmdItem, command);

    assert.equal(
      serialize(execCmdItem, { cmd: "requestDeposit", tranche: "senior", usdc: 0x1234n }).toHex(),
      "01" + "01" + "0000000000001234",
    );
  });
});

describe("abiEncodedBytesItem (single dynamic argument)", () => {
  const lengthSize = 4;
  const abiEncodedBytes = <const L extends Layout>(layout: L, position = 0) => ({
    binary: "bytes",
    layout: {
      offset: { ...uintItem(wordSize), fixed: BigInt((position + 1) * wordSize) },
      lengthPadding: paddingItem(wordSize - lengthSize),
      item: { binary: "bytes", size: uintItem(lengthSize), layout },
      postPadding: bytesItem(),
    },
    custom: {
      to: (raw: { item: DeriveType<L>, postPadding: RoUint8Array }) => raw.item,
      from: (item: DeriveType<L>) => {
        const dataSize = serialize(layout, item).length;
        return {
          item,
          postPadding: new Uint8Array((wordSize - dataSize % wordSize) % wordSize),
        };
      },
    },
  } as const);

  it("matches abi.encode(bytes) framing", () => {
    const payload = { message: bytesItem() } as const;
    const item = abiEncodedBytes(payload);
    const data = { message: new TextEncoder().encode("hello") };
    roundtrip(item, data,
      "00".repeat(31) + "20" +              //offset word: 32
      "00".repeat(31) + "05" +              //length word: 5
      "68656c6c6f" + "00".repeat(27),       //payload + postPadding
    );
  });
});

describe("RLP via shipped codecs (stretch)", () => {
  it("roundtrips RLP integers canonically", () => {
    roundtrip(rlpUint, 0n, "80");
    roundtrip(rlpUint, 1n, "01");
    roundtrip(rlpUint, 127n, "7f");
    roundtrip(rlpUint, 128n, "8180");
    roundtrip(rlpUint, 0x0102n, "820102");
    assert.throws(() => deserialize(rlpUint, Uint8Array.fromHex("820001")), /leading zero/);
    assert.throws(() => deserialize(rlpBytes, Uint8Array.fromHex("8105")), /self-encode/);
  });

  it("rejects 0x00 as an integer, where 0x80 is the canonical zero", () => {
    //0x00 is a well-formed RLP *string* - the single byte 0 self-encoding - but a leading zero
    //  as an integer, so both used to decode to 0n while only 0x80 was ever emitted
    assert.deepEqual(deserialize(rlpBytes, Uint8Array.fromHex("00")), new Uint8Array([0]));
    assert.throws(() => deserialize(rlpUint, Uint8Array.fromHex("00")), /leading zero/);
  });

  it("roundtrips a legacy Ethereum transaction", () => {
    const legacyTxLayout = {
      binary: "bytes",
      size: rlpListHeader,
      layout: {
        nonce:    rlpUint,
        gasPrice: rlpUint,
        gasLimit: rlpUint,
        to:       { ...rlpBytes, custom: addressConversion },
        value:    rlpUint,
        data:     rlpBytes,
        v:        rlpUint,
        r:        rlpUint,
        s:        rlpUint,
      },
    } as const;

    const tx = {
      nonce:    0n,
      gasPrice: 1n,
      gasLimit: 2n,
      to:       `0x${"11".repeat(20)}`,
      value:    0n,
      data:     new Uint8Array(0),
      v:        27n,
      r:        1n,
      s:        2n,
    };

    //hand-derived: payload = 80 01 02 94<20*11> 80 80 1b 01 02 (29 bytes) -> header 0xdd
    roundtrip(legacyTxLayout, tx, "dd" + "800102" + "94" + "11".repeat(20) + "8080" + "1b0102");
  });

  it("uses the long list form past 55 bytes", () => {
    const layout = { binary: "bytes", size: rlpListHeader, layout: { data: rlpBytes } } as const;
    const data = { data: new Uint8Array(60).fill(0xaa) };
    //string: b8 3c <60 bytes>; list: f8 3e <62 bytes>
    roundtrip(layout, data, "f83e" + "b83c" + "aa".repeat(60));
  });
});

describe("Bitcoin CompactSize via ranged switch (stretch)", () => {
  const u16le = uintItem(2, { endianness: "little" });
  const u32le = uintItem(4, { endianness: "little" });
  const u64le = uintItem(8, { endianness: "little" });

  const compactSizeSwitch = switchItem("form", uintItem(1), [
    [[0x00, 0xfc], {}],
    [0xfd, "u16", { value: u16le }],
    [0xfe, "u32", { value: u32le }],
    [0xff, "u64", { value: u64le }],
  ]);

  //the conversion sits on the switch itself - no wrapper node
  const btcCompactSize = withCustom(compactSizeSwitch, {
    to:   obj => typeof obj.form === "number" ? obj.form : Number(obj.value),
    from: n =>
      n <= 0xfc ? { form: n } as const
      : n <= 0xffff ? { form: "u16", value: n } as const
      : n <= 0xffffffff ? { form: "u32", value: n } as const
      : { form: "u64", value: BigInt(n) } as const,
  });

  it("roundtrips all four forms", () => {
    assert.equal(btcCompactSize.binary, "switch");
    pinEq<DeriveType<typeof btcCompactSize>, number>(true);
    roundtrip(btcCompactSize, 0, "00");
    roundtrip(btcCompactSize, 0xfc, "fc");
    roundtrip(btcCompactSize, 0xfd, "fdfd00");
    roundtrip(btcCompactSize, 70000, "fe70110100");
    roundtrip(btcCompactSize, 2 ** 40, "ff0000000000010000");
  });

  it("serves as an array count prefix", () => {
    const vec = arrayItem(uintItem(1), btcCompactSize);
    roundtrip(vec, [7, 8, 9], "03070809");
  });
});

describe("gzip member (flex payload with a fixed-width trailer)", () => {
  //the wire-exact tail-reservation specimen: the deflate stream is flex, followed by the
  //  fixed-width CRC32 + ISIZE member trailer
  const gzipMemberLayout = {
    magic:   bytesItem({ fixed: new Uint8Array([0x1f, 0x8b]) }),
    method:  uintItem(1, { fixed: 8 }),
    flags:   uintItem(1, { fixed: 0 }),
    mtime:   uintItem(4, { endianness: "little" }),
    xfl:     uintItem(1),
    os:      uintItem(1),
    deflate: bytesItem(),
    crc32:   uintItem(4, { endianness: "little" }),
    isize:   uintItem(4, { endianness: "little" }),
  };

  //zlib.gzipSync("hello world", { mtime: 0 }), captured
  const wire = "1f8b0800000000000003cb48cdc9c95728cf2fca49010085114a0d0b000000";

  it("roundtrips the real thing", () => {
    const member = deserialize(gzipMemberLayout, Uint8Array.fromHex(wire));
    assert.equal(member.isize, "hello world".length);
    assert.equal(member.crc32, 0x0d4a1185);
    assert.equal(inflateRawSync(member.deflate as Uint8Array).toString(), "hello world");
    assert.equal(serialize(gzipMemberLayout, member).toHex(), wire);
  });
});
