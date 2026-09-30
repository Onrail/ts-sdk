# @onrail-xyz/amount

[![npm version](https://img.shields.io/npm/v/@onrail-xyz/amount.svg)](https://www.npmjs.com/package/@onrail-xyz/amount)

Type-safe handling of amounts with units and arbitrary-precision arithmetic.

## Why?

```typescript
// Seconds or milliseconds?
function retry(timeout: number) { ... }

// From your config - quick: is this 0.15 ETH, 1.5 ETH, or 15 ETH? Or is it even ETH at all?
JSON.parse('{ "maxTransfer": "1500000000000000000" }')

// A 2% fee on a bigint
const fee = amount * 2n / 100n;  // annoying AF
```

But hey, it works, right? Not like anyone ever [lost money because they got their orders of magnitude wrong](https://x.com/threesigmaxyz/status/1929838159019299072), or a [Mars Orbiter](https://en.wikipedia.org/wiki/Mars_Climate_Orbiter) because of unit or dimensional mixups.

Now you could:
1. pray this won't happen to you
2. chest thump and say this won't happen to you
3. drown yourself in branded types and a bunch of utility functions to handle different currencies, different systems of unit, ...

... or you could use this package, which gives you that rigor without the headache/boilerplate:

```typescript
// unambiguous
const timeout = duration(30, "seconds");

// convenient and readable ...
const maxTransfer = eth(1.5);

// ... even in your config
maxTransfer.toJSON(); //"1.5 ETH"

// define prices/rates ...
const ethPrice = usd(3_000).per(ETH);

// ... and apply them in a type-safe manner
const maxInUsd = maxTransfer.mul(ethPrice); // == usd(4_500)

// gives you the atomic unit (wei, sats,...) no matter if ETH, BTC, ...
amount.in("atomic");

// just works
const withFee = amount.mul(1.02);
```

## Quick Start

```typescript
import { Amount, kind } from "@onrail-xyz/amount";

// Define a currency with units
const ETH = kind(
  "ETH",
  [ { symbols: [{ symbol: "ETH"  }] },
    { symbols: [{ symbol: "Gwei" }], oom:  -9 },
    { symbols: [{ symbol: "wei"  }], oom: -18 },
  ],
  { human: "ETH", atomic: "wei" }
);
const eth = Amount.ofKind(ETH);

// Create and manipulate amounts
const balance = eth(1.5);
balance.in("ETH");     // Rational(1.5)
balance.in("Gwei");    // Rational(1_500_000_000)
balance.in("atomic");  // 1_500_000_000_000_000_000n

// Arithmetic
balance.mul(2);      // 3 ETH
balance.add(eth(1)); // 2.5 ETH

// Parse from strings
Amount.parse("25 Gwei", ETH);  // == eth(25, "Gwei")

// Convert between kinds
const USD = kind(
  "USD",
  [{ symbols: [{ symbol: "$", spacing: "compact", position: "prefix" }] }],
  { human: "$" }
);
const usd = Amount.ofKind(USD);

const ethPrice = usd(3000).per(ETH);
eth(0.5).mul(ethPrice);  // $1,500
```

## Install

```bash
npm install @onrail-xyz/amount @onrail-xyz/utils
```

[@onrail-xyz/utils](https://github.com/Onrail/ts-sdk/tree/main/packages/utils) is a peer dependency. No other runtime dependencies — arithmetic is exact, built on native `bigint`.

Like the rest of the SDK, it requires [TypeScript 7](https://github.com/Onrail/ts-sdk#requirements).

That's the pitch. The rest is reference — one front-to-back read pays off, but it's built for jumping:

* [Rational](#rational) — exact arbitrary-precision fractions; what `toString` guarantees
* [Kind](#kind) — unit ladders: [decimal](#decimal-kinds) · [scale](#scale-kinds) · [symbol options](#symbol-options) · [multi-system](#multi-system-kinds) · [`human`/`atomic`](#the-human-and-atomic-designations) · [scalar](#scalar-kinds) · [helpers](#helpers) · [publishing kinds](#publishing-named-kinds)
* [Amount](#amount) — value + kind: construction, unit conversion, rounding, arithmetic, [formatting](#formatting)
* [Rate](#rate) — one kind per another: prices, `inv`, `combine`, `cancel`
* [Type Narrowing](#type-narrowing) — guards for kind unions
* [Kind-Generic Code](#kind-generic-code) — generic over `K`, without casts
* [JSON Codecs](#json-codecs) — round-tripping amounts, rates, and rationals through `jsonStringify`/`jsonParse`
* [Limitations](#limitations) — [symbol characters](#symbol-characters) · [locale](#locale) · [ratios, not dimensional algebra](#ratios-not-dimensional-algebra) · [linear systems only](#linear-unit-systems-only) · [performance](#performance)

## Core Concepts

`Rational`, `Amount` and `Rate` are immutable value types: every operation returns a new instance, nothing is ever modified in place.

### Rational

Arbitrary-precision rational numbers for exact arithmetic. Stored as normalized fractions.

```typescript
import { Rational } from "@onrail-xyz/amount";

Rational.from(5);         // from integer
Rational.from(0.5);       // from float (exact — see below)
Rational.from(5n, 2n);    // from bigint numerator/denominator
Rational.from("1.5");     // from decimal string
Rational.from("1/3");     // from ratio string
Rational.from("333 1/3"); // from mixed-number string
```

`from` reads a `number` the way it was most plausibly written. A value that prints as a decimal of up to 15 significant digits *is* that decimal — `Rational.from(1234.56789)` and `Rational.from("1234.56789")` are always the same value. Past that, the compact fraction the double is the rounding of is recovered when it is too accurate to be a coincidence — `1/3` comes back as exactly `1/3`, not `0.3333333333333333`, and `Rational.from(1/3).mul(3)` is exactly 1 — and everything else keeps the exact decimal the double prints as. Nothing is ever approximated.

The two spellings only part ways once the double stops naming the decimal that was meant — after arithmetic (`Rational.from(0.1 + 0.2)` is `0.30000000000000004`, not `3/10`) or past 15 significant digits. Pass a string when the literal is the truth.

String inputs are en-US: `.` is the decimal point, `,` and `_` are thousands separators in groups of three, and the two cannot mix. Anything else throws rather than guessing — `"1.000,5"` and `"1,00"` both fail — with the one unavoidable exception that `"1.000"` is one, not a thousand.

Supports standard arithmetic (`add`, `sub`, `mul`, `div`, `mod`, `neg`, `abs`, `inv`), comparison (`eq`, `ne`, `lt`, `le`, `gt`, `ge`), queries (`sign`, `isInteger`, `decimalPlaces`), and conversion (`floor`, `ceil`, `round`, `toNumber`, `toFixed`). `mod` is floored — the result carries the divisor's sign, consistent with `div` + `floor` (unlike `%` on `bigint`/`number`, which truncates).

`Rational.powerOfTen(n)` builds 10ⁿ for either sign of `n`; the free `tenToThe(n)` is its `bigint` counterpart, and takes non-negative exponents only. `unwrap()` hands back the underlying `[numerator, denominator]` pair.

`toString` is **exact**: the terminating decimal expansion when there is one (`"0.5"`), the mixed-number form otherwise (`"333 1/3"`) — either way `Rational.from` parses it back to the same value. There is no display precision to configure, and no value ever silently renders as `"0"`; for fixed-precision display, use `toFixed`.

### Kind

A `Kind` defines a dimension (like currency, time, or data) with its units and their relationships. Its name is its identity: two definitions sharing a name are one kind to `sameKind`, to the runtime check behind `add` and its siblings, and to JSON decoding, so they must agree on their standard unit and on the scale of every symbol they share. The package assumes that consistency rather than checking it.

#### Decimal Kinds

For dimensions where units relate by powers of 10, use `oom` (order of magnitude):

```typescript
import { kind } from "@onrail-xyz/amount";

const ETH = kind(
  "ETH",
  [ { symbols: [{ symbol: "ETH"  }] },         // oom: 0 (implicit)
    { symbols: [{ symbol: "Gwei" }], oom: -9 },
    { symbols: [{ symbol: "wei"  }], oom: -18 },
  ],
  { human: "ETH", atomic: "wei" }
);
```

The first unit is the standard unit (scale = 1) — the types only let it claim `oom: 0`, `scale: 1`, or nothing. Other units are defined relative to it: `oom: -9` means the unit is 10⁻⁹ of the standard. A unit written this way is a `DecimalSpec`; the `scale` form below is a `ScaleSpec`.

#### Scale Kinds

For dimensions with arbitrary scale ratios, use `scale`. The spelling is what decides the system's character: a ladder spelled with `scale` is a scale system even where the factors happen to be powers of ten, and only `oom` ladders carry the decimal metadata that `getDecimals` and unit promotion read.

```typescript
const Duration = kind(
  "Duration",
  [ { symbols: [{ symbol: "second", plural: "seconds" }] },
    { symbols: [{ symbol: "minute", plural: "minutes" }], scale:    60n },
    { symbols: [{ symbol: "hour",   plural: "hours"   }], scale:  3600n },
    { symbols: [{ symbol: "day",    plural: "days"    }], scale: 86400n },
  ]
);
```

#### Symbol Options

Each unit can have multiple symbols with display options ("spaced" and "postfix" are default):

```typescript
const USD = kind(
  "USD",
  [ { symbols: [
      { symbol: "$", spacing: "compact", position: "prefix" },
      { symbol: "USD" },
    ]},
    { symbols: [
      { symbol: "¢", spacing: "compact" },
      { symbol: "c", spacing: "compact" },
      { symbol: "cent", plural: "cents" },
    ], oom: -2 },
  ],
  { human: "$", atomic: "¢" },
);
const usd = Amount.ofKind(USD);

// Formatting respects these options:
const amt = usd(100);
amt.toString();                // "$100"
amt.toString("inUnit", "USD"); // "100 USD"
amt.toString("inUnit", "c");   // "10,000c"

const centAmt = usd(50, "c");
centAmt.toString(); // "50¢"
```

Options:
- `position`: `"prefix"` or `"postfix"` (default)
- `spacing`: `"spaced"` (default) or `"compact"`
- `plural`: alternate symbol when the displayed magnitude is not 1 (`-1 hour`)

Those three together with `symbol` are a `SymbolSpec`.

The first symbol for each oom/scale is always the default unit for display. Other symbols can be used for convenience ("¢" prints nicely but is impossible to type, while "c" is easy) or when a certain symbol is desired (as in the example).

#### Multi-System Kinds

Some dimensions have multiple unit systems (e.g., metric vs imperial):

```typescript
const inch = Rational.from(254n, 10000n);  // 0.0254 m

const Length = kind(
  "Length",
  [
    ["metric", [
      { symbols: [{ symbol: "m"  }] },
      { symbols: [{ symbol: "cm" }], oom: -2 },
      { symbols: [{ symbol: "km" }], oom:  3 },
    ]],
    ["imperial", [
      { symbols: [{ symbol: "in" }], scale: inch },
      { symbols: [{ symbol: "ft" }], scale: inch.mul(12) },
      { symbols: [{ symbol: "mi" }], scale: inch.mul(63360) },
    ]],
  ],
);

// Format in different systems
const height = Amount.from(1.78, Length, "m");
height.toString();            // "1.78 m" (standard system, standard unit)
height.toString("imperial");  // "5 ft 10 in" (compound)
```

The first system is the "standard" system and the first unit in it is the "standard" unit. Scale systems render across their units (e.g., "5 ft 10 in", "5 hours 10 minutes 1 second").

#### The `human` and `atomic` Designations

These provide a uniform interface across kinds:

```typescript
// Generic code that works with any kind
function humanValue<K extends KindWithHuman>(amount: Amount<K>): Rational {
  return amount.in("human");  // ETH, USD, meters, etc.
}

function toChainFormat<K extends KindWithAtomic>(amount: Amount<K>): bigint {
  return amount.in("atomic");  // wei, satoshis, lamports, etc.
}
```

- `human`: The unit people naturally think in (ETH, USD, meters) — the default unit of `Amount.from` and the `Amount.ofKind` factories, what the numeric `Rate` forms read, and the unit a zero displays in. A non-zero value picks its own display unit (see [Formatting](#formatting)).
- `atomic`: The indivisible unit for storage/transmission (wei, cents, mm) — `in("atomic")` is a `bigint`, and floors (see [Amount](#amount)).

Note: `atomic` is context-dependent. Lamports are atomic for SOL transfers, but compute prices use microlamports. The designation reflects the common case for a particular domain.

`getDecimals(kind)` reads the decimal distance between the two (especially useful for tokens) and takes an explicit `{ of, in }` pair to measure any other decimal units instead.

The constraints come as a family: `KindWithHuman`, `KindWithAtomic`, `KindWithHumanAndAtomic`, and `KindWithDecimalHumanAndAtomic`, which additionally pins both to decimal ladders — what `getDecimals` needs in order to work without an explicit pair. Each is `Kind` with its type parameters narrowed, so a custom constraint is spelled the same way, over `SystemInfo` and `ValidStandardInfo` (`@onrail-xyz/common`'s `CurrencyKind` is one).

#### Scalar Kinds

For dimensionless quantities (percentages, multipliers), use `scalar`:

```typescript
import { scalar } from "@onrail-xyz/amount";

const Percentage = scalar(kind(
  "Percentage",
  [ { symbols: [{ symbol: "x"   }] },
    { symbols: [{ symbol: "%"   }], oom: -2 },
    { symbols: [{ symbol: "bps" }], oom: -4 },  // basis points
  ],
  { human: "%" }
));
const percent = Amount.ofKind(Percentage);

const fee = percent(10);
const total = usd(1000);
total.mul(fee);  // $100
total.div(fee);  // $10,000
percent(10).mul(percent(50));    // 5 % — scalar × scalar stays scalar
percent(10).div(percent(50));    // 20 % — and so does scalar ÷ scalar
percent(10).ratio(percent(50));  // Rational(0.2) — the quotient of one kind is a plain number
```

`scalar` asserts that the kind's standard unit is the plain multiplier: `mul`/`div` read a scalar operand in standard units. So `%` sits at `oom: -2` below `x`, not `x` at `oom: 2` above `%` — the latter reads `percent(10)` as a factor of 10 instead of 0.1.

The quotient of two amounts of one kind is `ratio`, not a `div` overload. A generic `K` may be instantiated as a union — code over "one of these kinds, known at runtime" — and at `K1 | K2` an overload taking `this` would accept an operand of the other kind, a scalar one included, which `div` scales by; nothing at runtime could tell which reading the types had chosen. So `div` takes scalars only, and `ratio` checks the kind at runtime like `add` and `sub` do.

Scalar kinds also compose into `Rate`s like any other kind — this is how dimensions like "per time" are expressed:

```typescript
const apr = percent(5).per(Amount.parse("365 days", Duration));  // Rate<Percentage, Duration>
```

#### Helpers

`identifyKind(kinds, str)` picks the one kind of a set whose units cover a string's symbols — the search `Amount.parse` runs over its candidate list. `getUnit(kind, symbol)` resolves any symbol, meta symbols included, to its `Unit` record.

Unit ladders are spelled more concisely as rows of scale and symbols. `toDecimalUnits` takes `number` exponents, `toScaleUnits` takes `Rationalish` scales, and both demand a nonempty tuple of `SymbolSpec`s per row — a malformed row is an error at the row, not at the `kind` call it feeds:

```typescript
toDecimalUnits([
  [0,  [{ symbol: "FOO" }]],        // oom: 0 (base unit)
  [-6, [{ symbol: "µFOO" }]],       // oom: -6 (micro)
]);

toScaleUnits([
  [1,    [withPluralS("second")]],  // scale: 1
  [60,   [withPluralS("minute")]],  // scale: 60
]);

withPluralS("hour");                // => { symbol: "hour", plural: "hours" }
allowPluralS("hour");               // => [{ symbol: "hour" }, { symbol: "hours" }]
allowOtherCap("Gwei");              // => [{ symbol: "Gwei" }, { symbol: "gwei" }]
allowPluralSBothCaps("sat");        // => sat, sats, Sat, Sats
withPluralSBothCaps("sat");         // => sat (plural sats), Sat (plural Sats)
```

`@onrail-xyz/common` ships ready-made kinds — USDC, percentages, durations — built with these; it doubles as a rich source of examples.

#### Publishing Named Kinds

The exact structural type returned by `kind()` is deliberately rich: it preserves the kind name, every unit symbol, its system structure, the `human`/`atomic` designations, and the brands that make invalid combinations unrepresentable. That is what powers the package's type safety. It is also far too large to make a good public name.

For a kind exported by a library, give that structure a durable interface name and publish the value through it:

```typescript
import { Amount, kind } from "@onrail-xyz/amount";
import type { Identity } from "@onrail-xyz/utils";

const _Token = kind(
  "Token",
  [ { symbols: [{ symbol: "TOK"  }] },
    { symbols: [{ symbol: "µTOK" }], oom: -6 } ],
  { human: "TOK", atomic: "µTOK" },
);

export interface TokenKind extends Identity<typeof _Token> {}
export const Token = _Token as TokenKind;

export type Token = Amount<TokenKind>;
export const token = Amount.ofKind(Token);
```

The interface is not merely an IntelliSense cleanup. A `type TokenKind = typeof _Token` alias can be expanded back into its full structure when TypeScript emits declarations or carries the type through downstream inference. The interface has its own symbol identity, so generated `.d.ts` files can keep printing `TokenKind`; that avoids duplicating the kind machinery throughout a consumer-facing API and preserves the checker's ability to reuse named instantiations. `Identity` exposes the inferred members in a form an interface may extend without changing them.

The last two declarations are the usual public surface:

* `Token` in type position means an amount of this kind;
* `Token` in value position is the kind object;
* `token(...)` is the convenient amount factory.

This is the same type/value namespace split that classes use. It keeps call sites terse without losing the explicit `TokenKind` name when an API really does operate on kind values:

```typescript
function transfer(amount: Token) {
  const transferCost = token(1);
  return amount.sub(transferCost);
}
```

For the mechanics behind the amount aliases themselves, see [Amount.md](https://github.com/Onrail/ts-sdk/blob/main/packages/amount/Amount.md). For the declaration-emission reason to prefer a traveling interface name, see [DeclarationEmit.md](https://github.com/Onrail/ts-sdk/blob/main/DeclarationEmit.md).

### Amount

An `Amount` pairs a value with a `Kind`. Internally stored in standard units as `Rational`.

```typescript
// Creation (a string, or `Rationalish` = number | bigint | Rational)
Amount.from(1.5, ETH);          // uses human unit by default
Amount.from(1.5, ETH, "Gwei");  // explicit unit
Amount.from("1,000.5", ETH);    // from string

// Parsing
Amount.parse("1.5 ETH", ETH);
Amount.parse("2 hours 30 minutes", Duration);
Amount.parse("2 1/2 hours", Duration);  // fractions and mixed numbers
Amount.parse("1.5 ETH", ETH, USD, BTC); // any number of candidate kinds; the symbols pick one

// Unit conversion
amt.in("ETH");      // Rational
amt.in("atomic");   // bigint — floors; in("wei") is the same unit, exact
amt.in("human");    // Rational

// Rounding
amt.floorTo("Gwei");  amt.ceilTo("Gwei");  amt.roundTo("Gwei");
```

Numbers and strings are read by `Rational.from` — see [Rational](#rational) for what a double means and which string forms are accepted. `Amount.parse` is narrower on the value side: a value token is digits with separators, a decimal point, a fraction or a mixed number, and never an exponent — `e` reads as the start of a symbol. That is the grammar `toString` emits. Everything downstream of construction is exact, with one deliberate exception: `in("atomic")` returns a `bigint`, so it floors — an atomic count can't be fractional. The same unit by name (`in("wei")`) returns the exact `Rational`; when flooring isn't the direction wanted, `ceilTo("atomic")`/`roundTo("atomic")` first.

`roundTo` (and `Rational.round`) round **half away from zero**: `0.5 → 1`, `-0.5 → -1`, so `round(-x) = -round(x)` — unlike JS's `Math.round`, which sends `-0.5 → 0` and thus breaks that symmetry. It's the only rounding mode; for anything else (e.g. banker's / half-to-even) compose it from `floorTo`/`ceilTo` or work from the exact `.in(unit)` value.

```typescript
// Arithmetic (same kind required for add/sub)
a.add(b);  a.sub(b);  a.mul(2);  a.div(2);  a.mod(b);
a.abs();   a.neg();
a.ratio(b);  // same kind ⇒ dimensionless Rational

// Comparison & queries
a.eq(b);  a.ne(b);  a.lt(b);  a.le(b);  a.gt(b);  a.ge(b);
a.isZero();  a.sign();  // -1 | 0 | 1

// Aggregation & comparison — variadic free functions, like Math.min (Rates and Rationals work
// too). A possibly-empty collection spreads behind an explicit first operand — min/max have no
// identity element and an empty sum needs to know its kind. The result is of the kind every
// operand has: a union-kinded operand narrows to what the others admit, and two distinct kinds
// make the call `never` — it can only throw:
min(a, b, c);  max(a, b);  sum(a, b, c);  sum(eth(0), ...fees);
clamp(x, lo, hi);
amounts.sort(compare);  // three-way comparison: -1 | 0 | 1

// "an amount of my own kind" — the constructors of choice in kind-generic code (see below)
a.zero();             // 0 of a's kind
a.ofSame(2, "Gwei");  // 2 Gwei of a's kind

// Kind conversion via Rate (dimensional analysis)
ethAmount.mul(usdPerEth);  // ETH × USD/ETH = USD
usdAmount.div(usdPerEth);  // USD ÷ USD/ETH = ETH
```

`allocate` splits an amount into parts that are each a whole number of some unit — atomic by default — yet still sum exactly, leftover units going to the largest fractional shares (the largest-remainder method; flooring each share independently would quietly leak dust):

```typescript
allocate(usdc(1), 3);             // [0.333334, 0.333333, 0.333333] USDC — sums exactly to 1
allocate(total, [4, 1]);          // pro-rata by weights
allocate(total, [1, 1], "USDC");  // quantized to a specific unit
```

The amount must itself be whole in the chosen unit — allocation never rounds the total, so quantization (and the dust decision that comes with it) stays with the caller. Literal counts and weight tuples return length-typed tuples, ready for destructuring.

#### Formatting

```typescript
const amt = Amount.from("1234.56789", ETH);

amt.toString();                 // "1,235 ETH" (approximate, default)
amt.toString("exact");          // "1,234.56789 ETH"
amt.toString("inUnit", "Gwei"); // "1,234,567,890,000 Gwei" (precision defaults to 0)
amt.toString("inUnit", "ETH", { precision: 2 });  // "1,234.57 ETH"

//trimZeros is true by default and trims trailing decimal zeros
amt.toString("inUnit", "ETH", { precision: 6, trimZeros: false });  // "1,234.567890 ETH"

// precision also takes any decimal unit:
amt.toString("inUnit", "ETH", { precision: "Gwei", trimZeros: false });  // "1,234.567890000 ETH"

// thousandsSep adds a separator for every group of 3 in integer range (options: "," | "_" | "")
amt.toString("approximate", { thousandsSep: "_" });  // "1_235 ETH"

// for multi-system kinds, the first positional arg can be a system name:
height.toString("imperial");  // "5 ft 10 in" (height from the Length example above)
```

`thousandsSep` and `trimZeros` together are `ToFixedOptions`, the separator alone a `ThousandsSep`. A unit-valued `precision` accepts exactly `DecimalSymbolsOf<K>` — the kind's symbols that have an `oom` to count in.

Both modes render in the same unit and differ only in digits. The unit is the largest one the value reaches, promoted to the next one up when the ladder gap is six or more orders of magnitude and the promoted reading has at least a thousandth of it — so `0.5 ETH` is not `500,000,000 Gwei`, while `15,000 Gwei` stays put rather than becoming `0.000015 ETH`. A zero reaches no unit and renders in the `human` unit (the standard one when none is declared), or in the smallest unit of a rendered system that lacks it. `"approximate"` (the default) means short: three significant digits in the unit a value reaches, three decimals of a unit it was promoted to (`1,500,000 Gwei` reads `0.002 ETH`) or of the smallest unit it falls below, so anything under a thousandth of the smallest unit reads `0`. A reading that rounds up to the next unit renders in that one: `$0.9996` reads `$1`, not `100c`. `"exact"` shows every digit: the terminating decimal expansion when there is one, the mixed-number form otherwise — `"1/3 ETH"`, `"$1,763,668,414 3/7"` — so nothing is ever rounded away. Scale systems render across their units in both modes: `"approximate"` rounds to whole units of the smallest one, renders whole units down from the largest it reaches, and stops once what remains is under a thousandth of the whole (`70.08 in` is `"5 ft 10 in"`, `119.6 s` is `"2 minutes"`; a value below the smallest unit renders in it alone, to three decimals, `"0.5 seconds"`), `"exact"` runs down to the smallest unit and keeps its tail exact (`"1 minute 40 1/3 seconds"`).

`toJSON` (what `JSON.stringify` calls) is `toString("exact")` and always round-trips through `Amount.parse`. It takes no arguments of its own — `JSON.stringify` invokes `toJSON(key)` with the property key, so options go to `toString("exact", opts)`, which `Rate` accepts in the same spelling. `Rate.toJSON` quotes against the denominator's human unit when it declares one (`$/ETH`, `USD/BTC`), as `Rate.toString` does. A denominator without one is searched for the unit the rate reads best against: a numerator that terminates beats one in mixed-number form, then shorter output wins. A `Rate` keeps only a ratio and no memory of the units it was built from, so `usd(100).per(Amount.parse("1 day", Duration))` coming back as `"$100/day"` is the search at work — against the standard unit that same rate is `25/216` cents per second.

### Rate

A `Rate` represents a ratio between two `Kind`s (e.g., a price): `Rate<USD, ETH>` reads "USD per ETH". The two must be distinct kinds — a ratio within one kind is dimensionless, which is what `Rational` is for — so `Rate.from` and `per` reject a matching pair.

```typescript
// Creation
Rate.from(3000, USD, ETH);        // 3000 USD per ETH
usd(3_000).per(ETH);              // equivalent to ^
Rate.from(usdAmount, ethAmount);  // from two amounts
usdAmount.per(ethAmount);         // equivalent to ^
```

The numeric forms read their value in **human units** — `Rate.from(3000, USD, ETH)` is 3000 human-USD per one human-ETH — which is why they require both kinds to declare a `human` unit. The amount forms carry their own units and have no such requirement.

```typescript
// Parsing
Rate.parse("3000 USD/ETH", USD, ETH);
Rate.parse("1/2 BTC/ETH", BTC, ETH);  // ratio syntax

// Get ratio in specific units
rate.in("USD", "ETH");  // Rational(3000)

// Round to integer multiples of a unit pair
rate.floorTo("USD", "ETH");  rate.ceilTo("USD", "ETH");  rate.roundTo("USD", "ETH");

// Arithmetic (same num/den kinds required for add/sub — e.g. benchmark + spread)
rate.add(spread);  rate.sub(spread);
rate.mul(2);  rate.div(2);
rate.abs();   rate.neg();

// Queries
rate.isZero();  rate.sign();  // -1 | 0 | 1

// Invert
rate.inv(); // now ETH / USD

// chaining
usdPerEth.combine(ethPerBtc);  // USD/BTC
usdPerEth.cancel(ethPerUsd);   // Rational — reciprocal dimensions cancel out

// Formatting (numerator per the numerator kind's display options, hence the prefixed "$")
rate.toString();                            // "$3,000/ETH"
rate.toString({ numSymbol: "USD" });        // "3,000 USD/ETH"
rate.inv().toString();                      // "0.000333 ETH/$" (3 significant digits)
```

`combine` returns a `Rate` and throws if the outer kinds cancel; use `cancel` for reciprocal dimensions. `cancel` multiplies the ratios and checks both kind matches. Keeping the operations separate makes their return types reliable even when kinds are generic or unions.

## Type Narrowing

Use type guards when working with unions:

```typescript
if (Amount.isOfKind(amt, ETH))
  amt.in("wei");        // narrowed

if (Rate.hasNum(rate, ETH)) //or hasDen
  rate.in("Gwei", "$"); // narrowed numerator

if (Amount.allOfKind(amts, ETH)) // and Rate.allHaveNum / allHaveDen
  sum(eth(0), ...amts); // Amount<typeof ETH>, not the union the elements were declared with
```

The free functions `isAmount` and `isRate` tell the classes apart — from each other and from everything else. Across a union they keep exactly the matching constituents (an `Amount<K> | Rate<NK, DK> | Rational` narrows to `Amount<K>`), and an `unknown` narrows to `Amount<Kind>`/`Rate<Kind, Kind>`:

```typescript
if (isAmount(value))
  value.toString();  // narrowed
```

## Kind-Generic Code

Code that is generic over kinds works without casts: methods preserve K through chains and same-kind operands, helpers infer K from concrete and union arguments alike, and mixing two different type parameters in a same-kind operation is a compile error. A rate operand is the exception: at an open K its amount-side kind is checked at runtime only (see [Amount.md](https://github.com/Onrail/ts-sdk/blob/main/packages/amount/Amount.md)).

```typescript
const afterFee = <K extends KindWithAtomic>(amount: Amount<K>, fee: Amount<typeof Percentage>) =>
  amount.sub(amount.mul(fee)).floorTo("atomic");  //: Amount<K> — no casts anywhere
```

Three things to know:

- `amt.kind` erases to the constraint at an open K (likewise `Rate`'s `num`/`den`). Use `zero()`/`ofSame()` — both classes carry them — for "one of my own kind(s)", or the free functions `kindOf(amt)` / `numKindOf(rate)` / `denKindOf(rate)` for exact reads. `inv`'s swapped result erases the same way; `invert(rate)` is its kind-exact spelling.
- Unit symbols are exactly as available as the constraint promises: `KindWithAtomic` admits `"atomic"` (and `"standard"`), nothing else. That set is `SymbolsOf<K>`; `KindUnitSymbols<K>` is the declared symbols without the meta ones, and `ResolvedSymbolOf<K, M>` is what a meta symbol stands for.
- Signatures take the `Amount`/`Rate` aliases; the `_Amount`/`_Rate` classes behind them are exported for type reachability and `instanceof`, never for annotations. `AmountFromArgs<K>` is `Amount.from`'s trailing parameter list, for wrapping it in a kind-generic factory of your own.

## JSON Codecs

`jsonStringify`/`jsonParse` from `@onrail-xyz/utils` carry amounts, rates, and rationals once handed the matching codecs:

```typescript
import { jsonStringify, jsonParse } from "@onrail-xyz/utils";
import { amountCodec, rateCodec, rationalCodec } from "@onrail-xyz/amount";

const codecs = [amountCodec([ETH, USD]), rateCodec(USD, ETH), rationalCodec];

const json = jsonStringify({ balance: eth(1).div(3) }, codecs);
// => '{"balance":{"$type":"Amount","value":{"kind":"ETH","value":"1/3 ETH"}}}'

jsonParse(json, codecs);            // => the original, exactly
```

The payload names its kind alongside the rendering, and a `Rate` names both of its own (`{ num, den, value }`). That name is what decoding resolves against the candidates — the rendering alone cannot identify a kind whenever two candidates own the same unit symbol, and `%` is not an unusual thing for two kinds to share. The value half is then parsed against the single kind the payload names, so a shared symbol is no longer ambiguous.

The kind-aware codecs take those candidates the way `Amount.parse` does, and `rationalCodec` needs none. `test` claims every instance regardless of kind, so **encoding is total** while decoding a kind that is not among the candidates throws `No candidate kind named "ETH"` — serializing outside the candidate set fails on the way back in, loudly, rather than silently handing back a wire object.

## Limitations

### Symbol Characters

Symbols cannot be empty, cannot start with a minus sign or a digit, and cannot contain:
- Whitespace
- Commas, underscores, dots, or slashes (used in number parsing)
- Digits at all, if the symbol is prefixed: a value follows it directly (`$100`)

A postfix symbol may hold digits past its first character (`USDT0`, `C98`), since it ends at the next space.

`kind()` rejects offenders — a symbol containing any of these could never round-trip through its own kind's parsing.

The names `"standard"`, `"human"` and `"atomic"` are reserved too — they address units generically, so `kind()` rejects a unit trying to claim one. Likewise for systems: `toString` takes a system name where it takes a display mode, so `"approximate"`, `"exact"` and `"inUnit"` cannot name a system.

Unicode symbols work fine: `$`, `€`, `¥`, `m³`, `µs`, `°C`. Symbols are identifiers, so parsing compares them by their NFKC form, as Unicode prescribes for identifiers: `"3 m3"` parses under a kind that spells the unit `m³`, `"20 ℃"` under `°C`, and `"5 μs"` with a Greek mu (U+03BC) under `µs` with a micro sign (U+00B5) — two code points that render alike. Output always uses the spelling the kind declares, so declare the typographic form (`m³`) and let input be lax — except for a prefix symbol's digits, which input can't separate from the value that follows (`m3100`). Since equivalent spellings are one symbol, `kind()` rejects a kind that declares two of them.

### Locale

Numbers parse and print en-US only — `.` as the decimal point, `,`/`_` as thousands separators (the exact rules are under [Rational](#rational)) — and there is no `Intl` hook to change that. Symbol placement is the kind's business (`"$100"`, `"100 USD"`), the digits are not.

### Ratios, Not Dimensional Algebra

A `Rate` is one kind over one kind: no products, no exponents, no nesting, so quantities like `m/s²` or `N·m` have no spelling here. `combine` chains ratios (USD/ETH × ETH/BTC = USD/BTC) and that is the whole of the composition.

### Linear Unit Systems Only

Kinds like temperature where different systems use affine rather than just linear transforms (i.e. they have an additive component e.g. `x °C = 9/5 x + 32 °F`) are not supported (adding support wouldn't be too hard, but the additional complexity is likely not worth it).

### Performance

Exact arithmetic on `bigint` fractions, measured on ordinary dev hardware: the arithmetic core (`add`, `mul`, comparisons, `in`, the rounding trio) runs at 50–130 ns per operation on ladder-sized values, construction around 0.5 µs, parsing and formatting at 0.7–2 µs, and summing ten thousand amounts takes under a millisecond. For anything short of a hot inner loop, exactness is effectively free.

The one pattern that isn't: **composing non-terminating fractions**. Nothing is ever rounded, so compounding a daily rate like `7301/7300` keeps every digit — ten thousand steps grow the denominator to ~128,000 bits and cost ~110 ms in total, each step pricier than the last (a run's cost grows quadratically with its length). Where a computation re-quantizes anyway, `roundTo("atomic")` per step collapses the fraction back to ladder size: the same ten thousand steps then take ~11 ms, stay flat, and display the same value. Being exact costs ~100 ns; carrying every digit of 27 years of daily compounding is a choice.
