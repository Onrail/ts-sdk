//Type-fixture suite: compile-time assertions of exact derived types.
//  These fixtures ARE the requirement - inferrability under spread, override, and
//  two-level generic wrapping, with zero consumer-side incantations.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { RoUint8Array, RoArray, RoPair, Brand } from "@onrail-xyz/utils";
import type { Layout, Item, Struct, DeriveType,
              Conversion, CodecItem, SizedNumItem, NumSizeToPrimitive } from "../src/index.js";
import { serialize, deserialize, brandConversion } from "../src/index.js";
import { pinEq } from "./typeAssert.js";

describe("DeriveType fixtures", () => {
  it("compiles", () => { assert.ok(true); });
});

// ---- primitives ----

const u8 = { binary: "uint", size: 1 } as const;
const u16 = { binary: "uint", size: 2 } as const;
const u64 = { binary: "uint", size: 8 } as const;
const i32 = { binary: "int", size: 4 } as const;

pinEq<DeriveType<typeof u8>, number>(true);
pinEq<DeriveType<typeof u64>, bigint>(true);
pinEq<DeriveType<typeof i32>, number>(true);

//48 bits is the last whole-byte number width; 56 bits crosses numberMaxBits
pinEq<DeriveType<{ binary: "uint", size: 6 }>, number>(true);
pinEq<DeriveType<{ binary: "uint", size: 7 }>, bigint>(true);
pinEq<DeriveType<{ binary: "uint", bits: 14 }>, number>(true);
pinEq<DeriveType<{ binary: "uint", bits: 53 }>, number>(true);
pinEq<DeriveType<{ binary: "uint", bits: 54 }>, bigint>(true);

// ---- fixed / custom ----

//fixed without custom: omitted (undefined standalone)
pinEq<DeriveType<{ binary: "uint", size: 1, fixed: 3 }>, undefined>(true);

//custom: the conversion's target type
const boolConversion = {
  to: (raw: number) => raw !== 0,
  from: (val: boolean) => val ? 1 : 0,
} as const satisfies Conversion<number, boolean>;
const boolItem = { ...u8, custom: boolConversion } as const;
pinEq<DeriveType<typeof boolItem>, boolean>(true);

//fixed composed with custom: surfaced constant with literal precision
const legacyItem = {
  ...u8,
  fixed: 0,
  custom: { to: () => "legacy" as const, from: () => 0 },
} as const;
pinEq<DeriveType<typeof legacyItem>, "legacy">(true);

//fixed with as: the stated surfaced value, literal for free - the item half of a switch
//  variant's { id, as } pair
pinEq<DeriveType<{ binary: "uint", size: 1, fixed: 0, as: "legacy" }>, "legacy">(true);
pinEq<DeriveType<{ binary: "bytes", fixed: Uint8Array, as: null }>, null>(true);
//as without fixed is ignored
pinEq<DeriveType<{ binary: "uint", size: 1, as: "stray" }>, number>(true);

//pinning an already-converted item surfaces the conversion's whole target type
const pinnedBool = { ...boolItem, fixed: 1 } as const;
pinEq<DeriveType<typeof pinnedBool>, boolean>(true);

//spread-override is the primary composition idiom and must preserve narrow types
const hashItem = { binary: "bytes", size: 32 } as const;
const hexConversion = {
  to: (raw: RoUint8Array) => `0x${raw.toString()}`,
  from: (_val: string) => new Uint8Array(0),
} as const;
const hexHashItem = { ...hashItem, custom: hexConversion } as const;
pinEq<DeriveType<typeof hashItem>, RoUint8Array>(true);
pinEq<DeriveType<typeof hexHashItem>, string>(true);

// ---- structs ----

const entry = { key: u8, value: u16 } as const;
pinEq<DeriveType<typeof entry>, { readonly key: number, readonly value: number }>(true);

//fixed-only fields drop out of the derived struct
const versioned = { version: { ...u8, fixed: 1 }, payload: u16 } as const;
pinEq<DeriveType<typeof versioned>, { readonly payload: number }>(true);

//inline struct nesting derives nested objects
const nested = { header: entry, tail: u8 } as const;
pinEq<
  DeriveType<typeof nested>,
  { readonly header: { readonly key: number, readonly value: number }, readonly tail: number }
>(true);

//integer-like keys derive a branded error type instead of silently reordering
type NumericKeyError = DeriveType<{ "1": typeof u8 }>;
pinEq<NumericKeyError extends { "!error": string } ? true : false, true>(true);

// ---- bytes ----

pinEq<DeriveType<{ binary: "bytes", size: 4 }>, RoUint8Array>(true);
pinEq<DeriveType<{ binary: "bytes", size: typeof u16 }>, RoUint8Array>(true);
pinEq<
  DeriveType<{ binary: "bytes", size: typeof u16, layout: typeof entry }>,
  { readonly key: number, readonly value: number }
