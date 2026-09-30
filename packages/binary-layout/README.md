# @onrail-xyz/binary-layout

[![npm version](https://img.shields.io/npm/v/@onrail-xyz/binary-layout.svg)](https://www.npmjs.com/package/@onrail-xyz/binary-layout)

This library implements a TypeScript-native, declarative DSL for binary data serialization/deserialization that supports strong typing, bit-packing, and efficient, automatic discrimination of data formats.

A must-have for anyone unfortunate enough to work with binary data in TypeScript.

## Highlights

* **Lightweight**: near-zero dependency (only [@onrail-xyz/utils](https://github.com/Onrail/ts-sdk/tree/main/packages/utils))
* **Pure**: just TypeScript, no code generation or meta-compilation
* **Declarative**: one spec yields types, (de)serialization, and automatic discrimination
* **Composable**: nested, repeated, branching, and bit-packed structures
* **Strict**: deserialization rejects malformed and non-canonical encodings — decoding is injective, round-trips are faithful, every escape explicit
* **Extensible**: escape-hatch codecs for encodings that aren't layout-shaped (varints, RLP, ...)
* **Modern**: strong, customizable, readonly types and `Uint8Array`-based ([no more `Buffer`](https://sindresorhus.com/blog/goodbye-nodejs-buffer))
* **Efficient**: minimizes memory allocations/copies

## In a Nutshell

Everything ships from the package root, so the examples throughout omit their imports:

```typescript
import { type DeriveType, serialize, deserialize, uintItem, bytesItem, arrayItem, utf8Conversion } from "@onrail-xyz/binary-layout";
```

The very basics:

```typescript
const encoded = serialize(uintItem(2), 42);
//=> new Uint8Array([0, 42])

const decoded = deserialize(uintItem(8), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 42]));
//=> 42n //bigint - auto-inferred from the size
```

Deriving types:

```typescript
const dnsEntryLayout = {
  domain: bytesItem({ size: uintItem(1), custom: utf8Conversion }),
  ip:     arrayItem(uintItem(1), 4),
};
type DnsEntry = DeriveType<typeof dnsEntryLayout>;
//=> { domain: string; ip: [number, number, number, number] }

const entry = {
  domain: "localhost",
  ip:     [127, 0, 0, 1],
} as const satisfies DnsEntry;

const encoded = serialize(dnsEntryLayout, entry);
//=> new Uint8Array([9, 108, 111, 99, 97, 108, 104, 111, 115, 116, 127, 0, 0, 1])
//                   ╿  └─────────────────┬─────────────────────┘  └─────┬────┘
//             domain length         domain (utf8)                       ip

const decoded = deserialize(dnsEntryLayout, encoded);
//=> equal to entry as DnsEntry
```

In short, a layout is the single, declarative source of truth; the type, the serializer, and the deserializer are all derived from it.

## Showcase

Constants, enums, branching, length prefixes, conversions — enough to express the SOCKS5 connection request ([RFC 1928](https://www.rfc-editor.org/rfc/rfc1928.html#section-4)):

```typescript
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

type IpV4 = DeriveType<typeof ipV4Item>;
//=> [number, number, number, number]
type IpV6 = DeriveType<typeof ipV6Item>;
//=> [number, number, number, number, number, number, number, number]

type Socks5Request = DeriveType<typeof socks5RequestLayout>;
//=> { command: "connect" | "bind" | "udpAssociate";
//     address: | { type: "IPv4";   ip:   IpV4   }
//              | { type: "domain"; name: string }
//              | { type: "IPv6";   ip:   IpV6   };
//     port:    number;
//   }
//version and reserved are constants and therefore omitted from the derived type

serialize(socks5RequestLayout, {
  command: "connect",
  address: { type: "domain", name: "example.com" },
  port:    443,
});
//=> new Uint8Array([5, 1, 0, 3, 11, 101, 120, 97, 109, 112, 108, 101, 46, 99, 111, 109, 1, 187])
//                   ╿  ╿  ╿  ╿  ╿   └───────────────────────┬────────────────────────┘  └─┬──┘
//                   │  │  │  │  └ name length     "example.com" (utf8)                   port
//                   │  │  │  └ type: domain
//                   │  │  └ reserved
//                   │  └ command: connect
//                   └ version

deserialize(socks5RequestLayout, new Uint8Array([5, 3, 0, 1, 127, 0, 0, 1, 0, 53]));
//=> { command: "udpAssociate", address: { type: "IPv4", ip: [127, 0, 0, 1] }, port: 53 }
```

And there's more where that came from — three one-bite teasers, each treated in depth later: [*packed*](#packed) bit fields, [varint](#varints) size prefixes, and subcommand-flattening [*switches*](#switch). The wire formats they borrow are [WebAssembly](https://webassembly.github.io/spec/core/binary/modules.html#sections)'s section sizes and [ICMP](https://www.rfc-editor.org/rfc/rfc792.html)'s type/code dispatch — the latter ICMP-flavored rather than wire-exact, since the real header's checksum is a [non-local value](#limitations):

```typescript
//bit-packing, in the layout language all the way down to single bits:
const statusRegister = packedItem({
  ready:   boolItem.bits(),
  error:   boolItem.bits(),
  _pad:    paddingItem.bits(2),
  channel: uintItem.bits(4),
}, { bitOrder: "lsbFirst" });
serialize(statusRegister, { ready: true, error: false, channel: 5 });
//=> new Uint8Array([0x51])

//varint-sized payloads, because size prefixes are just items
//  (permissive, because wasm admits non-minimal encodings):
const wasmSection = {
  id:       uintItem(1),
  contents: bytesItem(leb128Codec(32, { permissive: true })),
};

//subcommand switches flatten into a single multi-tag discriminated union:
const icmpItem = switchItem("type", uintItem(1), [
  [8, "echo", { id: uintItem(2), seq: uintItem(2) }],
  [3, "unreachable", switchItem("code", uintItem(1), [
    [1, "host", {}],
    [4, "fragmentationNeeded", { nextHopMtu: uintItem(2) }],
  ])],
]);
type Icmp = DeriveType<typeof icmpItem>;
//=> | { type: "echo"; id: number; seq: number }
//   | { type: "unreachable"; code: "host" }
//   | { type: "unreachable"; code: "fragmentationNeeded"; nextHopMtu: number }
```

And since layouts are plain, analyzable data, whole sets of them can be [discriminated automatically](#automatic-discrimination): handed an unidentified chunk of bytes, a generated discriminator narrows down which layouts of the set it could possibly be — e.g. `buildDiscriminator([ipV4Item, ipV6Item])` tells the two address types apart by size alone.

## Install

```bash
npm install @onrail-xyz/binary-layout @onrail-xyz/utils
```

Node and TypeScript floors are [SDK-wide](https://github.com/Onrail/ts-sdk#requirements), as is the peer-dependency policy for internal cross-references — hence the second package above. binary-layout itself needs nothing beyond standard globals (`Uint8Array`, `TextEncoder`/`TextDecoder`) — browsers, workers, and Node alike.

That's the tour. The rest is the manual — one front-to-back read pays off, but it's built for jumping:

* [Fundamentals](#fundamentals) — layouts, items, vocabulary, factories, `DeriveType`, `fixed`/`as`/`custom`, prefix items, discrimination
* [Item Kinds in Depth](#item-kinds-in-depth) — [*(u)int*](#uint) · [*bytes*](#bytes) · [*array*](#array) · [*switch*](#switch) · [*packed*](#packed) · [*codec*](#codec)
* [Engine Functions](#engine-functions) — `serialize`, `deserialize`, sizing
* [More on Automatic Discrimination](#more-on-automatic-discrimination) — discriminators, one-step deserialization, vs *switch*, limitations
* [Guarantees & Strictness](#guarantees--strictness) — the trust boundary, canonicality, undefined behavior
* [Additional Items & Sugar](#additional-items--sugar) — bool, padding, enum, option, timestamp, varints, RLP, ...
* [Operations](#operations) — `withCustom`, `pin`, `spreadLayout`, `unwrapSingleton`, `setEndianness`, tree predicates
* [Limitations](#limitations)
* [Future Direction](#future-direction) — spans, `checksummed`, recorded non-goals

## Fundamentals

### Layouts: Structs and Items

A layout is either a single item or a struct, and both nest — layouts contain layouts through either shape:

```typescript
const point = { x: uintItem(1), y: uintItem(1) }; //a struct of two items
const path  = arrayItem(point);                   //an item that contains that struct
```

A struct is a plain record whose keys are field names and whose values are layouts. Its **key order is wire order**.

> Integer-like keys are banned — they are the one case where JavaScript reorders keys. The type level rejects them; in a dynamically built struct they are [undefined behavior](#vocabulary).

An item is a plain record too, but its properties configure an encoding rather than enumerating content. Where a struct's keys are chosen freely, an item's are dictated by its kind: `binary` names one of a closed set, and that choice determines which further properties the item may carry.

Written out in full, with no factory calls, `point` and `path` are just this:

```typescript
const point = { x: { binary: "uint", size: 1 },
                y: { binary: "uint", size: 1 } } as const; //not even a `binary` property ⇒ a struct
const path  = { binary: "array", layout: point } as const; //`binary` holds a kind string literal ⇒ an item
```

<details><summary>Why the kind lives under <code>binary</code></summary>

Every natural alternative collides: `type` is very generic and invites confusion with the derived TypeScript type, `kind` is already occupied by the neighboring [amount package](https://github.com/Onrail/ts-sdk/tree/main/packages/amount), `format` has strong string connotations, and `wire` is transport-flavored when layouts also describe disk and storage formats. Meanwhile TypeScript narrows tagged unions natively on a shared property, and the values are literal answers to "what does the binary hold?" — hence `binary`.

</details>

There are six kinds:

1. [*(u)int*](#uint): numeric value (signed or unsigned), sized in bytes — or in single bits inside *packed* layouts.
2. [*bytes*](#bytes): raw bytes or a framed sub-layout; sized statically, by a wire-encoded prefix, or by remainder (flex).
3. [*array*](#array): repeats a layout; static length, wire-encoded count prefix, or flex.
4. [*switch*](#switch): branches between variant layouts on a leading, wire-encoded id — comparable to Rust enums; derives a discriminated union.
5. [*packed*](#packed): bit-granular fields packed into one word — bitfields, registers, flag sets.
6. [*codec*](#codec): the escape hatch — hand-written read/write code behind the ordinary item interface; declared size bounds keep sizing and discrimination working.

Each kind's shape is an exported type — `UintItem`/`IntItem` (a `NumItem`, either a `SizedNumItem` or, inside *packed*, a `BitsNumItem`), `BytesItem`, `ArrayItem`, `SwitchItem`, `PackedItem` (`SizedPackedItem`/`BitsPackedItem`) and `CodecItem<Raw>` — all extending `ItemBase`, which holds the common `fixed`/`as`/`custom` vocabulary. `Item` is their union, `Struct` a record of layouts, `Layout` either. The vocabulary ships as values too: `binaryLiterals` (the six kinds, typed `BinaryLiteral`), `integerLiterals` (`IntegerLiteral`), `defaultEndianness` and `defaultBitOrder` (a `BitOrder`).

### Vocabulary

Three terms are used strictly throughout.

**Width** is the umbrella term for the three ways of stating an extent: "size" is always a byte count, "length" always a count of the underlying type — hence *(u)int* and *bytes* items have sizes, while *array* items have lengths — and "bits" is the number of bits inside a *packed* item.

An item's **boundary** is the byte extent a [flex](#bytes) item expands into: the data handed to `deserialize`, narrowed by every enclosing *bytes* item whose `size` frames a sub-layout. Structs, *array* elements and *switch* variants are transparent to it.

**Undefined behavior** is a violated obligation the library does not check: nothing is promised, and the breakage is on the layout's author. Where the line sits, and why it is drawn there, is the subject of [Guarantees & Strictness](#guarantees--strictness).

### Factories and Raw Literals

Every item kind has a factory — `uintItem`, `intItem`, `bytesItem`, `arrayItem`, `switchItem`, `packedItem`, `codecItem` — plus assorted [sugar](#additional-items--sugar). Factories are thin and transparent: each returns exactly the plain-data item it describes, with a precisely inferred type, and hosts construction-time checks (switch tag collisions, codec size-bound sanity, ...).

Item factory signatures follow one of two shapes:

```typescript
itemFactory(...mandatory, width, opts?)  // width required — its own slot, opts trails separately
itemFactory(...mandatory, widthOrOpts?)  // width optional — shares one slot with opts instead
```

What the item interface *requires* is positional, in the order of the property tables in [Item Kinds in Depth](#item-kinds-in-depth) — save for *codec*, whose `read`/`write`/`sizeOf` travel as one object so that their raw type unifies. If the item's width is optional, it can be stated directly as the last argument if all other optional fields remain unspecified.

The data format itself is public API though: layouts are inspectable, rewritable object trees, and raw literals remain fully legal — they are the interchange form all tooling operates on. When writing raw literals, use the `as const satisfies Layout` idiom to keep types exact and typos caught:

```typescript
const rawU16 = { binary: "uint", size: 2 } as const satisfies Layout; //exactly what uintItem(2) returns
```

Factory-built layouts need no such annotation, and are better off without one — so beyond the introductory examples, this README skips it.

<details><summary>Why a gratuitous <code>satisfies</code> is worse than none</summary>

In generic code it can degrade inference: its contextual typing can widen a type-parameter-typed sub-layout all the way to `Layout` ([see tsc bug report TypeScript#52394](https://github.com/microsoft/TypeScript/issues/52394)).

</details>

### `DeriveType`

Layouts convert into their associated type via the generic `DeriveType` type: structs derive objects keyed by their field names, items derive by kind:

| Item Kind | (Default) Derived Type                                 |
| --------- | ------------------------------------------------------ |
| *(u)int*  | `number` (≤ 6 bytes / 53 bits)<br>`bigint` (otherwise) |
| *bytes*   | `RoUint8Array` (raw)<br>`DeriveType` of the sub-layout |
| *array*   | tuple (literal length)<br>array (otherwise)            |
| *switch*  | union of variants                                      |
| *packed*  | object of its fields                                   |
| *codec*   | its raw type                                           |

And the [`custom` property](#fixed-as-and-custom) transforms further; "(Default)" is that caveat. This enables strong typing without ever manually restating an `interface` for the described data — one of the chronic failure modes of imperative serialization code, where the type, the serializer, and the deserializer drift apart because each is written by hand.

`LayoutObject` is the type of any derived object, wherever code accepts one without knowing its layout.

> Derived types are fully `readonly` qualified: raw bytes derive `RoUint8Array`, arrays `RoTuple`/`RoArray` — types exported by [@onrail-xyz/utils](https://github.com/Onrail/ts-sdk/tree/main/packages/utils) (`RoUint8Array` being a `Uint8Array` shorn of its mutating members). Code throughout uses these names; example comments keep `RoUint8Array` — it has no structural spelling — but for readability elide the `readonly` qualifier on object, tuple, and array shapes.

### `fixed`, `as` and `custom`

Every item kind carries the same three optional properties: `fixed` pins the wire, `as` names what a pinned item surfaces, `custom` converts.

> Optional **layout** properties explicitly set to `undefined` are handled exactly as if they were absent altogether — `fixed: undefined` declares no constant, `custom: undefined` no conversion; purely a convenience to avoid special-casing at call sites.

#### `fixed`

Declares a wire constant, expressed in the item's raw domain — what it encodes before any [`custom`](#custom) conversion (a number for *(u)int*s, a `Uint8Array` or the sub-layout's derived value for *bytes*, the element sequence for *array*, the variant object for *switch*, ...). Serialization emits the constant; deserialization verifies the wire against it and throws on mismatch. A fixed item is **omitted from the derived type** — this is what magic bytes, padding, and reserved fields want, so it's the default.

#### `as`

States the value a pinned item surfaces instead of being omitted — the item-side twin of a [*switch* variant's](#switch) `{ id, as }`: wire value, surfaced value. The derived type is the literal:

```typescript
const versionItem = uintItem(1, { fixed: 0, as: "legacy" });
type Version = DeriveType<typeof versionItem>; //=> "legacy"
```

`as` is ignored without `fixed`. To pin an item by its *surfaced* value instead — an enum by name, say — see [`pin`](#layout-manipulation).

#### `custom`

Attaches a `Conversion`: a `{ to, from }` function pair that transforms the type that would otherwise be derived from the associated item — dubbed the `FromType` — into a type supplied by the layout author, the `ToType`:

```typescript
export type Conversion<FromType = Existential, ToType = Existential> = {
  readonly to:   (val: FromType) => ToType,
  readonly from: (val: ToType  ) => FromType,
};
```

The naming scheme: `to` converts the raw value *to* the custom type, `from` converts back.

<details><summary>Why not <code>encode</code>/<code>decode</code></summary>

Conversions stack, so one conversion's `ToType` can map to a parent's `FromType` — `encode` and `decode` would suggest a direct connection to a wire type that does not exist. The [string map example](#layout-manipulation) converts bytes → strings → entry pairs → `Map`, so a conversion's from-side may itself be a heavily processed value.

</details>

<details><summary>Why the type parameters default to <code>Existential</code></summary>

`Existential` is [@onrail-xyz/utils](https://github.com/Onrail/ts-sdk/tree/main/packages/utils)' spelling of "some type" for a type-parameter default. Both parameters appear in parameter *and* return position, so no proper supertype of all instantiations exists and only this choice admits them all — which is what lets a bare `Conversion` serve as the "some conversion" type.

</details>

Since conversions bind to the derived type of an item, they can be attached to any item that produces that type. E.g. a conversion whose `FromType` is `number` can be used both with a 4-byte uint and a 14-bit packed field. The flip side: the type carries none of the item's wire guarantees, so a conversion that quietly relies on one, such as non-negativity or a magnitude bound, must only be attached to items that actually provide it.

Conversions compose: `pipedConversion(a, b)` runs `a.to` then `b.to` (and the `from`s in reverse), and [`withCustom`](#layout-manipulation) attaches a conversion to any layout, composing onto one already there.

#### `fixed` with `custom`

The two compose: an item with both holds `fixed` on the wire but surfaces `custom.to(fixed)` in the derived type. Pinning an already-converted item on the raw side therefore keeps the conversion's *target* type, not the constant's — rarely the wanted reading of "this flag is always on":

```typescript
const alwaysOn = { ...boolItem(), fixed: 1 };
type AlwaysOn = DeriveType<typeof alwaysOn>; //=> boolean
```

[`pin`](#layout-manipulation) states the constant on the surfaced side instead — `pin(boolItem(), true)` yields `{ binary: "uint", size: 1, fixed: 1, as: true }` and derives `true`.

> `as` and `custom` on one pinned item would be two competing claims about what it surfaces — the factories' opts types don't admit the combination, nor `as` without `fixed`; in a raw literal, `as` wins.

### Prefix Items

Wire-encoded byte sizes and element counts are just items: `size` and `length` accept a *uint* item of number width (up to 6 bytes), a number codec, or any item whose conversion lands in `number` (a bare *int* is no count, a wider bare *uint* derives `bigint`), and the prefix's *derived* value is the count, so:

* prefix endianness is just the prefix item's own `endianness`;
* scaled counts (words instead of bytes, header-inclusive lengths) are just a conversion on the prefix;
* [varints](#varints) slot straight in — `arrayItem(elementLayout, compactU16)` is a Solana compact array (`short_vec`), and a length-prefixed *bytes* item takes `size: leb128Codec(32)` just as happily.

A prefix slot's item is typed `PrefixItem`, and a width slot, which takes a number or a prefix, `Count`.

### Automatic Discrimination

Layouts being analyzable data pays off once more when several formats share a wire or a directory: `buildDiscriminator(layouts)` compiles a set of layouts into a discriminator — a function that, handed a chunk of binary data, narrows down which layouts of the set could possibly fit it. In effect, file-type sniffing: what the `file` command does from a hand-curated magic-number database, a discriminator derives from the layouts themselves.

The analysis leans on the two properties every layout exposes: byte sizes and fixed byte values. If all layouts in the set hold distinct, known constants at some position, checking that position settles the question in one step; disjoint size ranges settle it by length alone. In the general case, a greedy divide-and-conquer strategy chooses, at every step, whether discriminating by size or by byte value is guaranteed to eliminate the most candidates.

A discriminator is a best-effort filter in front of deserialization — the brute-force alternative being to attempt each layout in turn. How it relates to *switch* items — which discriminate in-band, within a single layout — is [treated below](#automatic-discrimination-vs-switch).

## Item Kinds in Depth

### *(U)int*

| Property   | Type                | Presence                                                   |
| ---------- | ------------------- | ---------------------------------------------------------- |
| binary     | `"int" \| "uint"`   | mandatory                                                  |
| size       | `number`            | exactly one of size/bits                                   |
| bits       | `number`            | exactly one of size/bits — only inside [*packed*](#packed) |
| endianness | `"big" \| "little"` | default: `"big"`; not applicable to bit widths             |
| fixed      | `number \| bigint`  | optional                                                   |
| as         | `unknown`           | optional — with fixed                                      |
| custom     | `Conversion`        | optional                                                   |

> **Default derived type:**
> | Type     | Condition                  |
> | -------- | -------------------------- |
> | `number` | `size <= 6` / `bits <= 53` |
> | `bigint` | otherwise                  |
>
> The cutoff is 53 bits — the largest integer width a `number` holds without loss of precision — of which 6 bytes is the largest whole-byte width. Both are exported, as `numberMaxBits` and `numberMaxSize`; `NumSizeToPrimitive<S>` and `NumBitsToPrimitive<B>` compute the type, and `NumType` is `number | bigint`.

The factories bind `fixed` and `custom` to that primitive: `uintItem(8, { custom })` demands a `Conversion<bigint>`, `uintItem(4, { custom })` a `Conversion<number>`, and a width whose type is `number` rather than a literal (`4 as number`) a conversion over both — the runtime hands the conversion whichever the width yields. Raw literals carry no such check. `boolItem` and `enumItem` run in `number` and so admit only widths that derive it (the exported `NumberSize` / `NumberBits`).

Signed integers are stored using two's complement. Arbitrary byte sizes are legal (3, 16, 20, 32, ...). Default endianness for all numerics — *(u)int*s and prefix items alike — is big.

There is no built-in support for floating-point numbers, so a [Conversion](#fixed-as-and-custom) is required in such cases. In practice though, most fractional values on a wire aren't floats but scaled integers — amounts, prices, rates — and those deserve better than lossy `number` arithmetic: [@onrail-xyz/amount](https://github.com/Onrail/ts-sdk/tree/main/packages/amount) handles them with exact, unit-aware arithmetic, and [@onrail-xyz/common](https://github.com/Onrail/ts-sdk/tree/main/packages/common)'s `amountItem` is its ready-made layout integration.

**Example**

```typescript
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
  leI16:    intItem(2, { endianness: "little" }),
  leU64:   uintItem(8, { endianness: "little" }),
  year:    uintItem(1, { custom: biasConversion(1900) }),
  hexnum:  uintItem(9, { custom: hexConversion }),
};

type Numerics = DeriveType<typeof numericsLayout>;
//=> { //fixedU8 is omitted: a naked constant
//     leI16:  number; //signed number read in little endian
//     leU64:  bigint; //numbers larger than 6 bytes get turned into bigints
//     year:   number; //biased by 1900, à la C's tm_year
//     hexnum: string; //bigint ↔ string custom conversion
//   }

const numerics: Numerics = {
  leI16:       -2,
  leU64:      258n,
  year:      2026,
  hexnum: "0x1001",
};

const encoded = serialize(numericsLayout, numerics);
//=> new Uint8Array([42, 254, 255, 2, 1, 0, 0, 0, 0, 0, 0, 126, 0, 0, 0, 0, 0, 0, 0, 16, 1])
//                   ├┘  └───┬──┘  └─────────┬──────────┘  └┬┘  └───────────┬────────────┘
//                fixedU8  leI16           leU64          year            hexnum
const decoded = deserialize(numericsLayout, encoded);
//=> equal to numerics (same type and value)
```

### *Bytes*

| Property | Type                                   | Presence                                                        |
| -------- | -------------------------------------- | --------------------------------------------------------------- |
| binary   | `"bytes"`                              | mandatory                                                       |
| size     | `number` \| prefix item                | optional — derived from `fixed`/`layout` when absent, else flex |
| layout   | `Layout`                               | optional, ✚                                                     |
| fixed    | `RoUint8Array` \| sub-layout's derived | optional                                                        |
| as       | `unknown`                              | optional — with fixed                                           |
| custom   | `Conversion`                           | optional                                                        |

> **Default derived type:**
> | Type                 | Condition                 |
> | -------------------- | ------------------------- |
> | `DeriveType<layout>` | specifies layout property |
> | `RoUint8Array`       | otherwise                 |

✚ The layout property frames a sub-layout: the *bytes* item's content is parsed as that layout, and its derived type is the sub-layout's. A size-less *bytes* item with a layout is that layout's struct with an item's properties around it — the form a struct takes when it needs a conversion or a constant of its own (see [`withCustom`](#layout-manipulation)), and inside a *packed* word, like the struct, a group of the word's bits (see [*Packed*](#packed)). With `fixed`, the constant is expressed as the sub-layout's *derived value*, and the engine renders (and verifies) the wire bytes itself.

Number of bytes written/read by a *bytes* item:
* *number size*: reads/writes exactly that many bytes; checked against the content.
* *prefix item size*: the size is encoded on the wire per the prefix item, immediately before the content.
* *no size*: the item spans its content — the `fixed` constant's bytes, or the sub-layout's extent. With neither (raw, unconstrained bytes) the size is not derivable, and the item is *flex*: serialized "as is", and on deserialization taking whatever its [boundary](#vocabulary) has left minus its **reserved tail** — the static size of everything following the flex item up to the end of its boundary. A flex payload with a fixed-width trailer after it — a digest, a footer magic — is thus an ordinary layout: `{ payload: bytesItem(), digest: bytesItem(32) }`. The reservation is no property of the flex item's immediate struct: in `{ head: { flex: bytesItem() }, tail: uintItem(1) }` the flex ends the struct it sits in and still leaves `tail` its byte. Where the tail's extent genuinely cannot be known, deserialization rejects the flex outright: data following it that is not statically sized (in [`calcStaticSize`](#engine-functions)'s sense — a size-uniform *switch* qualifies, a second flex in the same boundary never does), and a flex inside an [*array*](#array)'s element layout, where the remaining elements are part of the tail.

It is legal to redundantly specify a size that could be inferred from `fixed` or a statically-sized sub-layout (e.g. `bytesItem({ size: 3, fixed: new Uint8Array(3) })`) — consistency is then checked, though only at use: mismatches throw on (de)serialization, not at construction. For why this is allowed, see [`customizableBytes`](#customizablebytes).

**Example**

```typescript
const magic = new TextEncoder().encode("magic");
const bytesExampleLayout = {
  raw: { //a nested struct: pure grouping, no wire wrapper
    vanilla:  bytesItem(3),
    prefixed: bytesItem(uintItem(2, { endianness: "little" })),
  },
  fixed: {
    vanilla:   bytesItem({ fixed: new Uint8Array([0, 42]) }),
    converted: bytesItem({ fixed: magic, as: "magic" }),
  },
  flex: bytesItem({ custom: utf8Conversion }),
};

type BytesExample = DeriveType<typeof bytesExampleLayout>;
//=> { raw: { vanilla: RoUint8Array; prefixed: RoUint8Array };
//     fixed: { converted: "magic" }; //fixed.vanilla is omitted: a naked constant
//     flex: string;
//   }

const bytesExample: BytesExample = {
  raw: {
    vanilla:  new Uint8Array([1, 2, 3]),
    prefixed: new Uint8Array([5, 6]),
  },
  fixed: { converted: "magic" },
  flex:  "utf8",
};

serialize(bytesExampleLayout, bytesExample);
//=> new Uint8Array([1, 2, 3, 2, 0, 5, 6, 0, 42, 109, 97, 103, 105, 99, 117, 116, 102, 56])
//                   └─┬───┘  └┬─┘  └┬─┘  └─┬─┘  └─────────┬──────────┘  └────────┬───────┘
//                     │       │     │      │       fixed.converted             flex
//                     │       │     │      └ fixed.vanilla
//                     │       │     └ raw.prefixed
//                     │       └ raw.prefixed size
//                     └ raw.vanilla
```

### *Array*

| Property | Type                    | Presence                                               |
| -------- | ----------------------- | ------------------------------------------------------ |
| binary   | `"array"`               | mandatory                                              |
| layout   | `Layout`                | mandatory                                              |
| length   | `number` \| prefix item | optional — derived from `fixed` when absent, else flex |
| fixed    | the element sequence    | optional                                               |
| as       | `unknown`               | optional — with fixed                                  |
| custom   | `Conversion`            | optional                                               |

> **Default derived type:**
> | Type          | Condition      |
> | ------------- | -------------- |
> | `RoTuple<DT>` | literal length |
> | `RoArray<DT>` | otherwise      |
>
> Where `DT` is the derived type of the layout property and the `RoTuple` has the given length.

*Array* items repeat a given layout. A literal length derives a tuple — great for small fixed shapes, but for large counts (dozens+) tuples fight runtime-constructed data and eventually exhaust the type checker: widen the declaration (`1024 as number`) and the derived type degrades to a plain array while the runtime still enforces the exact length. A flex array (no length) consumes the rest of its boundary minus the reserved tail, under the same rules as flex [*bytes*](#bytes).

**Examples**

```typescript
//an RGB palette (a PNG PLTE chunk's content): triples filling their boundary
const rgbItem = arrayItem(uintItem(1), 3);
const paletteItem = arrayItem(rgbItem);

type Palette = DeriveType<typeof paletteItem>;
//=> [number, number, number][]

serialize(paletteItem, [[255, 0, 0], [255, 165, 0], [255, 255, 0]]);
//=> new Uint8Array([255, 0, 0, 255, 165, 0, 255, 255, 0])
//                   └───┬───┘  └────┬────┘  └────┬────┘
//                      red       orange       yellow

//a count-prefixed array of structs — the archetypal archive directory:
const dirListingItem = arrayItem(
  { filename: bytesItem({ size: uintItem(1), custom: utf8Conversion }),
    filesize: uintItem(4),
  },
  uintItem(2),
);

type DirListing = DeriveType<typeof dirListingItem>;
//=> { filename: string; filesize: number }[]

serialize(dirListingItem, [{ filename: "a.txt", filesize: 260 }]);
//=> new Uint8Array([0, 1, 5, 97, 46, 116, 120, 116, 0, 0, 1, 4])
//                   └─┬┘  ╿  └─────────┬─────────┘  └────┬───┘
//                     │   │      "a.txt" (utf8)      filesize
//                     │   └ filename length
//                     └ count
```

### *Switch*

| Property | Type                          | Presence              |
| -------- | ----------------------------- | --------------------- |
| binary   | `"switch"`                    | mandatory             |
| tag      | `string`                      | mandatory             |
| id       | *(u)int* item \| number codec | mandatory             |
| variants | `{ id, as?, layout }[]`       | mandatory             |
| fixed    | the derived variant object    | optional              |
| as       | `unknown`                     | optional — with fixed |
| custom   | `Conversion`                  | optional              |

> **Default derived type:** the union over variants of `{ readonly [tag]: as ?? id } & DeriveType<layout>`.

Unlike a general [prefix item](#prefix-items), the `id` admits no conversion: variant ids live in its raw domain, which the engine reads and writes directly — `switchItem` rejects an id carrying `fixed` or `custom` (in a raw literal, either is [undefined behavior](#vocabulary)). The domain is the id item's derived primitive and width: a number id on a byte id, a bigint one from 7 bytes up (`[1n, …]` on a `uintItem(8)`), and within the width, so `256` on a `uintItem(1)` is rejected too, since no read could ever produce it. A codec id's domain is the codec's own business.

Each variant record holds:
* **`id`**: the wire value (in the id item's raw domain) — or an inclusive `[lo, hi]` **range** of wire values;
* **`as`** (optional): the value the discriminant surfaces in the derived type; defaults to `id` itself, and an explicit `undefined` is [absent](#fixed-as-and-custom) rather than surfaceable; meaningless and ignored on range variants, which surface the concrete wire value;
* **`layout`**: a struct whose fields sit flat beside the tag — or another *switch* item, whose union merges into the tag row (the subcommand pattern from the [showcase](#showcase): each inner variant gains the outer tag, deriving a flat multi-tag union). A *switch* in this position must carry no `fixed`/`custom` — a converted switch derives a single value, not a union to merge (`switchItem` rejects it).

Variant resolution is first-match in variant order in *both* directions, so overlapping ranges resolve consistently: earlier variants take precedence — placing a narrower range before a broader one carves an exception out of it. A *fully* shadowed variant, in contrast, would be deserialization-dead yet still serialization-reachable through its tag — a silent round-trip break — so `switchItem` rejects it (in a raw literal, it is [undefined behavior](#vocabulary)).

Variants are `SwitchVariant`s: `id` a `VariantId` (a `ScalarId`, or the inclusive `RangeId` pair), `layout` a `VariantBody` (a struct or a *switch*). The `id` item is an `IdItem`, a sized *(u)int* or a number codec.

The `switchItem` factory takes the compact tabular form — an array of `[id, layout]` / `[id, as, layout]` rows — and checks at construction that all tags and merged field names along a chain of variant-position switches are distinct (a variant field named like the tag is undefined behavior in raw literals). Its rows become `NamedSwitchVariant`s (with `as`) and `UnnamedSwitchVariant`s.

**Example**

The modeled statuses surface their literal ids as tags (no `as` needed); the trailing range is a catch-all decoding every other status into raw bytes instead of throwing:

```typescript
const httpResponseItem = switchItem("statusCode", uintItem(2), [
  [   200,     { body:    bytesItem() }],
  [   404,     {                      }],
  [[100, 599], { rawBody: bytesItem() }],
]);

type HttpResponse = DeriveType<typeof httpResponseItem>;
//=> | { statusCode: 200; body: RoUint8Array }
//   | { statusCode: 404 }
//   | { statusCode: number; rawBody: RoUint8Array }

serialize(httpResponseItem, { statusCode: 200, body: new Uint8Array([0, 42]) });
//=> new Uint8Array([0, 200, 0, 42])
//                   └─┬──┘  └─┬─┘
//               statusCode  body

deserialize(httpResponseItem, new Uint8Array([1, 45, 13, 37]));
//=> { statusCode: 301, rawBody: new Uint8Array([13, 37]) }
```

In practice, a reusable version of this layout would accept the `body`'s shape from the call site instead of hard-coding raw bytes — precisely what [`customizableBytes`](#customizablebytes) exists for.

Note that a ranged variant's tag derives as a plain number, so the derived union no longer pins field shapes to concrete ids the way literal tags do — pairing an id with another variant's fields is only caught at (de)serialization.

### *Packed*

| Property   | Type                       | Presence                                                       |
| ---------- | -------------------------- | -------------------------------------------------------------- |
| binary     | `"packed"`                 | mandatory                                                      |
| layout     | `Struct`                   | mandatory                                                      |
| size       | `number`                   | optional — byte width; derived from Σbits when absent          |
| bits       | `number`                   | optional — bit width when nested in another *packed*; ditto    |
| endianness | `"big" \| "little"`        | default: `"big"`; a nested word declaring one is byte-granular |
| bitOrder   | `"msbFirst" \| "lsbFirst"` | default: `"msbFirst"`                                          |
| fixed      | sub-layout's derived       | optional                                                       |
| as         | `unknown`                  | optional — with fixed                                          |
| custom     | `Conversion`               | optional                                                       |

> **Default derived type:** an object of its fields — just like a struct, with fixed fields and padding omitted.

A *packed* item packs bit-granular fields into one logical word.

Its fields are *(u)int* items with `bits` (any width ≥ 1), carrying the full common vocabulary: `fixed` yields padding bits (`paddingItem.bits(n)`), `custom` puts a conversion directly on a bit range, `boolItem.bits()` is a 1-bit bool, `enumItem.bits(entries, n)` an n-bit enum.

An inner item with `size` instead embeds as `8 × size` bits, so ordinary byte items drop in verbatim — *bytes* items included, given an explicit `size` or a raw `fixed` constant: their content is rendered standalone and keeps its own byte order.

Nested structs and fixed-length arrays of bit items work as expected and inherit the word's bit order; nested *packed* items keep their own. A nested struct is a **group** of the word's bits, and so is its [item form](#bytes) — the size-less *bytes* item with a layout that `withCustom`, `spreadLayout`, `unwrapSingleton` and `pin` make of a struct: its fields stay bits of the word, under the word's bit order, and the item's `custom` or `fixed` applies on top. So `unwrapSingleton({ _pad: paddingItem.bits(2), v: uintItem.bits(5) })` is a 7-bit field surfacing `v`, and a group's byte-sized fields own no byte order, just like a struct's. A stated `size` is what turns a *bytes* item back into standalone content.

A nested word is a **lane** of the word around it — `packedItem.bits(layout)` — and by default a pure bit range: it derives its width from Σbits, is exempt from byte alignment, and takes an explicit `bits` only to admit slack. A lane is what gives a group of sub-byte fields its own `bitOrder` or slack — a `fixed` constant or a `custom` conversion needs neither, the struct's item form carries those.

A bit width is legal nowhere else: at the wire boundary it is rejected. *Switch* and *codec* items cannot appear inside a *packed* layout at all.

**Bit and byte order**

The two order parameters are orthogonal — `bitOrder` is the bit order of the fields, `endianness` the byte order of the word — and all four combinations occur in the wild:

| `endianness` | `bitOrder` | Convention of                                        |
| ------------ | ---------- | ---------------------------------------------------- |
| big          | msbFirst   | network formats — struct reading order is wire order |
| little       | lsbFirst   | C bitfields on x86, hardware registers               |
| big          | lsbFirst   | solc storage slots, big-endian ISA field numbering   |
| little       | msbFirst   | packed pixel formats (RGB565 & friends)              |

One layout under all four combinations pins the semantics exactly — `bitOrder` allocates fields within the word (`msbFirst` from the top bit down, `lsbFirst` from bit 0 up), `endianness` then lays the word out as bytes:

```typescript
packedItem({ a: uintItem.bits(4), b: uintItem.bits(12) }, { endianness, bitOrder });
serialize(..., { a: 0x1, b: 0x234 });
```

Allocation, i.e. what `bitOrder` decides:

```
           bit 15 ──── bit 0

msbFirst   0001 001000110100   = 0x1234
           └─a┘ └────b─────┘

lsbFirst   001000110100 0001   = 0x2341
           └────b─────┘ └─a┘
```

And the word rendered as bytes, i.e. what `endianness` then decides:

| `endianness` | `bitOrder` | word     | bytes       |
| ------------ | ---------- | -------- | ----------- |
| big          | msbFirst   | `0x1234` | `0x12 0x34` |
| little       | msbFirst   | `0x1234` | `0x34 0x12` |
| big          | lsbFirst   | `0x2341` | `0x23 0x41` |
| little       | lsbFirst   | `0x2341` | `0x41 0x23` |

Which is why a field's width belongs on the field: emulating a wide one with padding plus a narrow one hard-codes the prevailing `bitOrder` into struct field order, where no order-flipping operation can reach it (see [SetEndianness](#setendianness)).

**Alignment and slack**

Endianness only means something for a byte-ordered container — a bit range has none of its own. An item embedded by byte width (`size`) drops permanently into bit-range territory (`8 × size` bits of the surrounding word), so its own `endianness` is rejected rather than silently ignored. A lane starts the same way — a pure bit range by default — but can opt back in: declaring `endianness`, or spelling its width in bytes as `size`, makes it byte-granular instead, owing the same alignment a wire-facing word owes and rendering through that byte order. The two units — bits, bytes — don't mix within one lane.

Since everything inside *packed* must be statically sized (no prefixes, no flex items — rejected by the engine on traversal), *packed* items are always fixed-width themselves. A word that reaches the wire must be byte-aligned when `size` is absent and hence derived; an explicit `size` admits deliberate slack, zero-filled past the last field and verified zero on deserialization — as does a lane's `bits`, in its own unit.

**Examples**

```typescript
//an IPv4-header-style word: struct reading order = wire order under the defaults
const ipv4Start = packedItem({
  version:     uintItem.bits(4),
  ihl:         uintItem.bits(4),
  dscp:        uintItem.bits(6),
  ecn:         uintItem.bits(2),
  totalLength: uintItem(2), //byte-item embedding: 16 bits
});
serialize(ipv4Start, { version: 4, ihl: 5, dscp: 0, ecn: 0, totalLength: 40 });
//=> new Uint8Array([0x45, 0x00, 0x00, 0x28])

//a flag set (bit i = 1 << i): FAT's attribute byte
//  (bits 6–7 are reserved — the explicit size's zero-filled slack)
const fatAttributesItem = packedItem(
  { readOnly:    boolItem.bits(),
    hidden:      boolItem.bits(),
    system:      boolItem.bits(),
    volumeLabel: boolItem.bits(),
    directory:   boolItem.bits(),
    archive:     boolItem.bits(),
  },
  { bitOrder: "lsbFirst", size: 1 },
);
serialize(fatAttributesItem, {
  readOnly:    true,
  hidden:      false,
  system:      false,
  volumeLabel: false,
  directory:   false,
  archive:     true,
});
//=> new Uint8Array([0b00100001])
//                     ┌─┚    ┖─┐
//               archive      readOnly
```

### *Codec*

| Property | Type                                  | Presence              |
| -------- | ------------------------------------- | --------------------- |
| binary   | `"codec"`                             | mandatory             |
| read     | `(bytes, offset) => [raw, newOffset]` | mandatory             |
| write    | `(raw, bytes, offset) => newOffset`   | mandatory             |
| sizeOf   | `(raw) => number`                     | mandatory             |
| minSize  | `number`                              | default: 0            |
| maxSize  | `number`                              | default: ∞            |
| fixed    | raw value                             | optional              |
| as       | `unknown`                             | optional — with fixed |
| custom   | `Conversion`                          | optional              |

> **Default derived type:** the codec's raw type — what `read` returns.

The escape hatch: An item whose byte encoding is code but whose metadata stays data. Some encodings are loops rather than trees and therefore cannot be layout-shaped — base-128 varints, RLP strings, terminator-delimited fields. A codec hosts them behind the ordinary item interface: `fixed` and `custom` compose on top as usual, the declared size bounds keep the discriminator and static sizing sound (`minSize === maxSize` implies a static size; lying in them is undefined behavior), and number-deriving codecs qualify as [prefix items](#prefix-items), which is what lets [varints](#varints) sit in any size or length slot.

`codecItem({ read, write, sizeOf }, opts?)` assembles one: the raw type is inferred from `read` and unifies all three functions — the one consistency a raw literal cannot enforce, since each function independently satisfies the interface's permissive defaults.

A hand-written `read`/`write` rarely wants to touch bytes one at a time, so the engine's own integer tooling is exported for codecs: `readNum`/`writeNum` are the *(u)int* item's read and write in the codec's `(bytes, offset)` shape, `fitsInBits`/`checkFitsInBits` the range check they run, `isNumberSize` the guard for widths that derive `number`, and `numSizeToPrimitive`/`numBitsToPrimitive` narrow a value accumulated as a `bigint` to what a width derives (`bitsPerByte` is 8, for the arithmetic between the two). The shipped RLP codecs are written against them.

The shipped codecs — [varints](#varints) and the [RLP trio](#rlp) — live with the other prebuilt items under [Additional Items & Sugar](#additional-items--sugar).

## Engine Functions

Four functions put a single layout to work — the machinery for layout *sets* (discriminators) follows in the [next section](#more-on-automatic-discrimination):

```typescript
serialize(layout, value)          //=> Uint8Array — freshly allocated, exactly sized
serialize(layout, value, buffer)  //=> number — bytes written into the provided buffer

deserialize(layout, bytes)        //=> value — bytes must be consumed exactly
deserialize(layout, bytes, false) //=> [value, bytesConsumed] — trailing data tolerated

calcSize(layout, value)  //=> exact serialized byte size of a concrete value
calcStaticSize(layout)   //=> the byte size if everything can be sized independent of the value — or null if dynamic
```

The two return shapes are `SerializeReturn` and `DeserializeReturn`, named for wrappers that forward either form.

`serialize`'s three-argument form writes into a caller-provided buffer (from its start) instead of allocating, and returns the number of bytes written; a too-small buffer throws before anything is written.

`deserialize`'s third parameter is `consumeAll` (default `true`): unconsumed trailing bytes are an error, per the [strictness rules](#guarantees--strictness). Passing `false` waives exactly that check and switches the return type to a `[value, bytesConsumed]` pair — the building block for external framing: read one message off the front, subarray past it, repeat. A [flex](#bytes) item measures against the data it is handed rather than the message it sits in, though — a fixed-width trailer after it only moves the end, it does not find it — so a layout containing a flex swallows the whole remaining stream on the first call; framing such a message needs an explicit size around it.

All three passes report failure by throwing, always a plain `Error` whose message names the field path (`when deserializing field 'x': ...`); a conversion or codec that throws something other than an `Error` has its throw wrapped, as the new error's `cause`. There are no library-specific error classes, so a `catch` cannot sort malformed data from a malformed layout — which is what lets [`buildDeserializer`](#one-step-deserialization) read any throw as "does not fit".

Layouts are meant to be defined once and reused: the engine caches per-item work — the wire bytes of `fixed` constants, for one — keyed by the item's identity, so a layout literal written inline in a `serialize` call is rebuilt, and re-rendered, on every call. The same identity is the contract in the other direction: a layout, its `fixed` values and its conversions are stable for as long as it is in use — the caches never notice an in-place edit, so a changed tree is a new tree, which is what the [operations](#operations) return.

Raw *bytes* values deserialize as views (`subarray`) into the input rather than copies — with two exceptions: the lanes of a *packed* word are extracted into a fresh buffer before decoding, and a codec owns its output (`rlpBytes` allocates its one-byte self-encoding). Mutating the input mutates a view, and `RoUint8Array` only strips the mutators from the returned reference, it cannot immutabilize the underlying buffer.

The sizing pair answers "how many bytes?" at two levels: `calcSize` for a concrete value (e.g. to size an enclosing buffer or a length field one level up), `calcStaticSize` for the layout itself — a number when every conceivable value serializes to the same size, `null` when the size depends on the data (a flex item, a count-prefixed array, or prefixed content of dynamic size anywhere).

## More on Automatic Discrimination

Expanding on the [basics](#automatic-discrimination): besides the layouts to be discriminated, `buildDiscriminator()` takes an optional `allowAmbiguous` flag. By default the discriminator must be able to reduce the candidates to at most one — it returns `number | null` (the index of the candidate, or `null` for "none fit") and `buildDiscriminator()` throws if no uniquely-distinguishing strategy exists. With `allowAmbiguous`, it returns the full candidate set (`RoArray<number>`). The function's type is `Discriminator<B>`, `B` being the flag.

Layout discriminators never produce false negatives but may produce false positives — perfect sensitivity, imperfect specificity: a discriminator never removes a layout that could be used to successfully deserialize a given piece of binary data, but it might return a candidate (hence candidate!) which ultimately fails to deserialize.

**Example**

```typescript
const layouts = [
  { magic: uintItem(2, { fixed: 0 }),                    val: uintItem(1) },
  { magic: bytesItem({ fixed: new Uint8Array([1, 1]) }), val: uintItem(1) },
  uintItem(2),
] as const;

layouts.map(calcStaticSize);
//=> [3, 3, 2]

const discriminator = buildDiscriminator(layouts); //uses strategy: value of first byte, then size

[
  new Uint8Array([0, 0, 0]),    //=> 0 - true positive, deserializes with the first layout
  new Uint8Array([1, 1, 0]),    //=> 1 - true positive, deserializes with the second layout
  new Uint8Array([0, 0]),       //=> 2 - true positive, deserializes with the third layout
  new Uint8Array([0, 1, 0]),    //=> 0 - false positive, fails deserialization on second byte
  new Uint8Array([1, 0, 0]),    //=> 1 - false positive, fails deserialization on second byte
  new Uint8Array([2, 0, 0]),    //=> 2 - false positive, fails deserialization on size
  new Uint8Array([1, 0, 0, 0]), //=> null - true negative
  new Uint8Array([0]),          //=> null - true negative
].map(discriminator);
```

### One-Step Deserialization

`buildDeserializer(layouts)` folds discrimination and deserialization into one call: it tries the candidates in index order and returns the first successful parse as an `[index, value]` pair — typed so that narrowing on the index narrows the value — or `null` when nothing fits. The function is a `Deserializer<L, B>`, a successful parse a `Deserialized<L>`.

Any throw during a candidate's parse counts as "does not fit" — including throws from user conversions and codecs, whose bugs can therefore masquerade as non-matches.

Deserialization is the ground truth that discrimination approximates, so the specificity gap closes: false positives are weeded out, and even layout sets that no strategy can uniquely distinguish are legal — overlaps resolve like [*switch* variants](#switch): first match wins. Continuing the example above:

```typescript
const deserializer = buildDeserializer(layouts);

deserializer(new Uint8Array([0, 0, 3])); //=> [0, { val: 3 }]
deserializer(new Uint8Array([0, 0]));    //=> [2, 0]
deserializer(new Uint8Array([0, 1, 0])); //=> null - the false positive from above fails to parse
```

First-match is the mode for when only one layout can truly fit, even where the layouts alone cannot prove it. When that premise is the very question — identifying binary data of unknown provenance, say — committing to the first fit would be false confidence, so the optional `allMatches` flag (mirroring `allowAmbiguous` above) returns every successful parse instead:

```typescript
const forensic = buildDeserializer([bytesItem(uintItem(1)), uintItem(2)], true);

forensic(new Uint8Array([1, 9])); //=> [[0, new Uint8Array([9])], [1, 0x0109]] - two readings
forensic(new Uint8Array([5, 1])); //=> [[1, 0x0501]] - a size prefix of 5 can't fit in 2 bytes
```

### Automatic Discrimination vs. *Switch*

Both tell binary formats apart, but from opposite ends. A *switch* discriminates in-band: one layout whose variants are told apart by an id field the format reserves for exactly that purpose — purely declarative, deserialized in one step, derived as a clean discriminated union, and composable (a *switch* is an item and can sit at any depth of an enclosing layout). A discriminator works out-of-band: it takes a set of layouts that need not share anything, exploits whatever incidental structure — sizes, fixed values — they happen to have, must be built at runtime, and only ever fronts whole chunks.

Hence the decision rule: when the format is under one's control, spend an id field and use a *switch*. Discriminators earn their keep when it isn't — externally specified formats with no common id, several protocol versions side by side, mixed traffic on one channel. Where separate formats happen to carry distinct leading constants, the two coincide functionally and the choice is one of coupling: a *switch* welds the variants into a single layout and derived type, while separate layouts behind a discriminator remain independently usable.

### Limitations of Discriminators

**Limited scope**

Layout discriminators do not guarantee that all layouts that could be statically distinguished will be.

Since discriminators only work on size ranges and fixed byte values, it's easy to construct cases that are trivial to distinguish yet out of their reach:

```typescript
const even = arrayItem(uintItem(2));
const odd = { plusOne: uintItem(1), even };
```

From the discriminator's point of view, `even` has a size range of 0 to infinity and `odd` a range of 1 to infinity: the interval abstraction loses the parity that makes the two trivially distinguishable.

**Not necessarily optimal**

The greedy strategy construction does not necessarily find an optimal strategy (finding one is NP-hard, so nothing does).

**Startup time**

Typically, layouts are statically defined and hence known "at compile time". But since JavaScript has no compile-time evaluation, discriminators have to be built upon startup.

To avoid overly long startup times in applications making heavy use of discriminators, consider building them lazily — on first use rather than at module load.

## Guarantees & Strictness

On the one hand — as evidenced throughout this document by very liberally declaring incorrect use of the DSL as simply undefined behavior — this library takes a somewhat unconcerned approach to programmer error. Unconcerned is not blind, though: malformed layouts are still rejected outright, by the [factories](#factories-and-raw-literals) at construction (raw literals opt out even of that) and by the engine on traversal (packed misalignment, a flex item inside a packed word).

But that's where it ends — beyond those structural rejects, runtime checks exist for untrusted wire input and for silent-corruption hazards the type level cannot express (a value overflowing its allotted width), and for nothing else: correct code shouldn't pay to be told it's correct. The emblematic case: a fixed item's wire content is the constant — serialization does not verify a handed-in data value against it, and handing in an inconsistent one is undefined behavior. Type-correct code rarely even can: omitted constants leave nothing to pass and `as` pins a literal — the opening is a derived type wider than its constant, like the [converted constant](#fixed-with-custom) that derives `boolean` yet always writes 1.

On the other hand, the trust boundary itself is policed meticulously. Serialization:

* *(u)int* items and prefix values always range-check and throw if the value doesn't fit its allotted width;
* [strings](#utf8) must be well-formed (no lone surrogates silently becoming U+FFFD).

Deserialization:

* every `fixed` constant is verified against the wire;
* all data must be accounted for exactly, unless [`consumeAll`](#engine-functions) is deliberately set to `false`;
* malicious length prefixes can never cause unreasonable allocations or non-terminating parses;
* non-canonical encodings are rejected: malformed UTF-8 throws instead of U+FFFD-substituting (and a leading BOM is preserved rather than swallowed), varints must be minimal by default ([`permissive`](#varints) decoding is opt-in), RLP must be canonical, packed slack bits must be zero.

The canonicality rules make decoding injective — two distinct wire encodings never produce the same value, and re-serializing a deserialized value reproduces its exact bytes — which closes off the classic smuggling vector where equal-looking values have unequal encodings.

The guarantee covers everything the library controls, and the ways out of it are explicit: `permissive` modes waive it by design, [`saturateAs`](#timestamp) makes a field's maximum and every count beyond `Date`'s reach synonyms for its sentinel, and hand-written extensions become part of the trust boundary themselves — a `Conversion` preserves it iff `from(to(raw)) = raw` for every raw value it accepts, a codec iff its `write` exactly inverts its `read` and non-canonical encodings are rejected. `permissive` is the library-wide name for such an opt-out: [varints](#varints) waive minimality under it, [`boolItem`](#bool) its 0/1 restriction.

These guarantees, together with the limitations naturally imposed by strong typing, should radically cut down on the errors associated with binary serialization. It remains up to applications to check the internal coherence of any data received from untrusted sources.

## Additional Items & Sugar

The following are built on top of the primitives above to cover common use cases — and double as examples of how to build your own.

### Bool

`boolItem(size?)` converts an unsigned integer into a boolean, `size` defaulting to a single byte; `boolItem.bits(bits?)` is the bit-width form for *packed* layouts, `bits` defaulting to a single bit. Both are strict by default — only 0 and 1 are valid — and `{ permissive: true }` in the width slot accepts any non-zero value as true; the sized form additionally takes an `endianness`, for the multi-byte booleans C ABIs are fond of.

```typescript
deserialize(boolItem(), new Uint8Array([2]));                     //=> throws
deserialize(boolItem({ permissive: true }), new Uint8Array([2])); //=> true
serialize(boolItem({ size: 4, endianness: "little" }), true);     //=> new Uint8Array([1, 0, 0, 0])
```

### Padding

`paddingItem(size)` is `size` constant zero bytes; `paddingItem.bits(n)` is `n` constant zero bits inside *packed* layouts. Both are fixed items and hence absent from derived types, emitted on serialization, and verified zero on deserialization.

### Enum

Converts a set of string names into their associated numeric values (and rejects unknown values in both directions; names and values must each be distinct, checked at construction, since a repeat would make the mapping non-injective). Implemented via a *uint* item — `enumItem(entries, size?)`, `size` defaulting to 1; `enumItem.bits(entries, bits)` is the bit-width form for *packed* layouts.

```typescript
const myEnumItem = enumItem([["foo", 1], ["bar", 3]], { size: 2, endianness: "little" });

type MyEnum = DeriveType<typeof myEnumItem>;
//=> "foo" | "bar"
```

### Option

Default implementation for encoding optional parts of a layout, inspired by Rust's `Option`: a presence byte, followed by the value if present.

```typescript
const myOptionItem = optionItem(uintItem(2));

type MyOption = DeriveType<typeof myOptionItem>; //=> number | undefined

serialize(myOptionItem, undefined); //=> new Uint8Array([0])
serialize(myOptionItem, 42);        //=> new Uint8Array([1, 0, 42])
```

### Timestamp

Converts an unsigned on-wire count into a `Date`. Parameterized by `unit` (`"s"` default, or `"ms"`), `size` (default 4), `endianness`, `origin` (the instant counts are measured from — unix epoch by default, so NTP-1900- or GPS-1980-style epochs are one option away), and `saturateAs`: a sentinel value that replaces out-of-range throws — too-late instants encode to the field's maximum, and the maximum (like any count past what `Date` can represent) decodes back to the sentinel, matching the near-universal convention of reading an all-ones timestamp as "no expiry".

The options follow the factories' `Opts` convention (an explicitly `undefined` option is unset) except `saturateAs`, where `undefined` is a legitimate sentinel: the key's presence declares one. An option that may be `undefined` types as both outcomes — `timestampItem({ size: maybe8 })` has size `4 | 8` — and a `saturateAs` that may be `undefined` is a sentinel that may be `undefined`. `timestampConversion` takes the same options without `endianness`, since a conversion has no byte order. The option records are `TimestampOpts` and `TimestampConversionOpts` (`unit` a `TimeUnit`), the results `TimestampItem<O>` and `TimestampConversion<O>`.

```typescript
const expiryItem = timestampItem({ saturateAs: "never" });
serialize(expiryItem, new Date("2030-01-01T00:00:00Z")); //=> new Uint8Array([0x70, 0xdb, 0xd8, 0x80])
serialize(expiryItem, "never");                          //=> new Uint8Array([0xff, 0xff, 0xff, 0xff])
```

### Varints

`leb128Codec(maxBits, opts?)` builds unsigned base-128 varints (LEB128), strict on both axes: values must fit `maxBits` and encodings must be minimal (no trailing zero group), keeping decode injective. `leb128` (= 64 bits; zigzag for signed values is a conversion on top) and `compactU16` (= 16 bits, Solana's compact-u16 — whose validator rejects the same "aliased" encodings) are its instances:

```typescript
const shortVecU8 = arrayItem(uintItem(1), compactU16); //a Solana compact array of u8
```

A [prefix](#prefix-items) derives a count, so a varint fits a size or length slot exactly when it derives `number` — up to 53 bits, which `compactU16` and `leb128Codec(32)` are and `leb128` is not. Where a wider varint has to do the framing regardless, a `custom` narrowing the count to `number`, and throwing where it does not fit, is what the slot takes.

`{ permissive: true }` waives minimality alone — WebAssembly [admits](https://webassembly.github.io/spec/core/binary/values.html#integers) `0x03` and `0x83 0x00` alike for 3, within the unchanged ⌈`maxBits`/7⌉ byte cap, so `leb128Codec(32, { permissive: true })` is exactly its `u32` — at the price of injective decoding. Protobuf's varints sit further out (a 10-byte cap regardless of field width, sign-extended negatives) and need their own codec.

### RLP

`rlpBytes` is an RLP string — RLP's one wart, single bytes below 0x80 fusing header and payload, lives entirely inside it; `rlpUint` is an RLP string holding a minimal big-endian integer — zero among them, which makes it the *empty* string, so a lone `0x00` is a well-formed `rlpBytes` but not a well-formed `rlpUint`; `rlpListHeader` is a pure size prefix: drop it into a *bytes* item's `size` slot to frame an RLP struct — typed transactions are then an ordinary *switch*. All three reject non-canonical encodings.

```typescript
serialize(rlpUint, 1024n); //=> new Uint8Array([0x82, 0x04, 0x00])
```

### Utf8

`utf8Conversion` is a `Conversion<RoUint8Array, string>` for the wire boundary, strict in both directions per the [guarantees](#guarantees--strictness) — attach it to any *bytes* item, as the earlier examples do.

### Brand

`brandConversion<B>()` types a field nominally without touching its runtime value — for codebases using branded types to keep their ids apart (`Brand` itself comes from [@onrail-xyz/utils](https://github.com/Onrail/ts-sdk/tree/main/packages/utils)):

```typescript
type UserId = Brand<number, "UserId">;
const userIdItem = uintItem(4, { custom: brandConversion<UserId>() });
type T = DeriveType<typeof userIdItem>; //=> UserId
```

### CustomizableBytes

It is a common pattern that layouts define a certain structure while allowing customization of certain portions of it: network packets are a known header followed by a user-defined payload, which might be raw flex bytes, or length-prefixed, or a full sub-layout with a conversion on top.

If layouts were only ever defined by a single party, it would never make sense to specify e.g. both a size and a fixed value, since the former is derivable from the latter. But with multiple parties — one nailing down the framing (sizes, prefix widths and endianness), another the content, possibly recursively as protocols stack — redundant specification arises naturally, which is exactly why *bytes* items [permit it](#bytes) (consistency remains the specifying parties' obligation — the engine [checks it](#bytes) only once the layout is used).

The `customizableBytes` helper (and its `CustomizableBytes` parameter type) builds such templates: it takes the framing as its base and accepts the payload spec as either content or frame props — nothing, a `Uint8Array` constant, a pinned fragment `{ fixed, as? }` for a constant that surfaces by name, a layout (a converted one included: [`withCustom`](#layout-manipulation) returns a layout), or a conversion of the raw bytes. That is precedence order, which matters only where two arms overlap: a *bytes* item carrying `fixed` is itself a pinned payload, so it is absorbed into the frame rather than framed by it.

```typescript
const packetTemplate = <const P extends CustomizableBytes = undefined>(
  ...payload: OptionalArg<P>
) => ({
  srcPort: uintItem(2),
  dstPort: uintItem(2),
  payload: customizableBytes({ size: uintItem(2) }, ...payload),
} as const);

const rawPacket = packetTemplate();
//=> payload: RoUint8Array

const stringPacket = packetTemplate(utf8Conversion);
//=> payload: string

const numberArrayItem = arrayItem(uintItem(4));
const numberPacket = packetTemplate(numberArrayItem);
//=> payload: number[]

const setConversion = {
  to:   (encoded: RoArray<number>) => new Set<number>(encoded),
  from: (decoded: Set<number>    ) => [...decoded],
} as const satisfies Conversion<RoArray<number>, Set<number>>;
const setPacket = packetTemplate(withCustom(numberArrayItem, setConversion));
//=> payload: Set<number>

const pingPacket = packetTemplate({ fixed: new TextEncoder().encode("ping"), as: "ping" });
//=> payload: "ping"
```

The template takes its payload as `...payload: OptionalArg<P>` and forwards it whole, rather than as `payload?: P`, so that a payload variable typed `X | undefined` types the frame honestly instead of as carrying `X` — see the SDK's [optional-argument convention](https://github.com/Onrail/ts-sdk#optional-arguments).

Inference carries the result in the example; where it has to be *named* — a conversion typed over the still-open payload parameter, as `optionItem` does internally — `CustomizableBytesReturn<B, P>` is the helper's return type.

## Operations

### Layout Manipulation

`withCustom(layout, conversion)` attaches a conversion to a layout, with the conversion's lambdas typed off the layout's derived type. A conversion sits on the node of the value it converts: on an item it is attached to the item itself — composed onto any conversion already there — while a struct, having no node of its own, gets its item-form: the size-less *bytes* item that is a struct's spelling as an item. Here surfacing entry pairs as a `Map`:

```typescript
const stringItem = bytesItem({ size: uintItem(1), custom: utf8Conversion });

const stringMapItem = withCustom(arrayItem(arrayItem(stringItem, 2)), {
  to:   entries => new Map(entries),
  from: map     => [...map.entries()],
});
type StringMap = DeriveType<typeof stringMapItem>;
//=> Map<string, string>
//stringMapItem is the array item itself, carrying the conversion - no wrapper node

serialize(stringMapItem, new Map([["m", "milli"], ["k", "kilo"]]));
//=> new Uint8Array([1, 109, 5, 109, 105, 108, 108, 105, 1, 107, 4, 107, 105, 108, 111])
//                   ╿  └┬┘  ╿  └─┬───────────────────┘  ╿  └┬┘  ╿  └─┬──────────────┘
//                  [ "m"  , "milli" ]                  [ "k"  , "kilo" ]
```

`pipedConversion(...conversions)` is the standalone combinator underneath — wire-outward, left to right — for composing conversions before attaching them. `withCustom` and `pipedConversion` return `WithCustom<L, T>` and `PipedConversion<CT>`, and `ConversionSource<L>` is what a conversion attached to `L` converts from.

`pin(layout, value)` pins a layout by its *surfaced* value — the dual of `fixed`, which pins in the raw domain. The layout's conversion runs once, at construction, and its result lands in `fixed` with the value in `as`; the value is checked against the derived type, so a typo is a compile error:

```typescript
const modeItem = enumItem([["off", 0], ["on", 3]]);
const alwaysOn = pin(modeItem, "on");
//=> { binary: "uint", size: 1, fixed: 3, as: "on" }
type AlwaysOn = DeriveType<typeof alwaysOn>; //=> "on"
```

Two further operations reshape derived objects without affecting the encoding, both built on `withCustom`:
* `spreadLayout(layout, name)` flattens the named field's sub-fields into the enclosing object — the field may be a struct, or a conversion-free *bytes*/*packed* item with a struct layout — i.e. turns `{ coordinates: { x, y }, label }` into `{ x, y, label }`.
* `unwrapSingleton(layout)` unwraps a struct with exactly one non-omitted field into that field's bare value, i.e. turns `{ value: 300 }` into `300` — the natural spelling for "constants plus one payload" wrappers (a value padded to a fixed slot, a magic-prefixed frame).

`pin`, `spreadLayout` and `unwrapSingleton` return `Pinned<L, V>`, `SpreadLayout<S, N>` and `UnwrapSingleton<S>`.

The item form is the struct wherever it sits, so all of these apply inside a *packed* word as well: there the result is a [group](#packed) of the word's bits with the conversion or constant on top — `unwrapSingleton` turns a padded bit field into one field of the padded width, `spreadLayout` lifts a group's bit fields into the enclosing object.

### SetEndianness

`setEndianness(layout, endianness)` recursively flips a whole layout: multi-byte *(u)int*s, prefix items, switch ids, and *packed* words, skipping bit fields and codec items (which have no byte order of their own). Useful when the same structure lives on a big-endian and a little-endian system and parameterizing every item would be a hassle. Inside a *packed* word the rule inverts: its byte-sized *(u)int* fields are bit-ranges of the word and hold no byte order, while a nested word that declares a byte order — by stating a `size` or an `endianness` — has one of its own and is flipped, as does the standalone content of an embedded *bytes* item with a stated `size` (a size-less one is a [bit group](#packed) of the word, whose fields the flip leaves alone like the word's own). A [lane](#packed) declaring neither is a bit range of the word around it, so the flip leaves it alone rather than handing it an order it never had. Caveat: it cannot reach layouts hidden inside custom conversions.

Nor does it reorder struct fields — and it must not: key order is wire order, not a byte-order artifact. Which is why a value's width belongs to the item that holds it. A wide value emulated by padding plus a narrow field encodes the prevailing order into field order, where flipping cannot reach it, and the flipped layout comes out silently wrong: `boolItem(4)` flips, `{ _pad: paddingItem(3), value: boolItem() }` does not. The same holds bit-wise under `bitOrder` — `boolItem.bits(3)` is order-agnostic, while its padding-plus-flag spelling is `pad, flag` under `msbFirst` and `flag, pad` under `lsbFirst`.

### Tree Predicates

Since the layout tree itself is public API, its semantic rules ship as functions for tooling authors: `isItem`/`isStruct`/`isLayout`, `hasFixed`/`hasAs`/`hasCustom`/`isOmitted` (with type-level counterparts `HasFixed`/`HasAs`/`HasCustom`/`IsOmitted`), the accessors `fixedOf`/`asOf`/`customOf`, and the switch-resolution helpers (`variantTagValue`, `findVariantByRawId`, `findVariantByTagValue`, `rawIdOf`). Anything a tree-walking consumer could get subtly wrong has exactly one implementation — these.

## Limitations

* Circular layout definitions (e.g. `type Dir = (Dir | File)[]`) are not supported first-class — though a [*codec*](#codec) can host the recursion in code.

* Prefixes (sizes, lengths, ids) are always encoded immediately before their data (work around via a codec or an ad-hoc layout, at the cost of some awkwardness). [Spans](#spans) will cover the write side — serialize, then patch the prefix from its payload's span — while a read-side forward reference stays framing's job.

* No "symlinks", i.e. no arbitrary references to other fields. The `custom` property can validate individual values, but cross-validation between values has to be done "one level up" — where [spans](#spans) will at least provide the coordinate system.

* Discriminators and static sizes assume the canonical encoding of a prefix: a `permissive` codec's non-canonical spellings of a known count decode, but are not what a discriminator matches or a static size measures.

* Likewise no non-local *values* — checksums, digests, counts spanning already-serialized fields; these too are solved one level up (e.g. via a partial `serialize`), and are the designated quarry of [spans + `checksummed`](#future-direction).

## Future Direction

> **Status:** everything in this section is designed but not implemented. None of the names or signatures below are exported today.

The tail of the [limitations](#limitations) is not an endpoint: the design that addresses it is settled and recorded here until it ships. Keeping that design beside the current boundary lets callers distinguish a fundamental non-goal from a missing capability with a known path forward.

### Spans

Two additional engine functions will expose the correspondence between tree positions and byte ranges:

```typescript
serializeSpanned(layout, data)                 //=> [Uint8Array, Spans<L>]
deserializeSpanned(layout, bytes, consumeAll?) //=> [DeriveType<L>, Spans<L>]
```

The span tree mirrors the derived value — one child per *array* element, the *switch* branch actually taken — with every node carrying its own byte range under a `span` symbol key, intersected with its children: `spans.header.checksum[span]`. A span is offsets, not subarrays — `{ start, end }`, allocation-free and deliberately not a read-only view where the caller means to write — plus a `content` range on nodes where a size prefix or a switch id makes the whole-node and payload ranges differ (what lets PNG's chunk CRC exclude the length prefix it does not cover). Two inversions of the usual rules, both because addressing is the point: `fixed` fields, omitted from derived types, are *restored* here — magic bytes and a zero-initialized checksum slot are exactly the positions a caller wants — while *packed* items and `fixed` sub-layouts become leaves, since bit fields are not byte-addressable and a constant has nothing worth addressing inside.

This is the answer to non-local values — checksums, digests, signatures over a region, counts spanning already-serialized fields, offset tables: expose the coordinate system, and non-local logic lives outside the tree, where the whole message is visible. Stated honestly: spanned serialization enables backpatching, spanned deserialization only verification — a read-side forward reference (a length that must be known *before* reading a flex payload) still needs framing one level up. Checksums are unaffected, since they verify after the fact.

Side payoff: the byte-annotation diagrams throughout this README become derivable — a `hexdump(layout, bytes)` is a couple of dozen lines on top.

### `checksummed`

Spans alone make a checksum *imperative* — serialize, compute, patch, with nothing stopping anyone from forgetting the patch — which dents the "one spec yields the type, the serializer and the deserializer" premise. `checksummed` restores the declarative face: primitive in the engine, policy in a factory, with coverage as a selector over the span tree:

```typescript
const icmpItem = checksummed(icmpLayout, {
  slot:     s => s.checksum,  //zeroed before compute — ICMP's own convention, for free
  coverage: s => s,           //or [s.header, s.payload]; a pseudo-header prepends a scratch buf
  compute:  onesComplement16,
});
```

The slot stays an ordinary field and surfaces in the derived type — deliberately: "the engine is the value's only legitimate source" holds on write and fails on read, where an explorer wants to display a checksum and report a mismatch rather than eat a throw.

<details><summary>Why not a first-class checksum item</summary>

A `checksum` item kind — a `compute(covered)` function plus a `coverage: "preceding" | "following" | "boundary"` enum — was weighed and rejected as too weak and too invasive at once. Too weak because the enum is a closed guess at which coverage shapes exist: PNG's chunk CRC excludes the preceding length prefix, UDP/TCP checksums reach outside their boundary via pseudo-headers — one new arm per format quirk. Too invasive because `compute` would be the first thing in the data format reading bytes its own item does not own — a strictly worse concession than a [*codec*](#codec)'s, which owns the bytes it reads. A coverage *selector* over the span tree is strictly more capable than any enum, and keeps non-local behavior out of the data format.

</details>

### Recorded non-goals

Weighed and deliberately left unbuilt, so the boundary is a decision rather than an accident:

* **End-relative discrimination** — a fixed trailer past a [flex](#bytes) item contributes no fixed bytes to a [discriminator](#more-on-automatic-discrimination), which tracks offsets from the start only. Tracking end-relative offsets alongside is a clean, separable refinement, waiting for a use.

* **End-anchored parsing** — walking a boundary backwards would admit *dynamic* trailers that are self-delimiting from behind (ZIP's end-of-central-directory, trailing length fields). That is a second traversal direction through the whole engine; the reserved tail is the static special case that costs nearly nothing. Unbuilt until an end-anchored dynamic trailer actually shows up.
