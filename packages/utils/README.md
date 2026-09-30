# @onrail-xyz/utils

[![npm version](https://img.shields.io/npm/v/@onrail-xyz/utils.svg)](https://www.npmjs.com/package/@onrail-xyz/utils)

The dependency-free root of the SDK: type-safe utilities for readonly and const data structures – const-preserving array and object operations, and lookup tables built from a const spec – general-purpose typing utilities, and the runtime primitives that build on them – encoding, bytes, codec-extensible JSON, and range-checked unix time.

- [Conventions](#conventions) – what every example below assumes
- [Type Utilities](#type-utilities) – core types, mutability helpers, `RoUint8Array`
- [Array Utilities](#array-utilities) – const-preserving array operations
- [Object Utilities](#object-utilities) – type-safe object manipulation
- [Const Maps](#const-maps) – typed lookups over a tabular const spec, any columns as keys
- [String Utilities](#string-utilities) – type-preserving case functions and prefix stripping
- [Piping](#piping) – function composition, guarded assertions, and predicates
- [Branding](#branding) – hierarchical type branding with tag accumulation
- [Aliasing](#aliasing) – suppress union expansion in IDE tooltips
- [Encoding](#encoding) – hex, utf8, base64, bignum
- [Bytes](#bytes) – comparison, zero padding, concatenation
- [JSON Codecs](#json-codecs) – round-trip JSON for types JSON cannot natively carry
- [Time](#time) – range-checked unix seconds ↔ `Date`
- [Assertions](#assertions) – simple runtime checks
- [Limits](#limits) – where the type level runs out
- [Future Direction](#future-direction) – an open registry of leaf types for the mutability helpers

## Install

```bash
npm install @onrail-xyz/utils
```

`utils` has no dependencies of its own — it's the root of the SDK. Every other `@onrail-xyz/*` package declares it as a peer dependency so that a single, shared copy ends up in the dependency tree: the SDK's branded types are anchored to a `unique symbol` defined here, and two copies would make those types mutually incompatible.

Encoding rides the `Uint8Array` base16/base64 builtins, Baseline since 09/2025, hence the SDK's [Node floor](https://github.com/Onrail/ts-sdk#requirements). Codecs that need a third-party implementation live with the chain package that needs them: `base58` and `sha256` in `@onrail-xyz/svm`, `keccak256` and `sha3_256` in `@onrail-xyz/evm`.

## Conventions

A literal passed inline keeps its literal type – `range(3)` is `[0, 1, 2]`, not `number[]`, and an object or array literal is read as if `as const`, through the function's `const` type parameters. Only a value declared separately and passed later needs an `as const` of its own.

The `// =>` comments in the examples show the result – as a type where the type is the point, as a value where that reads better, with the type spelled out beside it (`typed as …`) when the two would differ. `readonly` is written where the result carries it and nowhere else.

`Ro` means readonly, `Ne` non-empty. Type utilities over tuples come in two shapes: a `Tuple`-prefixed one that promises a tuple – it accepts only what lets it keep that promise (a tuple, a literal length) and yields `never` for anything else, never a plain array – and an unprefixed one that degrades gracefully to the array type instead (`TupleRange` vs `Range`, `TupleOfLength` vs `OfLength`, `TupleFlatten` vs `Flatten`, …). Reach for the prefixed shape to *demand* a tuple, for the unprefixed one when the input may well be a runtime array.

## Type Utilities

Core type utilities for readonly data and type manipulation.

### Tuple Types

- `Tuple<T>`, `NeTuple<T>` – mutable tuple, non-empty variant
- `RoTuple<T>`, `RoNeTuple<T>` – readonly tuple, non-empty variant
- `RoArray<T>` – `readonly T[]`
- `RoPair<T, U>` – `readonly [T, U]`
- `RoTuple2D<T>`, `RoArray2D<T>` – readonly tuple of tuples, readonly array of arrays
- `IsFixedTuple<T>` – whether an array type's length is known; an open tail (`[T, ...T[]]`) is a tuple, but its length is `number` like any array's
- `AsFixedTuple<A>` – `A` when it is a fixed tuple, `never` otherwise: the extends type of a distributive `A extends AsFixedTuple<A> ? … : …`, which distributes over unions of arrays (a bare `IsFixedTuple` collapses them) and narrows `A` to a tuple in the true branch

### RoUint8Array

A truly readonly `Uint8Array` type that correctly types `subarray`, `valueOf`, and callback methods, and hides `buffer`, since a fresh `Uint8Array` over it would write the same bytes. Writing through one takes a cast – `mutable(view)` is the `const_cast` – so every breach of the promise is visible at the call site. With no `buffer` to type, it also carries no buffer type parameter: `mutable` hands back a plain `Uint8Array`. See [RoUint8Array.md](https://github.com/Onrail/ts-sdk/blob/main/packages/utils/RoUint8Array.md) for implementation details.

### Mutability Helpers

- `Ro<T>`, `DeepRo<T>` – shallow/deep readonly
- `Mutable<T>`, `DeepMutable<T>` – shallow/deep mutable
- `ro(value)`, `deepRo(value)` – runtime casts
- `mutable(value)`, `deepMutable(value)` – runtime casts

All four map `Uint8Array` and `RoUint8Array` onto each other, and pass functions and primitives (and hence branded types!) through unchanged.

### Other Utilities

- `Function<P, R>` – `(...args: P) => R`; with its defaults every function type extends it, so it doubles as the generic stand-in for the built-in `Function`
- `Guard<T, U>`, `Predicate<T>` – type guard and predicate signatures
- `NarrowTo<T, C>` – what a class type guard narrows `T` to: `T`'s own `C`-constituents if any, else `T & C`
- `Primitive` – the seven JS primitive types; the mutability helpers test assignability to it, so a branded primitive (`string & Brand`) matches through its base
- `Nullish` – `null | undefined`
- `BaseObject` – extend this for interfaces meant to be augmented by declaration merging
- `Existential` – "some type" for a type-parameter default (TypeScript has no native existentials); it is `any`, which admits every instantiation and guards nothing, and belongs *only* there — in any other position it is not an existential but a disguised `any`
- `StrRecord<T>` – `Record<string, T>`
- `Opts<T>` – make all properties optional, readonly, and allow `undefined` (for options-bag params)
- `OptionalArg<T, Rest?>` – `[T, ...Rest] | []`, for `...x: OptionalArg<T>`: an optional argument whose type parameter sees a passed `undefined` rather than losing it to the `?` of `x?: T`. Trailing optionals nest, `OptionalArg<A, OptionalArg<B>>`; `argOf(x)` is the argument as `T` and `restOf(x)` the arguments after it, for forwarding other than as a whole (`...x`). The SDK-wide [optional-argument convention](https://github.com/Onrail/ts-sdk#optional-arguments) says where and why
- `Simplify<T>` – flatten intersection types for readability
- `Identity<T>` – `T`; an interface's `extends` clause takes type references only, not `typeof` queries, so `interface Config extends Identity<typeof _config> {}` is how a large inferred type gets a name that hovers and `.d.ts` emit keep (an alias, the compiler is free to expand). The interface is structurally `typeof _config`, assignable both ways
- `Widen<T>` – widen literal types (unique symbols included) to their primitives; object types (functions included) collapse to `object`
- `HeadTail<T, Head, Tail>` – the tuple head/tail pattern, `T extends HeadTail<T, infer Head, infer Tail>`; keeps the `readonly` the hand-written spread form tends to drop
- `ElementRest<T>` – extracts a fixed head, or otherwise a fixed last element, as `[element, rest]`; yields `undefined` when no position is guaranteed. For order-independent folds that can use fixed entries on either side of a runtime array, such as `[...entries, last]`
- `Extends<T, U>` – distributes over `T`; `AnyExtend<T, U>` – some constituent of `T` extends `U`; `AllExtend<T, U>` – whole-type check, non-distributive; `IsAny<T>`, `IsNever<T>`, `IsUnion<T>`; `If<C, T, F>` – distributes too, so `If<boolean, T, F>` is `T | F`
- `IsLiteral<T>` – whether `T` is a single primitive value (a literal, a unique symbol, `null`, `undefined`); a template literal pattern and a union are not
- `IsInteger<N>`, `IsSigned<N>` – whether a number literal is an integer / negative
- `ExactKeys<K>` – whether a key (or index) argument names a definite set: a single literal key, or a fixed tuple of them; a union key or a runtime array may select any subset. The object and array helpers below take their exactness from it
- `Not<B>`, `And<T, R?>`, `Or<T, R?>`, `Xor<T, R?>` – type-level boolean algebra over an array of operands or a single one (`R` folds in one more either way), three-valued: an indeterminate `boolean` operand propagates unless an absorbing operand settles the result anyway (`false` for `And`, `true` for `Or`; `Xor` has none). Empty `And` is `true`, empty `Or` and `Xor` `false`. Fixed elements at either end of an open tuple participate; its runtime middle is evaluated conservatively

## Array Utilities

Const-preserving array operations that maintain tuple types through transformations.

### Type-Preserving Map

```typescript
const tup = [1, 2, 3] as const;
tup.map(x => x.toString());     // => string[] (loses tuple structure)
mapTo(tup)(x => x.toString());  // => readonly [string, string, string]
mapTo(1)(x => x.toString());    // => string (also works on scalars)
```

`mapTo` is curried so that the subject fixes the element type before the callback is inferred. A runtime array maps to a plain array, a scalar to a scalar. The callback receives the value alone either way – not `Array.prototype.map`'s index and array – so a callback with an optional second parameter (`parseInt`) behaves the same on both. `MapTo<P>` is the curried function's type.

### Entries

```typescript
entries([10, 20, 30]);          // => [[0, 10], [1, 20], [2, 30]]
valueIndexEntries(["a", "b"]);  // => [["a", 0], ["b", 1]]
```

### Transformations

```typescript
range(3);                                 // => [0, 1, 2]
flatten([[1, 2], [3]]);                   // => [1, 2, 3]
chunk([1, 2, 3, 4, 5], 2);                // => [[1, 2], [3, 4], [5]]
zip([["a", "b"], [1, 2]]);                // => [["a", 1], ["b", 2]]
column([["a", 1], ["b", 2]], 0);          // => ["a", "b"]
pickWithOrder(["a", "b", "c"], [2, 0]);   // => ["c", "a"]
filterIndexes(["a", "b", "c"], [0, 2]);   // => ["a", "c"]
filterIndexes(["a", "b", "c"], 1);        // => ["b"]  (bare index also accepted)
filterIndexes(["a", "b", "c"], 1, true);  // => ["a", "c"]  (exclude instead of keep)
```

### Guards

- `isArray(val)` – narrows to `RoArray`
- `isUint8Array(val)` – works across realms (unlike `instanceof`)

### Types

- `TupleRange<L>` / `Range<L>` – `[0, 1, ..., L-1]`; a negative or fractional `L` is no length at all and yields `never` in either shape
- `TupleOfLength<T, L>` / `OfLength<T, L>` – `L` elements of type `T`; `RoTupleOfLength` / `RoOfLength` are their readonly forms
- `Flatten<A>`, `InnerFlatten<A>`, `Unflatten<A>`
- `Chunk<A, N>`, `Zip<A>`, `Column<A, I>`
- `Entries<A>`, `ValueIndexEntries<A>`
- `PickWithOrder<A, I>`, `FilterIndexes<A, I, FilterOut>`
- `MaybeArray<T>`, `ElementOf<P>` – a value or an array thereof, and its inverse
- `MapArrayness<P, R>` – map a result type over `P`'s arrayness (scalar → scalar, tuple → tuple)
- `Cartesian<L, R>` – Cartesian product type
- `IsRectangular<T>` – whether a 2D tuple has uniform row lengths
- `IsArray<T>`, `IsFlat<A>` – array / no-nested-arrays predicates; `PreserveReadonly<A, R>` – `R` made readonly iff `A` is

The tuple-promising twins `TupleEntries`, `ValueIndexTupleEntries`, `TupleFlatten`, `TupleChunk`, `TupleZip` and `TuplePickWithOrder` follow the naming convention above.

## Object Utilities

Type-safe object manipulation. Key arguments take a single key or a tuple of keys, and the result types are exact for exactly those: a union key or a runtime array may select any subset, so `pick` and `nest` then make the selected keys optional and `replace` lets the replaced key keep its old value. `fromEntries` keeps keys guaranteed by tuple entries required; literal keys supplied only by union keys or runtime arrays are optional, including those in an open tuple's tail. Numeric keys become strings, as in `Object.fromEntries`. If completeness is known outside the types, the caller can assert `Required<typeof result>`.

```typescript
fromEntries([["a", 1], ["b", 2]]);            // => { a: 1, b: 2 }

pick({ a: 1, b: 2, c: 3 }, ["a", "b"]);       // => { readonly a: 1, readonly b: 2 }
omit({ a: 1, b: 2, c: 3 }, "c");              // => { readonly a: 1, readonly b: 2 }
omitUndefined({ a: 1, b: undefined });        // => { readonly a: 1 }
replace({ a: 1, b: 2 }, "a", "new");          // => { readonly a: "new", readonly b: 2 }
merge({ a: 1 }, { a: 2, b: 3 });              // => { readonly a: 1, readonly b: 3 }

spread({ a: 1, n: { b: 2, c: 3 } }, "n");     // => { readonly a: 1, readonly b: 2, readonly c: 3 }
nest({ a: 1, b: 2, c: 3 }, "n", ["b", "c"]);  // => { readonly a: 1, n: { readonly b: 2, readonly c: 3 } }
```

`merge(preferred, fallback)` is `{ ...fallback, ...preferred }` with a type that survives generics: TypeScript types a spread of a generic type parameter against the parameter's constraint, leaking the constraint's optional keys and widening the caller's literals, while `Merge` is built from mapped types and stays deferred. `preferred` wins on shared keys; an optional preferred key that is absent lets the fallback's value show through, and the fallback's modifier then decides whether the key is guaranteed. A preferred key holding `undefined` wins like any other value – pass `omitUndefined(preferred)` to let the fallback show through instead, which its type then states. For a consumer without `exactOptionalPropertyTypes`, whose optional keys may hold `undefined`, a shared key that is optional in `preferred` stays optional in the result.

The fallback admits `undefined`, so an optional options bag passes straight through. An omitted optional parameter infers its type parameter's default, which keeps the result exact; a fallback *variable* typed `X | undefined`, however, infers `X`, and the result claims `X`'s keys even when the variable holds `undefined`.

`omitUndefined` is the runtime counterpart of `Opts`: in the result type, keys that may hold `undefined` become optional and keys that hold nothing else disappear, so the result spreads over a base record without clobbering its fields. `spread` rejects a nested object whose keys collide with the remaining outer keys, and `nest` a new key that collides with a remaining one – either would have to shadow.

### Deep Paths

```typescript
const obj = {
  outer: {
    a: { x: 1, y: 2 },
    b: { x: 3, y: 4 },
  },
};

deepOmit(obj, ["outer", anyKey, "y"]);            // y gone from every child of outer
deepReplace(obj, ["outer", anyKey, "y"], 0);      // y replaced in every child
deepOmit(obj, ["outer", "a", ["x", "y"]]);        // several keys at the last position
deepOmit(obj, [["outer", "a"], ["outer", "b"]]);  // a list of paths
deepReplace(obj, [
  [["outer", "a", "x"], 10],
  [["outer", "b", "x"], 30],
]);  // [path, value] pairs
```

A path is a tuple of keys. The `anyKey` wildcard traverses every property of an object and every element of an array; as the final element it replaces all of them, and removes every key of an object (an array keeps its elements: deletion has no element analogue). Named keys address plain objects only: arrays are traversed by `anyKey` alone and left untouched otherwise, as are primitives. Both functions return a new object, and with tuple paths the result type mirrors those rules exactly; a runtime (non-tuple) path could have reached anything, so the result is `unknown` and the caller states what it knows.

### Types

- `Get<O, K>` – `O[K]` for a definitely-present key, `undefined` for an optional or absent one (a value merely annotated with an optional key may lack it); distributes over unions of objects
- `TrueKeys<O>` – the keys of a boolean record that map to `true`; the type-level "filter keys by predicate"
- `OmitUndefined<O>`, `Replace<O, K, V>`, `Merge<T, U>`, `Spread<O, K>`, `Nest<O, NK, K>`, `DeepOmit<O, P>`, `DeepReplace<O, P, V>`, `FromEntries<A>` – the result types of the functions above; `TupleFromEntries<T>` is `FromEntries`' exact form for a tuple of entries
- `ObjectEntry<K, V>` – a key/value pair

## Const Maps

`constMap` builds type-safe lookup functions from a single hierarchical const spec. The lookups are resolved at the type level: keys are the literal unions taken from the spec, and results are the literal types of the matching cells.

### Example

```typescript
const units = [[
  "si", [
    ["length",   "m"],
    ["mass",    "kg"],
    ["speed",  "m/s"],
  ]], [
  "nautical", [
    ["length", "nmi"],
    ["speed",   "kn"],
  ]]
] as const satisfies MapLevels<[string, string, string]>;
```

`as const` is needed only because the spec is its own declaration – arguments passed inline to `constMap` get their const context from its type parameter. The `satisfies` is optional; it surfaces a malformed spec at the declaration rather than at every use of it. `MapLevels` states one type per column – the row type, in effect – whereas the laxer `MappingEntries` only asserts that the spec is built from key/value pairs at all.

The nesting is shorthand – the spec denotes the row list

```typescript
[
  ["si",       "length",   "m"],
  ["si",       "mass",    "kg"],
  ["si",       "speed",  "m/s"],
  ["nautical", "length", "nmi"],
  ["nautical", "speed",   "kn"],
]
```

and every mapping below is one way of reading those rows: which columns are the keys, and which are the value.

### Usage

```typescript
const unitSymbol = constMap(units);

unitSymbol("si", "length");         // => "m"
unitSymbol("nautical", "speed");    // => "kn"

unitSymbol.has("nautical", "mass"); // => false
unitSymbol.get("nautical", "mass"); // => undefined

const siUnit = unitSymbol.subMap("si");
siUnit("mass");                     // => "kg"
```

The `// =>` comments state types, not merely runtime values: `unitSymbol("si", "length")` is the literal `"m"`, never `string`. Keys are equally strict – the first argument is `"si" | "nautical"`, and the union accepted for the second depends on what the first was, so `unitSymbol("nautical", "mass")` does not compile.

`has` and `get` are the loose counterparts for keys that aren't statically known: they accept the widened key types (plain `string` here) and correspondingly return an unnarrowed result – `boolean` for `has`, and for `get` the union of every value in the map, plus `undefined`.

So a const map behaves like a nested const object, except that one spec yields arbitrarily many of them, and that its keys aren't limited to what an object can index.

### Custom Shapes

A shape is `[key columns, value columns]` and defaults to "every column but the last is a key", read one-to-one: a key path that repeats under the default shape throws, since the spec is taken as it is, one leaf per row. Grouping is what an explicit shape is for:

```typescript
// unit symbol -> [system, quantity]
const systemAndQuantity = constMap(units, [2, [0, 1]]);
systemAndQuantity("kn");  // => ["nautical", "speed"]

// quantity -> systems (one-to-many)
const systems = constMap(units, [1, 0]);
systems("length");        // => ["si", "nautical"]
systems("mass");          // => ["si"]
```

One-to-many lookups return the distinct values of their key group – repeated rows collapse into one. If every key group ends up with exactly one value, the arrays are unwrapped and the map is a plain one-to-one mapping, which is why `systemAndQuantity` yields the row itself rather than a list of rows. `subMap` is available whenever more than one key column remains.

Keys may also be `number`, `bigint` or `boolean`, none of which a plain object can index without coercing it to a string:

```typescript
const strongTyping = [
  [1n,    "bigint"],
  [1,     "number"],
  ["1",   "string"],
  [true, "boolean"],
] as const;

const keyType = constMap(strongTyping);
keyType(1n);         // => "bigint"
keyType(1);          // => "number" (an object would collapse all three onto "1")
keyType("1");        // => "string"

const inverse = constMap(strongTyping, [1, 0]);
inverse("bigint");   // => 1n (a bigint, not the "1" an object would have stored)
inverse("number");   // => 1
inverse("boolean");  // => true
```

Up to 4 key columns are supported.

### Exports

- `constMap(entries, shape?)` – build the mapping
- `ConstMap<Entries, Shape?>` – the type of the resulting mapping
- `MappingEntries` / `MappingEntry` – shape-only spec constraint: key/value pairs, any nesting
- `MapLevel<K, V>` / `MapLevels<[K1, K2, ..., V]>` – spec constraints that also fix the column types
- `ShapeLike` – the shape parameter type
- `MappableKey` – `PropertyKey | bigint | boolean`

## String Utilities

Type-preserving string case functions, plus prefix stripping.

```typescript
uppercase("hello");        // => "HELLO" (typed as Uppercase<"hello">)
lowercase("HELLO");        // => "hello"
capitalize("hello");       // => "Hello"
uncapitalize("Hello");     // => "hello"
otherCap("hello");         // => "Hello" (toggles first letter case)
stripPrefix("0x", "0x1f"); // => "1f" (typed as "1f"; an absent prefix is not an error)
```

`StripPrefix<P, S>` and `OtherCap<S>` are the type-level twins TypeScript has no built-in for.

## Piping

Function composition with a type-safe `pipe`, and the stage builders, assertions and predicates that go with it.

### Composition

- `pipe(f, g, h)` – compose functions left-to-right: `A → B → C → D` becomes `A → D`. A chain whose links don't fit is a type error; the composed function takes the parameters of `f`, however many. `Pipe<FT>` is the composed function's type.
- `identity(val)` – pass-through, useful as a default in generic pipelines
- `raise(msgOrError)` – throw as an expression, typed `never`: `x ?? raise("missing")`

The stage builders are curried and data-last, so they drop straight into a `pipe`:

- `tap(fn)(val)` – run a side effect, return `val`
- `tryOr(fallback)(fn)(val)` – `fn(val)`, or `fallback` if it throws
- `fallback(dflt)(val)` – `val`, or `dflt` if `val` is nullish

`map(val, fn)` – apply `fn` unless `val` is nullish, which passes through (the result carries exactly the nullish constituents `val` had) – is a direct call like the assertions below, not a stage builder.

### Guarded Assertions

- `ensure(val, pred, msg?)` – return `val` if `pred` passes, throw otherwise. Narrows type when given a type guard.
- `forbid(val, pred, msg?)` – return `val` if `pred` fails, throw otherwise. Narrows to `Exclude<T, U>` with a type guard.
- `throwOnUndefined(val, msg?)` / `throwOnNullish(val, msg?)` – convenience wrappers

`msg` is a string or a `(val) => string`, evaluated only on failure.

### Predicates

- `isUndefined`, `isNullish`, `isDefined`, `exists` – type guards
- `and(...preds)`, `or(...preds)` – predicate combinators
- `not(val)` – negates a boolean value (not a predicate)
- `succeeds(fn)` / `throws(fn)` – test whether a function throws

## Branding

Brands make nominally distinct types out of one structural type. To the compiler, `type UserId = string` and `type ProductId = string` are the same type; a brand on each keeps their values apart while the runtime representation stays a plain `string`.

### Hierarchical Tag Accumulation

Tags accumulate: branding an already-branded type adds the new tag to its existing set rather than replacing it:

```typescript
type UserId = Brand<string, "UserId">;
type AdminId = Brand<UserId, "AdminId">; // AdminId now has both "UserId" and "AdminId" tags
```

So a more specific brand is a subtype of its parent brand and passes wherever the parent is expected:

```typescript
function processUser(userId: UserId): void;
processUser(adminId); // works because AdminId is a subtype of UserId
```

### The `brand` Function

`brand` is the identity at runtime and brands the value's inferred type – there is no need to spell the type out:

```typescript
const config = brand<"Config">()({ retries: 3, urls: ["a", "b"] });
// => Brand<{ readonly retries: 3; readonly urls: readonly ["a", "b"] }, "Config">
```

The two calls are the workaround for TypeScript's all-or-nothing type arguments: the first fixes the tag, the second infers the value's type. The tag parameter also takes a branded type, whose tags are inherited instead – `brand<UserId>()("abc")` carries the tag `"UserId"`.

### Exports

- `Brand<T, Tag>` – apply a tag (or a union of tags) to a type; bare `Brand` accepts any branded value and serves as the "some brand" constraint
- `Branded<Base, Tags>` – the tag-carrying structure `Brand` intersects onto the base
- `Unbrand<T>` – strip branding, recover the base type
- `ExtractTags<T>` – get the tags from a branded type
- `IsBranded<T>` – check if a type is branded
- `SameBrand<T, U>` – whether two types carry identical tag sets (two unbranded types qualify)
- `PreserveBrand<T, R>` – `R` carrying `T`'s tags; plain `R` when `T` is unbranded, `never` when `T`'s base does not extend `R`
- `brand<Tag>()` – runtime branding function

## Aliasing

A hack to make large union types more readable in IDE tooltips. TypeScript prints a union alias like `type Letter = "a" | "b" | … | "z"` fully expanded in hovers; an interface, unlike an alias, keeps its name, so the union is routed through one:

```typescript
type Letter = "a" | "b" | "c" | "d" | "e" | "f";
interface AllLetters extends SuppressExpansion<Letter> {}

interface LetterAliases {
  AllLetters: [Letter, AllLetters];
}

type Test = ApplyAliases<LetterAliases, Letter>; // => keyof AllLetters (not expanded)
```

Subsets are registered by merging into the same aliases interface:

```typescript
interface Vowels extends SuppressExpansion<"a" | "e"> {}
interface LetterAliases {
  Vowels: ["a" | "e", Vowels];
}

type Test = ApplyAliases<LetterAliases, "a" | "e" | "f">; // => keyof Vowels | "f"
```

A registered subset always beats raw members, which is what makes `"a" | "e" | "f"` unambiguous. When a union can be covered equally well by several combinations of registered subsets, no choice is made and it comes back expanded.

### Exports

- `SuppressExpansion<T>` – create an interface that suppresses union expansion
- `ApplyAliases<Aliases, Union>` – apply registered aliases to a union
- `Expand<A>` – re-expand an alias back to its union

## Encoding

`encode` goes into the encoding its group names and `decode` comes back out of it, so `hex.encode` turns bytes into a hex string while `utf8.encode` turns text into UTF-8 bytes – the medium is a property of the encoding, not a break in the convention. Conversions that aren't encodings spell their direction out instead: `bignum.fromHex`, `bignum.toBytes`.

### hex

```typescript
hex.decode("deadbeef");             // => Uint8Array
hex.decode("0xdeadbeef");           // => Uint8Array (0x prefix stripped)
hex.encode(arr);                    // => "deadbeef"
hex.encode(arr, true);              // => "0xdeadbeef"
hex.isValid("0xdeadbeef");          // => true
hex.stripPrefix("0xdeadbeef");      // => "deadbeef"
```

`isValid` is true exactly when `decode` succeeds, i.e. even-numbered digit count, no stray characters. `stripPrefix` only knows `0x`; the generic one is under [String Utilities](#string-utilities).

### utf8

```typescript
utf8.encode("hello");               // => Uint8Array (UTF-8)
utf8.decode(arr);                   // => "hello" (lossy: invalid sequences become U+FFFD)
```

That replacement is the only loss: a leading U+FEFF decodes as the character it is, where `TextDecoder` would by default strip it as a document's byte order mark.

### base64

```typescript
base64.decode("SGVsbG8=");          // => Uint8Array
base64.encode(arr);                 // => "SGVsbG8="
base64.isValid("SGVsbG8=");         // => true
```

base64 is the padded, standard-alphabet variant, and, like `hex`, `isValid` is true exactly when `decode` succeeds — so unpadded input, non-zero trailing bits, and the ASCII whitespace that `Uint8Array.fromBase64` would otherwise skip over are all rejected.

base58 has no `Uint8Array` builtin behind it and only Solana asks for it, so it ships from [`@onrail-xyz/svm`](../svm) instead.

### bignum

Conversions between bigint and its hex, byte, and number representations.

```typescript
bignum.fromHex("0xff");             // => 255n
bignum.fromHex("ff");               // => 255n (hex whether or not the prefix is there)
bignum.fromHex("", true);           // => 0n (empty input only allowed if emptyIsZero)
bignum.toHex(255n);                 // => "ff"
bignum.toHex(255n, true);           // => "0xff"
bignum.fromBytes(arr);              // => bigint from big endian bytes
bignum.toBytes(255n);               // => Uint8Array([0xff])
bignum.toBytes(255n, 4);            // => Uint8Array([0, 0, 0, 0xff]) (zero-padded)
bignum.fromNumber(255);             // => 255n (throws if not a safe integer)
bignum.toNumber(255n);              // => 255 (throws if out of safe integer range)
```

`fromHex` inverts `toHex` in both of its spellings, and takes hex digits only, an odd count included: whitespace anywhere throws. Hex output is byte aligned and unsigned: `toHex(1n)` is `"01"`, and negative inputs throw, in `toBytes` too.

## Bytes

```typescript
bytes.equals(a, b);                 // => true/false
bytes.zpad(arr, 32);                // => zero-padded to 32 bytes (left)
bytes.zpad(arr, 32, false);         // => zero-padded to 32 bytes (right)
bytes.concat(a, b, c);              // => concatenated Uint8Array
```

## JSON Codecs

JSON cannot natively carry bigints, bytes, dates, Maps, ... `jsonStringify`/`jsonParse` can be taught any such type via codecs: values a codec claims travel as `{ $type: tag, value: encoded }` and come back as what they were.

```typescript
const obj = { amount: 123456789012345678901234567890n, data: new Uint8Array([1, 2, 3]) };

const json = jsonStringify(obj, [bigintCodec, bytesCodec]);
// => '{"amount":{"$type":"bigint","value":"123456789012345678901234567890"},
//      "data":{"$type":"Uint8Array","value":"010203"}}'

jsonParse(json, [bigintCodec, bytesCodec]);
// => the original, exactly
```

Round-tripping is **total** over what `JSON.stringify` itself carries: genuine data that happens to look like the wire format survives, because keys matching `/^\$+type$/` are escaped with one more `$` on the way out and unescaped on the way back in. Values `JSON.stringify` special-cases are treated as it treats them: a boxed primitive (`new String(…)`) is serialized as the primitive it holds, and `JSON.rawJSON(…)` text is emitted verbatim. What native JSON loses stays lost — an `undefined`-valued property is dropped, a non-finite number becomes `null` — and a top-level value with no JSON representation throws. Parsing a tag with no registered codec throws rather than handing back the wire object.

The contract with codecs: they are consulted in order and the first to claim a value wins, both ways, so tags are distinct within one codec list; a codec's `encode` and `decode` invert each other, which is what makes the round trip exact; and a codec sees the value before its `toJSON` does, so `dateCodec` gets the `Date` and not the string. `toJSON` itself works as under `JSON.stringify`: called once, with the property key, and its result is serialized as the value.

Ships with `bigintCodec`, `bytesCodec` (hex), and `dateCodec` (ISO; an Invalid Date travels as `null`). Both of the latter recognize their values across realms. Packages provide codecs for their own types (`@onrail-xyz/amount` has `amountCodec`, `rateCodec`, `rationalCodec`). A codec is four fields — writing your own is a five-liner, and encoded payloads are themselves walked, so codecs compose (a `Map` codec whose entries contain bigints just works):

```typescript
const mapCodec: JsonCodec<Map<unknown, unknown>> = {
  tag:    "Map",
  test:   (v): v is Map<unknown, unknown> => v instanceof Map,
  encode: v => [...v.entries()],
  decode: e => new Map(e as [unknown, unknown][]),
};
```

A codec's `decode` receives an already-decoded payload, which it should not trust. `expectString(encoded, tag)` returns it as a string or throws, and `invalidPayload(encoded, tag)` builds the error for any other rejection, describing the payload whatever it holds.

`jsonStringify` also takes `{ space, sortKeys }` — `sortKeys` canonicalizes key order recursively, for use as a deterministic object key.

## Time

Unix seconds ↔ `Date`, without JavaScript's silent `Invalid Date` failure mode.

```typescript
unixTime.toDate(1700000000);        // number or bigint seconds → Date
unixTime.toDate(2n ** 256n - 1n);   // throws (outside Date's ±8.64e15 ms range)

unixTime.fromDate(new Date());      // → number, floored to whole seconds
BigInt(unixTime.fromDate(date));    // for bigint-sized timestamp fields

checkedDate("2024-01-01T00:00:00Z"); // ms or parseable string → Date, throws if invalid
```

`msPerSecond` and `dateRangeMs` (8.64e15, the ±range ECMA-262 fixes for `Date`, which exports no constant for it) are the numbers these conversions check against.

## Assertions

Simple runtime checks that throw on failure.

```typescript
assertEqual(a, b);                  // throws if a !== b
assertEqual(a, b, "custom message");

assertDistinct(1, 2, 3);            // ok
assertDistinct(1, 2, 2);            // throws "Values are not distinct: 1, 2, 2"
```

## Limits

Const maps take up to 4 key columns (see [Const Maps](#const-maps)), and are meant for tables of bounded size. The default shape takes the spec as it is and handles thousands of rows, but an explicit shape regroups the rows at the type level, and that exhausts the instantiation budget (below) much sooner: a plain two-column inversion compiles at 600 rows and fails at 700 (TS 7.0, otherwise empty program), with more columns or duplicate-heavy data lowering the ceiling further. A table that grows with its domain – every token on every chain – belongs in a runtime `Map`.

Type-level recursion is bounded by the compiler's instantiation budget, and the budget is shared with everything else the compilation instantiates, so the ceilings are ranges rather than numbers. Tail-recursive walks (`Range`, `TupleOfLength`) reach several hundred elements – just under 1,000 in an otherwise empty program (TS 7.0: `Range<996>` compiles, `Range<998>` does not). Walks that rebuild a tuple around the recursive call – `Flatten`, `TupleChunk` – cap out roughly an order of magnitude sooner (flattening a 60-element tuple compiles in isolation, a 70-element one does not). Past the ceiling the compiler reports "Type instantiation is excessively deep and possibly infinite" and the type degrades to `any`.

## Future Direction

> **Status:** designed but not implemented. Nothing in this section is exported today; the mutability helpers currently carry the fixed arm list described above.

The mutability helpers walk anything structural, which is correct for plain data and wrong for a type whose identity is nominal: the walk expands it into its members, and the result no longer assigns back to what it came from. The set of types exempt from the walk — its *leaves* — is a fixed list in the helpers themselves (`Primitive`, `RoUint8Array`, `Function`), so a consumer with a nominal object type of its own has no way to add to it. The design that addresses this is an open registry, recorded here until it ships.

A registry interface, parameterized by the type being walked, is merged into by whoever owns a leaf type. The parameter is what makes it more than a list of opaque types: an entry's result is a type expression in `T`, so an entry can `infer` through its match rather than only suppress the walk. Each entry carries one result per direction, which is what keeps the readonly and mutable helpers from drifting apart. The gate then replaces the arm list outright:

```typescript
type DeepRo<T> =
  IsAny<T> extends true ? any
  : T extends LeafMatch<T> ? LeafRo<T>
  : T extends object ? { readonly [K in keyof T]: DeepRo<T[K]> } : T;
```

Two properties of that shape are load-bearing and easy to lose. The gate must be a naked `T extends LeafMatch<T>`, so that the conditional distributes and each union constituent is matched and resolved on its own; a non-distributive gate — testing whether a lookup came back `never` — silently returns the *unregistered* arms of a union unwalked, which surfaces far from the registration that caused it. And `object` stays the structural fallthrough rather than becoming an entry, which is what removes the need for precedence: the current arm list only orders `Function` ahead of `object` because both are arms, and with `object` out of the registry there is nothing left to order against.

What remains is overlap between two leaves whose matches intersect and whose results disagree: the lookup unions both answers instead of reporting a conflict. Matches are required to be disjoint, and that obligation is documented rather than enforced — there is no cheap type-level way to state it. Should precedence become necessary, resolving by specificity (among matching entries, the one whose match extends the others) is preferable to declared ordering, which would force independent registrants to coordinate slot numbers.

A registry is the right shape here rather than a `Leaves` type parameter, because which types are leaves is ambient rather than per-call-site. A parameter would have to be threaded through every intermediate that composes a helper over a caller-supplied type, and its default is silently wrong rather than a type error, so an intermediate that fails to forward it produces a mangled type with no diagnostic. The cost of the registry is the mirror image: a registration is program-wide, reaching every consumer of the package that made it.

This is parked rather than built because the primitive arm removed every concrete case on hand — branded primitives are the bulk of them, and they now pass through without registration. It waits on a nominal *object* type that a consumer needs left intact.