>(true);

// ---- arrays ----

pinEq<
  DeriveType<{ binary: "array", length: typeof u8, layout: typeof u16 }>,
  RoArray<number>
>(true);
pinEq<
  DeriveType<{ binary: "array", length: 3, layout: typeof u8 }>,
  readonly [number, number, number]
>(true);
pinEq<DeriveType<{ binary: "array", layout: typeof u8 }>, RoArray<number>>(true);

//arrays carry the common trio like every other kind
const rgb = { binary: "array", length: 3, layout: u8 } as const;
const hexRgb = {
  ...rgb,
  custom: { to: (_c: RoArray<number>) => "#000000", from: (_s: string) => [0, 0, 0] },
} as const;
pinEq<DeriveType<typeof hexRgb>, string>(true);
pinEq<DeriveType<{ binary: "array", layout: typeof u8, fixed: [0, 0, 0] }>, undefined>(true);
pinEq<DeriveType<{ binary: "array", layout: typeof u8, fixed: [0, 0, 0], as: "black" }>, "black">(true);

// ---- switch ----

const commandItem = {
  binary: "switch",
  id: u8,
  tag: "cmd",
  variants: [
    { id: 1, as: "ping", layout: {} },
    { id: 2, as: "pong", layout: { nonce: u16 } },
    { id: [0x80, 0xff], layout: { payload: { binary: "bytes", size: 1 } } },
  ],
} as const;

type Command = DeriveType<typeof commandItem>;
pinEq<
  Command,
  | { readonly cmd: "ping" }
  | { readonly cmd: "pong", readonly nonce: number }
  | { readonly cmd: number, readonly payload: RoUint8Array }
>(true);

//switches carry the common trio too
const pingOnly = { ...commandItem, fixed: { cmd: "ping" } } as const;
pinEq<DeriveType<typeof pingOnly>, undefined>(true);
pinEq<DeriveType<{ readonly as: "ping!" } & typeof pingOnly>, "ping!">(true);
const nonceOnly = {
  ...commandItem,
  custom: { to: (_c: Command) => 0, from: (n: number) => ({ cmd: "pong", nonce: n } as const) },
} as const;
pinEq<DeriveType<typeof nonceOnly>, number>(true);

//tag value defaults to the id literal
const plainSwitch = {
  binary: "switch",
  tag: "kind",
  id: u8,
  variants: [{ id: 7, layout: {} }, { id: 9, layout: { x: u8 } }],
} as const;
pinEq<
  DeriveType<typeof plainSwitch>,
  { readonly kind: 7 } | { readonly kind: 9, readonly x: number }
>(true);

//a switch body in variant position merges its union into the tag row (subcommand pattern)
const sideSwitch = {
  binary: "switch",
  id: u8,
  tag: "side",
  variants: [
    { id: 0, as: "redemption", layout: { tokens: u16 } },
    { id: 1, as: "deposit",    layout: { usdc: u16 } },
  ],
} as const;

const subcommand = {
  binary: "switch",
  id: u8,
  tag: "cmd",
  variants: [
    { id: 1, as: "cancel", layout: sideSwitch },
    { id: 2, as: "noop",   layout: {} },
  ],
} as const;

pinEq<
  DeriveType<typeof subcommand>,
  | { readonly cmd: "cancel", readonly side: "redemption", readonly tokens: number }
  | { readonly cmd: "cancel", readonly side: "deposit",    readonly usdc: number }
  | { readonly cmd: "noop" }
>(true);

//a converted switch derives one value, not a union to merge: in variant position it is an error
const convertedBody = {
  ...subcommand,
  variants: [{ id: 1, as: "cancel", layout: { ...sideSwitch, custom: boolConversion } }],
} as const;
pinEq<DeriveType<typeof convertedBody> extends { "!error": string } ? true : false, true>(true);

//generic factories may parameterize a variant-position switch body (the trancheSwitch shape)
const trancheSwitch = <const J extends Struct, const S extends Struct>(junior: J, senior: S) => ({
  binary: "switch",
  id: u8,
  tag: "tranche",
  variants: [
    { id: 0, as: "junior", layout: junior },
    { id: 1, as: "senior", layout: senior },
  ],
} as const);

const retireCommand = {
  binary: "switch",
  id: u8,
  tag: "cmd",
  variants: [
    { id: 3, as: "retire", layout: trancheSwitch({ jTokens: u8 }, { sTokens: u16 }) },
  ],
} as const;

pinEq<
  DeriveType<typeof retireCommand>,
  | { readonly cmd: "retire", readonly tranche: "junior", readonly jTokens: number }
  | { readonly cmd: "retire", readonly tranche: "senior", readonly sTokens: number }
>(true);

// ---- packed ----

