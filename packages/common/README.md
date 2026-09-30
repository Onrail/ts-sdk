# @onrail-xyz/common

[![npm version](https://img.shields.io/npm/v/@onrail-xyz/common.svg)](https://www.npmjs.com/package/@onrail-xyz/common)

Glue layer that ties together the lower-level packages (`utils`, `binary-layout`, `amount`) into practical building blocks.

The packages below stay unopinionated: `amount` defines what a kind is without shipping a list of currencies, and `binary-layout` knows nothing about amounts. This is where those opinions live – the concrete unit kinds, and the layout items that bridge the two – so a consumer who only wants the engines never pays for them.

- [Layout Items](#layout-items) – binary-layout items that serialize/deserialize to Amount types
- [Units](#units) – predefined Amount kinds for common units (currencies, duration, bytes, etc.)
- [Utilities](#utilities)

## Install

```bash
npm install @onrail-xyz/common \
  @onrail-xyz/utils @onrail-xyz/binary-layout @onrail-xyz/amount
```

The listed `@onrail-xyz/*` packages are peer dependencies – install them alongside `common` (recent pnpm/npm auto-install peers, so `common` alone may suffice). Peering keeps a single shared instance of each – notably `utils`, whose `unique symbol` anchors every branded type in the SDK. Node and TypeScript floors are [SDK-wide](https://github.com/Onrail/ts-sdk#requirements).

## Layout Items

Binary-layout items that serialize to/from `Amount` and related types.

### amountItem

Creates a *uint* item. Bare, it is a plain `uintItem`; handed a `Kind`, it derives an `Amount`:

```typescript
// Plain uint (no kind) – derives number or bigint depending on size
amountItem(4);   // => { binary: "uint", size: 4 }
amountItem(32);  // => { binary: "uint", size: 32 } (bigint for size > 6)

// With a Kind – derives Amount<K>
const accountLayout = {
  balance: amountItem(8, Sol),                 // reads/writes atomic units (lamports) by default
  timeout: amountItem(4, Duration, "second"),  // explicit unit, for kinds with no atomic one
};
```

A kind-generic layout derives too: with `kind: K` for some `K extends KindWithAtomic`, `amountItem(8, kind)` is a `CustomUintItem<8, Amount<K>>`, and any struct, switch or array holding it derives `Amount<K>` while `K` is still open. A kind that may be absent (`K extends KindWithAtomic | undefined`) yields the `AmountItem<S, K>` conditional instead, which decides between a plain uint and an amount only once `K` is known – and a kind argument that may be `undefined` at runtime yields both.

At a single kind the type alone keeps a wrong-kind amount out. A union kind can't: an item built from a `kind: SeniorKind | JuniorKind` accepts an amount of either member, whichever one it was given at runtime. So serialization checks the amount's kind against the item's and throws `Kind mismatch`, which is the same runtime check `add` and its siblings make. The check is what stops two kinds that share unit symbols from being silently encoded into each other's items.

Since the underlying field is an integer `uint`, serialization floors the amount expressed in the item's unit (matching `Amount.in("atomic")`) – pick a unit fine enough for the precision you need. Negative amounts and amounts exceeding the field width throw. Both statements are about the stored integer: with a transform (below) it is the transformed value that is floored and range-checked, so a shift or scale moves the quantization grid and the admissible range into its own terms – `y = x − 10` stores a −$5 as 5.

A transform reshapes the wire value before it becomes an amount. It is either a binary-layout `Conversion` given directly (`TransformFunc<S>`), or a `(size) => Conversion` factory for transforms that adapt to the item's size (`SizedTransformFunc<S>`). `TransformFuncUnion<S>` accepts either. It slots in where the unit goes (or after it); passed in place of a kind, it simply converts the plain uint, and the item derives whatever the conversion returns (a `CustomUintItem`, as a `rateItem` is). `linearTransform` builds the scaled/shifted ones – its first argument, a `TransformX`, names which side plays x in y = mx + b (`"stored"` or `"converted"`):

```typescript
import { linearTransform } from "@onrail-xyz/common";

//Sol amount squeezed into 4 bytes with kLamport precision (0 to ~4k SOL range)
amountItem(4, Sol, linearTransform("stored", 1_000));
```

### rateItem

For prices and exchange rates – derives a `Rate`, as a `RateItem<S, NK, DK>`. Wraps an existing kind-carrying `amountItem` or builds from scratch; the wire value is the numerator amount per one denominator unit (the denominator kind's human unit by default):

```typescript
// Wrap an existing amountItem: a SOL price, stored as cents per SOL
const priceItem = rateItem(amountItem(8, Usd, "¢"), Sol);  // => derives Rate<Usd, Sol>

// Or build from scratch: size, numKind, numUnit, denKind, [denUnit], [transform]
rateItem(8, Usd, "¢", Sol);                                // => the same item
```

### hashItem

A 32-byte raw *bytes* item – `{ binary: "bytes", size: 32 }` – for the digest fields chain formats are full of.

## Units

Predefined `Amount` kinds for common use cases. These are sensible defaults – not authoritative definitions. Feel free to roll your own if they don't fit your needs.

Each kind comes as its value (`Usd`), its interface (`UsdKind`), and an amount factory named in lower case (`usd(5)`).

- **Currencies**: `Usd`, `Usdt`, `Usdc`, `Btc`, `Eth`, `Sol` – all assignable to the `CurrencyKind` type, and all with the same three formatting systems (`currencyFormats`, each a `CurrencyFormat`):
  - `default` – what you'd normally write ($/¢ for USD, tickers otherwise)
  - `uniform` – ticker-style throughout (USD/cent, BTC/satoshi, ETH/Gwei/wei)
  - `fancy` – unicode symbols where they exist (₿/sat, Ξ, USD₮)
- **Percentage** – `x` (scalar, the base unit), `%`, and `bp` (basis points): `1 x` = `100 %` = `10_000 bp`. Its human unit is `%`, so `percentage(5)` is 5 %.
- **Duration** – nanoseconds through `julianYear` (365.25 days), with `long` (second, minute, …) and `short` (s, min, …) formatting systems. It has no human unit, so always pass a symbol: `duration(5, "min")`
- **Tenor** – day-count time under the 30/360 convention: `day`, `week` (7 days), `month` (30), `year` (360), with `long`/`short` systems like Duration's – the short codes are uppercase (`D`, `W`, `M`, `Y`) so they never read as Duration's lowercase units. Human unit is `year`, atomic is `day`. (Strictly, a tenor is just time to maturity; tying the name to 30/360 is a mild conflation, adopted for want of a better term.)
- **Byte** – `SI` (kB, MB, GB, TB – powers of 1000) and `binary` (bit, KiB, MiB, GiB, TiB – powers of 1024) systems

The kinds above are spelled with `@onrail-xyz/amount`'s [unit-definition helpers](../amount/README.md#helpers) (`toDecimalUnits`, `toScaleUnits`, `withPluralS`, ...), and double as a rich source of examples for them.

## Utilities

`AmountOrAtomic<K>` and its two conversion functions express the "kind is optional" pattern: callers that supply a kind get typed `Amount`s, callers that don't keep working with raw atomic `bigint`s. It is `AmountOr<K, bigint>`; `AmountOr<K, Raw>` is the same union over any raw value, for a width whose item derives a `number`. The pattern recurs throughout the SDK, and everywhere it does the kind argument is the witness for its `K`: let the argument infer `K`, never instantiate it explicitly, since `f<typeof Sol>()` names a kind the runtime never sees. In signatures, write `AmountOrAtomic<K>` with a `K` bound elsewhere (a `kind` argument, an enclosing interface, the return position). The exception is a parameter whose own `K` would be the only thing selecting the arm (`toAtomicIfAmount`): there `K` would be inferred from that very argument and constrain nothing, so take a bare `AmountOrAtomic` – its `K` defaults to the whole constraint `KindWithAtomic | undefined`, making it `Amount<KindWithAtomic> | bigint`.

```typescript
fromAtomicIfKind(1_000_000n);       // => 1_000_000n (no kind, returns bigint)
fromAtomicIfKind(1_000_000n, Sol);  // => Amount<Sol> (=0.001 SOL)

toAtomicIfAmount(1_000_000n);       // => 1_000_000n
toAtomicIfAmount(sol(1));           // => 1_000_000_000n (floored atomic value)
```