const pausedAndBps = {
  binary: "packed",
  layout: {
    serviceFee: { binary: "uint", bits: 14 },
    _pad:       { binary: "uint", bits: 1, fixed: 0 },
    isPaused:   { binary: "uint", bits: 1, custom: boolConversion },
  },
} as const;
pinEq<
  DeriveType<typeof pausedAndBps>,
  { readonly serviceFee: number, readonly isPaused: boolean }
>(true);

// ---- codec ----

declare const compactU16: CodecItem<number>;
pinEq<DeriveType<typeof compactU16>, number>(true);

// ---- two-level generic wrapping ----
//a consumer factory generic over a brand parameter, wrapping a generic package-level
//  factory, wrapping a base item - exact types, zero incantations

//level 1: a generic item factory
const sizedUint = <S extends number>(size: S) =>
  ({ binary: "uint", size } as const);

//level 2: a consumer factory wrapping level 1 with a brand conversion
type Id = Brand<bigint, "Id">;
type RtlId = Brand<Id, "Rtl">;
const idItem = <B extends Id>() =>
  ({ ...sizedUint(16), custom: brandConversion<B>() } as const);

const rtlIdItem = idItem<RtlId>();
pinEq<DeriveType<typeof rtlIdItem>, RtlId>(true);

//level 3: embedding the wrapped factory result in a struct-building factory
const withRtlId = <const L extends Layout>(layout: L) =>
  ({ rtlId: rtlIdItem, rest: layout } as const);

const wrapped = withRtlId(entry);
pinEq<
  DeriveType<typeof wrapped>,
  { readonly rtlId: RtlId, readonly rest: { readonly key: number, readonly value: number } }
>(true);

//generic factories parameterized over a payload layout stay exact
const lengthSized = <const L extends Layout>(layout: L) =>
  ({ binary: "bytes", size: u16, layout } as const);

pinEq<DeriveType<ReturnType<typeof lengthSized<typeof entry>>>,
  { readonly key: number, readonly value: number }>(true);

// ---- ordered-authoring escape hatch ----
//TS object types carry no key order, so positional types cannot be derived FROM a record
//  layout (the reason toTuple/DeriveTuple were dropped). Order flows the other way: author
//  the struct as a tuple of [name, item] entries, project the record layout off it, and
//  keep the tuple as the source for any positional type derivation.

import { fromEntries } from "@onrail-xyz/utils";

const entryFields = [["key", u8], ["value", u16]] as const;
const entryFromTuple = fromEntries(entryFields);

//the projected record layout is interchangeable with the hand-written one
const _projected: typeof entry = entryFromTuple;
const _handWritten: typeof entryFromTuple = entry;
pinEq<
  DeriveType<typeof entryFromTuple>,
  { readonly key: number, readonly value: number }
>(true);

//and the tuple retains what the record cannot: positional types, in declaration order
type FieldParams<F> = { readonly [K in keyof F]:
  F[K] extends RoPair<string, infer I extends Item> ? DeriveType<I> : never };
pinEq<FieldParams<typeof entryFields>, readonly [number, number]>(true);

// ---- items compose with satisfies (authoring pattern) ----

const _satisfiesChecks = [
  u8 satisfies Item,
  entry satisfies Layout,
  commandItem satisfies Item,
  pausedAndBps satisfies Item,
] as const;

// ---- runtime spot-check that the fixture layouts actually work ----

describe("fixture layouts roundtrip", () => {
  it("wrapped generic layout", () => {
    const data = { rtlId: 5n as RtlId, rest: { key: 1, value: 2 } } as const;
    assert.deepEqual(deserialize(wrapped, serialize(wrapped, data)), data);
  });

  it("switch union", () => {
    const data: Command = { cmd: "pong", nonce: 7 };
    assert.deepEqual(deserialize(commandItem, serialize(commandItem, data)), data);
  });
});

//Canary for DeclarationEmit.md's "remaining hard case": a precise conversion intersected with
//  the numeric item's admitted `Conversion<number> | Conversion<bigint>` is a legal narrowing of
//  the inherited `custom`, and DeriveType then infers `never` for it - the Existential (`any`)
//  surfaced parameter of the admitted arms contaminates the `infer To`. Should a compiler
//  change make this derive `string`, the essay's account needs revisiting
type NumConversion = Conversion<number> | Conversion<bigint>;
interface IntersectedConversionItem<S extends number, To> extends SizedNumItem<"uint"> {
  readonly size: S;
  readonly custom: Conversion<NumSizeToPrimitive<S>, To> & NumConversion;
}
pinEq<IntersectedConversionItem<4, string> extends Item ? true : false, true>(true);
pinEq<DeriveType<IntersectedConversionItem<4, string>>, never>(true);
pinEq<DeriveType<IntersectedConversionItem<8, string>>, never>(true);
