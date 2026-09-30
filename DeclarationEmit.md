# Declaration emit: keeping type names alive in `.d.ts` files

Enforcement: [scripts/check-dist-types.mjs](./scripts/check-dist-types.mjs), which guards every package's `dist`.

Worked examples:

* [packages/evm/src/layouting.ts](./packages/evm/src/layouting.ts): `SigSwitcher`, `PaddedItem`, `AbiParam`, and `AddressItem`;
* [packages/evm/src/parsing.ts](./packages/evm/src/parsing.ts): `ParsedError` and `ParsedEvent`;
* [packages/svm/src/layouting.ts](./packages/svm/src/layouting.ts): `LamportsItem`, `DefaultOptionItem`, and `DiscriminatedItem`;
* [packages/svm/src/client.ts](./packages/svm/src/client.ts): `GetTokenAccount` and `BoundClient`;
* [packages/binary-layout/src/layout.ts](./packages/binary-layout/src/layout.ts): `Conversion`;
* [packages/common/src/layouting.ts](./packages/common/src/layouting.ts): the remaining `AmountItem` limitation.

Everything below was measured under TypeScript 7.0.2.

The exact places where the checker retains an alias symbol are implementation details, but the broad distinction is not a compiler bug: declaration emit can print either a name still present in the checker type or the anonymous structure that remains after that name has been resolved away. The techniques in this document arrange for the former.

# The Problem

The first consumer of these packages, the contract SDK measured throughout this document, saw its typecheck go from approximately five seconds to not finishing within ninety.

Nothing in this repository had complained:

* every package compiled;
* every test passed;
* the runtime JavaScript was unchanged;
* the source types looked reasonably factored.

The published declarations showed the damage.

Two partial applications of EVM's `sigSwitchItem`, left to inference, had emitted 516 KB of declarations. The inferred return of `paddedItem` emitted another 252 KB.

Those files were not merely verbose descriptions of otherwise cheap types. They had replaced reusable named computations with repeated anonymous copies of those computations.

The consumer's checker therefore had far more work to do than the source repository's checker.

That is the central danger:

```text
well-factored source types
        |
        | declaration emit loses their names
        v
repeated anonymous type machinery in dist
        |
        | every consumer checks the dist
        v
consumer typechecking becomes catastrophically slow
```

The JavaScript can be perfect while the type-level artifact shipped beside it is pathological.

---

## Declaration emit does not reproduce the history of inference

Consider:

```typescript
type Point = { x: number, y: number };

export const origin: Point = { x: 0, y: 0 };
export const shifted = { ...origin, x: 1 };
```

`Point` is the intended reusable shape behind both values.

That does not mean both declarations emit using `Point`:

```typescript
export declare const origin: Point;
export declare const shifted: {
  x: number;
  y: number;
};
```

`origin` has a written annotation at the declaration being emitted, so the emitter can reproduce that annotation.

`shifted` does not. The spread creates a new object type. That type has the same members as `Point`, but the checker does not retain a provenance chain saying:

> This anonymous object happened to begin with something once annotated as `Point`, so please print that name later.

Declaration emit works from the declaration syntax and checker types that exist at the export boundary. It does not replay the source operations that produced them.

This gives us the first rule:

> A source alias matters to declaration emit only if the emitter still has either the written alias reference or a checker type that carries the alias's name.

Merely defining or exporting an alias does not cause structurally equivalent types elsewhere to emit by that alias.

---

## The two ways a name reaches a declaration

For the problems in this repository, a useful name reaches the emitted `.d.ts` through one of two routes.

### Route 1: the declaration has a written annotation

```typescript
type Boxed<T> = { value: T };

export const one: Boxed<number> = { value: 1 };
```

The emitter has the annotation node itself and can print:

```typescript
export declare const one: Boxed<number>;
```

This route is local.

It applies to the declaration on which the annotation is written. If the value later participates in inference for another declaration, the annotation syntax does not travel with it.

### Route 2: the checker type itself carries a name

```typescript
type Boxed<T> = { value: T };

const box = <T>(value: T): Boxed<T> => ({ value });

export const one = box(1);
export const carried = { one };
```

Here the instantiated checker type returned by `box` retains the alias identity `Boxed<number>`.

That type flows through the second object literal, so the declarations can emit as:

```typescript
export declare const one: Boxed<number>;
export declare const carried: {
  one: Boxed<number>;
};
```

This route travels because the name belongs to the checker type being propagated, not to syntax left behind at an earlier declaration.

The compiler implementation represents one important form of this with an `aliasSymbol` on the instantiated type. Interfaces and classes carry declaration symbols of their own.

The distinction can be summarized as:

```text
written annotation at emitted declaration
              |
              v
     emitter prints its syntax


inferred declaration
        |
        v
checker type reaching the boundary
        |
        +-- still carries a name --> print the name
        |
        `-- anonymous structure --> print the structure
```

The rest of this document is about controlling which branch we reach.

---

## Why the expansion is slow, not merely ugly

Suppose a source type contains a reusable computation:

```typescript
Alias<X>
```

The checker can cache the alias instantiation by the alias and its resolved arguments. Many uses of the same instantiation can share that work.

If declaration emit instead writes the evaluated machinery as anonymous syntax at every embedding site, the consumer sees many distinct type nodes. The computations are now situated under the mappers of their enclosing declarations and must be related or instantiated there.

The byte count is therefore only the visible symptom.

The actual regression is loss of a useful identity and its associated reuse.

In the EVM package, the measured cost was approximately 1.5 seconds per switch variant. That is how a consumer which previously checked in about five seconds stopped finishing within ninety.

The failure is especially vicious because declaration generation itself may remain fast. The producer pays once for its in-memory checker types; every consumer later pays for the anonymously reified version.

---

# The Solution

The complete strategy has three levels.

1. **If one emitted declaration expands deeply, annotate that boundary.** The emitter can print the annotation directly.
2. **If a type will flow into many inferred declarations, give the checker type a name that survives the trip.** A function or object alias does it; an interface is for a shape composed by heritage clauses, or for absorbing an inferred return (Step 6).
3. **Inspect and guard the emitted declarations.** None of these failures is reliably visible from source.

Each level has traps.

The next sections build the model in order: Steps 1 to 3 are the first level and its traps, Steps 4 to 7 the second, and Detection the third.

---

## Step 1: State the type at the boundary that ships

The simplest fix for a bloated declaration is an explicit return annotation.

`sigSwitchItem` is a curried factory whose inner return depends on a mapped tuple of signature variants. Left to inference, its type expands the complete `switchItem` machinery:

```typescript
export const sigSwitchItem = <IS extends number, T extends string>(
  idSize: IS,
  tag: T,
) => <const V extends SigVariants>(variants: V) =>
  switchItem(/* ... */);
```

The reusable public contract is named instead:

```typescript
export type SigSwitcher<IS extends number, T extends string> =
  <const V extends SigVariants>(variants: V) =>
    ReturnType<
      typeof switchItem<
        T,
        ReturnType<typeof uintItem<IS, {}>>,
        SigRowsBound<IS, V>,
        {}
      >
    >;

export const sigSwitchItem = <IS extends number, T extends string>(
  idSize: IS,
  tag: T,
): SigSwitcher<IS, T> => <const V extends SigVariants>(variants: V) =>
  switchItem(/* ... */);
```

The emitted declaration is now bounded by the annotation:

```typescript
export declare const sigSwitchItem:
  <IS extends number, T extends string>(
    idSize: IS,
    tag: T,
  ) => SigSwitcher<IS, T>;
```

Partial applications inherit the name:

```typescript
const errorSwitchItem = sigSwitchItem(selectorLength, "error");
const eventSwitchItem = sigSwitchItem(wordSize, "event");
```

and emit as:

```typescript
declare const errorSwitchItem:
  import("./layouting.js").SigSwitcher<4, "error">;
declare const eventSwitchItem:
  import("./layouting.js").SigSwitcher<32, "event">;
```

rather than as two copies of the complete inferred switch type.

The parser results are likewise named at the point where they are returned:

```typescript
export type ParsedError<V extends SigVariants> =
  DeriveType<ReturnType<typeof errorSwitchItem<V>>>;

export const buildParseError = <const V extends SigVariants>(errorDefs: V) => {
  const item = errorSwitchItem(errorDefs);

  return (revertData: RoUint8Array): ParsedError<V> => {
    // ...
    return deserialize(item, revertData);
  };
};
```

There is no prize for making the emitter rediscover a public contract that the source already knows.

If an inferred boundary prints a deep expansion, write the contract there.

---

## Step 2: Write the intended generic instantiation

An annotation helps only if it denotes the intended type.

Two TypeScript behaviors matter here.

### `ReturnType<typeof f>` does not use call defaults

Consider:

```typescript
declare const f:
  <T extends number = 42>() => { value: T };
```

This does not use the default `42`:

```typescript
type A = ReturnType<typeof f>;
//   ^? { value: number }
```

To obtain the intended instantiation, it must be supplied explicitly:

```typescript
type B = ReturnType<typeof f<42>>;
//   ^? { value: 42 }
```

`infer R` reads the return of an uninstantiated generic function with its parameters at their constraints. The call default is not selected.

The outcome can be worse than a wide result. When the return at the default is not assignable to the return at the constraint, the match itself can fail:

```typescript
declare const g:
  <T extends number = 42>() =>
    number extends T ? "wide" : "narrow";

type C = ReturnType<typeof g>;
//   ^? any
```

Nothing infers `any` here. `ReturnType<T>` is `T extends (...args: any) => infer R ? R : any`, and for `g` the `extends` test fails, so `C` is that fallback branch. The observed behavior is consistent with the inferred `R` being read at the constraint (`"wide"`) while the check instantiates the default (`"narrow"`), which is not assignable to it; the declaration without a default matches. `ReturnType<typeof g<42>>` is `"narrow"` as intended.

That is why `SigSwitcher` writes:

```typescript
ReturnType<typeof uintItem<IS, {}>>
```

with the second `{}` argument explicit.

The intended type is an instantiation of `uintItem`, not the constraint-level return obtained from bare:

```typescript
ReturnType<typeof uintItem>
```

The general rule is:

> If a type expression refers to a generic function as a value, instantiate every generic parameter whose particular value matters. Do not expect call defaults to participate.

### Sometimes the public contract already contains the right type

`defaultOptionItem` converts a derived option representation:

```typescript
type BaseDefaultOption<L extends Layout> =
  DeriveType<ReturnType<typeof baseDefaultOptionLayout<L>>>;
```

At a concrete `L`, the value field has type `DeriveType<L>`.

At an open `L`, TypeScript cannot reduce the indexed and conditional machinery far enough to prove that relationship in the implementation:

```typescript
obj.value
```

The conversion contract already states the intended surfaced type, so the implementation annotates to that contract:

```typescript
to: (obj: BaseDefaultOption<L>): DeriveType<L> | undefined =>
  obj.isSome ? obj.value as DeriveType<L> : undefined,
```

The cast is not inventing a relationship. It records one that holds for every concrete `L` but remains opaque to the checker while `L` is open.

This is preferable to letting the unresolved indexed access become part of an inferred declaration.

---

## Step 3: Equivalent inputs may not produce relatable suspended results

The previous section concerned choosing the right annotation expression.

There is a second issue: the function body must actually produce that exact generic instantiation.

`discriminatedItem` exposes the problem.

### The machinery inside `unwrapSingleton`

`unwrapSingleton` is generic in the struct it receives:

```typescript
export const unwrapSingleton = <const S extends Struct>(
  layout: S,
): UnwrapSingleton<S> => {
  // ...
};
```

Its return is computed from `S` through mapped and conditional types.

In simplified outline:

```typescript
type NonOmittedKeys<S extends Struct> =
  string & TrueKeys<{
    [K in keyof S]: Not<IsOmitted<S[K]>>
  }>;

type UnwrapDerived<S extends Struct> =
  NonOmittedKeys<S> extends infer N extends string
  ? /* derive and select S's sole visible field */
  : never;

export type UnwrapSingleton<S extends Struct> =
  If<
    IsNever<UnwrapDerived<S>>,
    never,
    WithCustom<S, UnwrapDerived<S>>
  >;
```

When `S` is concrete, this machinery can reduce.

When `S` contains an open type parameter, substantial parts remain suspended on the particular `S` instantiation.

### The desired named return

`discriminatedItem` names both the input struct and the return at that input:

```typescript
type DiscriminatedItemStruct<I extends Item> = {
  readonly _discriminator: Discriminator;
  readonly value: I;
};

type DiscriminatedItem<I extends Item> =
  UnwrapSingleton<DiscriminatedItemStruct<I>>;
```

The tempting implementation is:

```typescript
const discriminatedItem = <const I extends Item>(
  type: DiscriminatorType,
  name: string,
  item: I,
): DiscriminatedItem<I> =>
  unwrapSingleton({
    _discriminator: discriminatorItem(type, name),
    value: item,
  }); // error
```

The annotation and body look structurally identical.

They do not instantiate `unwrapSingleton` with the same `S`.

The annotation asks for:

```typescript
UnwrapSingleton<DiscriminatedItemStruct<I>>
```

The unannotated call infers `S` from the object literal itself and produces something equivalent to:

```typescript
UnwrapSingleton<{
  readonly _discriminator: Discriminator;
  readonly value: I;
}>
```

The two arguments have the same members and are mutually assignable.

They are nevertheless different inputs to still-suspended mapped and conditional machinery.

At a concrete `I`, both results can reduce and structural comparison is enough.

At an open `I`, the relevant checker relation in TypeScript 7 succeeds only when it can recognize the same generic instantiation. The equivalence of the two `S` arguments is not enough to relate the suspended results.

Depending on how the two arguments print, the resulting diagnostic may be:

* a TS2322 wall whose two sides differ only by their spelling; or
* TS2719, the deeply unhelpful “two different types with this name exist.”

### Pin the inference input

The implementation explicitly supplies `S`:

```typescript
const discriminatedItem = <const I extends Item>(
  type: DiscriminatorType,
  name: string,
  item: I,
): DiscriminatedItem<I> =>
  unwrapSingleton<DiscriminatedItemStruct<I>>({
    _discriminator: discriminatorItem(type, name),
    value: item,
  });
```

Now the body and annotation both use:

```typescript
UnwrapSingleton<DiscriminatedItemStruct<I>>
```

Supplying the type argument changes the role of the object literal.

Without it, the literal is an **inference source** which chooses `S`.

With it, the literal is merely a **checked value** for the already chosen `S`.

Plain structural assignability is sufficient for that check.

Conceptually:

```text
unconstrained inference

object literal
    |
    | chooses S
    v
fresh anonymous S
    |
    v
UnwrapSingleton<fresh S>


pinned instantiation

DiscriminatedItemStruct<I>
    |
    | explicitly chooses S
    v
UnwrapSingleton<DiscriminatedItemStruct<I>>
    ^
    |
object literal is only checked here
```

If explicit instantiation is unavailable, an annotated local can pin the same identity:

```typescript
const layout: DiscriminatedItemStruct<I> = {
  _discriminator: discriminatorItem(type, name),
  value: item,
};

return unwrapSingleton(layout);
```

Inference now binds `S` to the local's declared type instead of to a fresh object-literal type.

The rule is narrower than “equivalent generic arguments are never interchangeable.”

The problem appears when the result contains unresolved machinery indexed by the precise inferred input, and the checker cannot reduce that machinery before relating the two results.

---

## Step 4: An annotation helps only the declaration on which it is written

fork-svm's `createCurried` extends svm's `bindClient` toolkit and returns its helpers in an inferred object literal:

```typescript
export const createCurried = <
  const SOL extends KindWithAtomic | undefined = undefined
>(
  forkSvm: ForkSvm,
  solKind?: SOL,
) => {
  const client = bindClient(forkSvm.createForkRpc(), solKind);
  // ...

  return {
    ...client,
    airdrop,
    // ...
  };
};
```

`client` is annotated: `bindClient` returns the `BoundClient<SOL>` interface. That annotation does not reach `createCurried`'s declaration. The spread copies members, and each arrives as its own checker type.

Declared inline in the interface, `getTokenAccount` mentions the open `SOL` through:

```typescript
TokenAccount<KT, SOL>
```

Left like that, it expands inside the emitted return object of `createCurried`, and so does `getDurableNonceAccount` through `DurableNonceAccount<SOL>`: the two members take the file from about 5 KB to 74 KB.

A plausible fix is to annotate a local with a mechanically derived type:

```typescript
const getTokenAccount: BoundClient<SOL>["getTokenAccount"] =
  client.getTokenAccount;
```

This does not help.

The annotation belongs to a local declaration which is not itself emitted.

When TypeScript infers the return object of `createCurried`, it does not move the local's annotation syntax into that object. It moves the local's checker type.

Producing the checker type for the indexed access resolves it. At the open `SOL`, that resolution partially evaluates the `TokenAccount<KT, SOL>` machinery and leaves an anonymous function type.

The outer export therefore still sees structure, not the annotation node:

```text
local source declaration

const getTokenAccount: BoundClient<SOL>["getTokenAccount"] = ...
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                       syntax lives here


inferred return of createCurried

return { getTokenAccount }
         ^^^^^^^^^^^^^^^
         only the resolved checker type arrives here
```

`getMint` emits cleanly without help because its type does not depend on `SOL`. Its existing alias instantiation is never forced through the same open generic computation, so the useful name survives.

The two members look similar in source. Their checker types reach the export boundary in different states.

### Give the member a type whose name belongs to the checker object

The working fix is a named function-type alias, which the interface uses for the member:

```typescript
export type GetTokenAccount<KS extends KindWithAtomic | undefined> =
  <const KT extends KindWithAtomic | undefined = undefined>(tokenKind?: KT) =>
    <const A extends MaybeArray<Address>>(tokenAccs: A) =>
      Promise<
        MapArrayness<A, TokenAccount<KT, KS> | undefined>
      >;

export interface BoundClient<KS extends KindWithAtomic | undefined = undefined> {
  // ...
  getTokenAccount: GetTokenAccount<KS>;
}
```

`GetTokenAccount<SOL>` creates a named function-object type directly. There is no surrounding operation that must first be resolved to discover the function.

That alias-bearing type flows through the spread into the inferred return object, and the emitted member is:

```typescript
getTokenAccount: GetTokenAccount<SOL>;
```

The difference is not that one annotation is more accurate.

Both annotations describe the same callable behavior.

The difference is what remains after the annotation has been converted into a checker type:

```text
BoundClient<SOL>["getTokenAccount"]
        |
        | indexed access resolves
        v
anonymous function type


GetTokenAccount<SOL>
        |
        | alias names the function object itself
        v
named function type
```

This is the point where the problem stops being “add annotations” and becomes “choose types whose names survive inference.”

---

## Step 5: Understand which names travel

The same factory result may appear in dozens or hundreds of inferred exports.

Annotating every outer export is possible, but it duplicates the public contract and misses future embeddings.

The systemic fix is to make the factory return a checker type whose name travels with it.

Different TypeScript declarations behave differently because the name can live in two different places, or nowhere at all:

1. on an unresolved **type operation** waiting to be evaluated;
2. on the resulting object type or declaration symbol itself; or
3. nowhere, when the body is only a reference to another alias.

The first is conditional.

The second is durable.

The third is a name the source has and the checker never sees.

The behavior observed in this repository is:

| Form | Where the useful name lives | What makes it disappear |
| --- | --- | --- |
| Function or object-literal alias | On the instantiated object type | Usually survives ordinary propagation and member use |
| Interface or class | On the declaration symbol | The printer can continue referring to the declaration |
| Conditional alias | On the unresolved conditional | Choosing a branch replaces the conditional |
| Mapped-type alias, written out | On the mapped type | Retained in every case observed here, open or concrete |
| Alias whose body is a reference to another alias | Nowhere: the checker type carries the inner alias's name | It was never there |
| `ReturnType<...>` alias | On a conditional operation that is normally immediately decidable | Resolving the function return discards the wrapper |
| Intersection alias | Empirically retained in the relevant SDK declarations | Its type arguments may still expand independently |

This is not a complete taxonomy of every type form in TypeScript.

It is the operational taxonomy needed for the declaration shapes in this package family.

### Conditional aliases travel only while the question remains open

`lamportsItem` chooses between a kind-aware amount item and Solana Kit's bare `Lamports` item:

```typescript
export type LamportsItem<
  K extends KindWithAtomic | undefined
> =
  K extends KindWithAtomic
  ? ReturnType<typeof svmAmountItem<K>>
  : typeof kitLamportsItem;

export const lamportsItem = <
  const K extends KindWithAtomic | undefined = undefined
>(kind?: K): LamportsItem<K> =>
  (kind ? svmAmountItem(kind) : kitLamportsItem) as any;
```

Before the conditional was named, the function used an equivalent inline return annotation.

That protected `lamportsItem`'s own declaration but gave downstream inferred exports no reusable name. The inline conditional, including the structural expansion of `KindWithAtomic`, appeared eleven times in `svm/layouting.d.ts`.

Naming it reduced that file from 32.5 KB to 21.6 KB.

The name survived in uses such as:

```typescript
LamportsItem<K>
```

and:

```typescript
DeriveType<LamportsItem<K>>
```

because those embedding sites were themselves generic in `K`.

The conditional still contained an unanswered question:

```typescript
K extends KindWithAtomic ? ... : ...
```

The alias name was attached to that unresolved box.

Once TypeScript knows a concrete `K`, the question can be answered. The conditional is replaced by its selected branch, and the box carrying the alias name is gone.

Conceptually:

```text
LamportsItem<K>
      |
      | K is still open
      v
named conditional remains


LamportsItem<ConcreteKind>
      |
      | branch is selected
      v
anonymous instantiated branch
```

This explains a failed attempt to name `defaultOptionItem` with a conditional or `ReturnType`-based alias. The name survived only in the factory's own open declaration. Concrete embeddings resolved the operation and expanded again.

The measured reduction was 362 bytes from a 21,651-byte file: noise rather than a systemic fix.

### `ReturnType` is usually an already-answerable question

It is tempting to write:

```typescript
type DefaultOptionItem<L extends Layout> =
  ReturnType<typeof _defaultOptionItem<L>>;
```

and expect the alias to travel.

But `ReturnType` is a conditional type whose question is essentially:

```typescript
typeof _defaultOptionItem<L> extends (...args: any) => infer R
  ? R
  : never
```

The function matches regardless of whether `L` is open.

The question can therefore be answered immediately. TypeScript replaces the alias wrapper with the inferred return object, and that object is anonymous.

In the measured `defaultOptionItem` experiment, an implementation/forwarder split using such an alias collapsed nothing and increased output by 204 bytes because the implementation declaration also had to be emitted.

The important distinction is not simply “conditional types are bad.”

`LamportsItem<K>` works while its condition genuinely depends on an unresolved `K`.

`ReturnType<typeof impl<L>>` does not work as a traveling name because its outer condition is decidable even while `L` remains open.

### Object-type aliases put the name on the result

A hand-written object alias behaves differently:

```typescript
type DefaultOptionItem<L extends Layout> = {
  readonly binary: "bytes";
  readonly layout: ReturnType<typeof baseDefaultOptionLayout<L>>;
  readonly custom: Conversion<
    BaseDefaultOption<L>,
    DeriveType<L> | undefined
  >;
};
```

Instantiating this alias creates the object type itself with the alias identity attached.

There is no outer question which must be answered before the object exists.

The name therefore survived both open and concrete embeddings:

```typescript
DefaultOptionItem<LamportsItem<K>>
DefaultOptionItem<AddressItem>
```

In the experiment, this reduced `svm/layouting.d.ts` from 21.6 KB to 13.7 KB.

Its defect is maintenance rather than emission: the alias manually duplicates the factory's inferred object shape. The implementation and public type can drift.

### An alias whose body is a reference to another alias carries that alias's name

An object-looking alias is not necessarily an object-type alias.

`Conversion` was formerly:

```typescript
type Conversion<FromType, ToType> = Readonly<{
  to:   (val: FromType) => ToType;
  from: (val: ToType) => FromType;
}>;
```

The body is a reference to `Readonly`. Instantiating `Conversion<A, B>` does not create an object type carrying the name `Conversion`; it instantiates `Readonly` at an anonymous argument, and the checker type that results is `Readonly`'s, name included. Nothing in that type remembers `Conversion`.

Every embedding prints what the type carries, the inner name over its argument spelled out:

```typescript
readonly custom: Readonly<{
  to: (val: RoUint8Array) => Address;
  from: (val: Address) => RoUint8Array;
}>;
```

In the contract SDK declarations, this produced 508 such blocks. Changing `Conversion` from that `Readonly<...>` alias to an interface collapsed 456 of them and removed 85 KB with four lines of source; the rest are the bare conversion literals of Step 7, which never referred to `Conversion` in the first place.

The mapped type is not evaluated away in the process. Respelling the interface back to the `Readonly<...>` alias and rebuilding this repository moves 27 `Conversion<` mentions to `Readonly<{ to: ...; from: ... }>` blocks and produces no bare `{ readonly to: ...; readonly from: ... }` block: the type is printed under the only name it has.

The current definition is the direct object alias:

```typescript
export type Conversion<
  FromType = Existential,
  ToType = Existential,
> = {
  readonly to:   (val: FromType) => ToType;
  readonly from: (val: ToType) => FromType;
};
```

The interface was not what did the work. Rebuilding this repository with the interface and with this alias emits byte-identical declarations for every package, the declaration line aside. What did the work is that either spelling creates an object type that carries the name `Conversion`, where the `Readonly<...>` body created one that carried `Readonly`'s. The alias is used because it is the default the "Alias or interface" section arrives at.

The same failure in a smaller alias:

```typescript
type QueryCall<D> = Readonly<{ to: Address; data: D; allowFailure?: boolean }>;
```

Every embedding prints:

```typescript
Readonly<{ to: Address; data: X; allowFailure?: boolean }>
```

At a concrete `D` this is only a legibility loss. At an open `D` it is the caching loss described above, paid at every embedding.

The same alias with the modifier on its members is an object-type alias in the sense of the taxonomy, and prints as `QueryCall<X>`:

```typescript
type QueryCall<D> = { readonly to: Address; readonly data: D; readonly allowFailure?: boolean };
```

Nineteen aliases across the packages had the `Readonly<...>` spelling, eleven of them generic. `Kind` was one, which is why it printed as `Readonly<{ name: string; units: KindUnits<string>; standard: ...; systems: ... }>` in every consumer diagnostic.

The payoff is confined to the generic ones. An alias without parameters has no open embedding: its checker type is a single object under either spelling, and a consumer relates to that one object in both cases, so what differs is which name a diagnostic prints and how many bytes an embedding costs. `type LayoutObject = Readonly<StrRecord>` is such an alias and stays as written; the rule at the end of this document is for generic aliases.

Two variants of the generic body need a different spelling:

* `Readonly<Alias<...>>`, where the argument is itself named, becomes a mapped type written out over that argument. Either bind the argument once, `Merge<...> extends infer M ? { readonly [K in keyof M]: M[K] } : never` (`SetProperty`), or give it an alias of its own and mention it twice, `{ readonly [K in keyof CustomizableBytesMerged<B, P>]: CustomizableBytesMerged<B, P>[K] }` (`CustomizableBytesReturn`). The bound form is shorter but is a conditional, deferred at open parameters; the twice-mentioned form is required where an implementation casts to the alias, since a deferred conditional cannot be compared at the cast site.
* `Readonly<Tuple>` becomes a `readonly` tuple type directly: `RoNeTuple<T>` is `readonly [T, ...T[]]`, `RoTupleOfLength<T, L>` rebuilds its tuple under `readonly [...R]`.

The failure has a sharper form when the alias carries a symbol-keyed phantom member. Expanded, the key must be spelled, and a consumer's declaration cannot spell a symbol it cannot import: `TS4023 ... cannot be named`, in the consumer's build, fixable only upstream. `AbiParam` in EVM's layouting hit this while carrying its value type as a brand, and is the reason the phantom there is a string-keyed optional member instead.

### Alias or interface

The interface route (Step 6) also keeps a name, so the choice between `type X = { readonly ... }` and `interface X { readonly ... }` deserves stating.

| | Object-type alias | Interface |
| --- | --- | --- |
| Can express | Any type: literals, mapped types with key remapping, conditionals, tuples, unions | Object types with statically known members only |
| Implicit index signature | Yes: assignable where `StrRecord`-shaped types (`Struct`, `LayoutObject`) are expected | No: an interface-typed layout can fail a `Layout` constraint |
| Declaration merging | Duplicate names collide | Duplicate names merge silently |
| Emit identity | Kept for a body written out (object, function, tuple, mapped); a conditional body loses it once the condition resolves; a bare reference to another alias never has it | Always: the declaration symbol is the name |

Of those eleven generic aliases, six had bodies no interface can express. The alias with per-member `readonly` therefore is the default, and its one cost is the repeated modifier. An interface earns its place in two positions: where heritage clauses compose the shape, as the `Item` family's `extends ItemBase<...>, Opts<...>` does, and where Step 6 puts it, absorbing an inferred shape that would otherwise be restated by hand. Emit decides nothing between the two for a hand-written shape, so nothing else should.

### Do not reduce the rule to “type operations always lose names”

That formulation is too broad.

The contract SDK's intersection alias:

```typescript
Contract<S, E> = S & /* ... */
```

continued to print as:

```typescript
Contract<...>
```

What expanded were some of its type arguments, not the outer alias.

The correct practical rule is empirical:

> Know whether the alias name remains on the checker type that reaches the emitted boundary. If it matters, inspect the declaration rather than inferring the answer from surface syntax.

---

## Step 6: Use an interface to absorb an inferred object shape once

An object-type alias travels well, but spelling a large inferred return by hand is brittle.

`DefaultOptionItem` uses an interface to acquire a durable name without restating the implementation's members.

### Split the implementation

First, the implementation keeps a name of its own:

```typescript
type _DefaultOptionItem<L extends Layout> =
  WithCustom<ReturnType<typeof baseDefaultOptionLayout<L>>, DeriveType<L> | undefined>;

const _defaultOptionItem = <const L extends Layout>(
  layout: L,
  defaultValue: DeriveType<L>,
  tagSize: NumberSize,
): _DefaultOptionItem<L> => withCustom(baseDefaultOptionLayout(layout, tagSize), {
  // ... actual conversion ...
});
```

Its return is annotated rather than inferred only because the inferred conversion would print `DeriveType`'s evaluated machinery (Step 2's cast). The annotation computes the shape instead of restating it, but `WithCustom` is a conditional alias: its name survives in the implementation's own declaration and is gone at every concrete embedding. Something else has to travel.

### Let an interface absorb that return

```typescript
export interface DefaultOptionItem<L extends Layout>
  extends ReturnType<typeof _defaultOptionItem<L>> {}
```

The `ReturnType` operation is resolved while TypeScript constructs the interface's members.

After that resolution, the externally visible type is the interface declaration:

```typescript
DefaultOptionItem<L>
```

There is no conditional wrapper left to preserve. The declaration symbol itself is the name.

Again, “symbol identity” here describes what the checker and printer can reference. It does not imply nominal assignability.

### Re-export the same runtime function under the named contract

```typescript
export const defaultOptionItem: <const L extends Layout>(
  layout: L,
  defaultValue: DeriveType<L>,
  tagSize: NumberSize,
) => DefaultOptionItem<L> = _defaultOptionItem;
```

This is a typed reassignment, not a wrapper.

The runtime function and call stack remain untouched.

The emitted declarations now reuse the interface everywhere:

```typescript
export declare const cOptionAddressItem: DefaultOptionItem<AddressItem>;

export declare const cOptionLamportsItem:
  <const KS extends KindWithAtomic | undefined = undefined>(
    ...solKind: OptionalArg<KS>
  ) => DefaultOptionItem<LamportsItem<KS>>;
```

and account layouts contain members such as:

```typescript
readonly mintAuthority: DefaultOptionItem<AddressItem>;
readonly isNative: DefaultOptionItem<LamportsItem<KS>>;
```

### Costs of the pattern

The interface avoids restating the returned object members, but it is not free.

* The implementation must have a separate name because the interface cannot refer to the exported function while that function's annotation refers back to the interface.
* The function parameter list appears once on the implementation and once on the exported contract.
* The declaration of `_defaultOptionItem`, and here its return alias, must be emitted because the exported interface extends its return.

That last declaration cost approximately 0.6 KB here. The file grew from 13.7 KB for the hand-written object alias to 14.3 KB for the interface form.

The small one-time cost replaces many repeated copies and eliminates drift between a duplicated object alias and its implementation.

The empty interface is therefore the general pattern:

```typescript
const _factory = <T>(arg: T) => ({ /* inferred object */ });

export interface FactoryResult<T>
  extends ReturnType<typeof _factory<T>> {}

export const factory: <T>(arg: T) => FactoryResult<T> = _factory;
```

It is useful specifically when a factory's inferred object return is large and will be embedded repeatedly.

It should not replace a small meaningful public interface which is easier to write directly.

The same technique gives a plain value an interface name: `interface X extends Identity<typeof x> {}`, where `Identity<T> = T` supplies the type reference a heritage clause needs in place of the bare type query. Step 7 uses it for `addressItem`, and the kinds in `common/units.ts` are declared the same way.

---

## Step 7: Name the semantic component before naming the envelope

Many binary-layout items are small envelopes:

```typescript
{
  binary,
  size,
  custom,
}
```

The interesting part is often `custom`: the conversion between wire and surfaced domains.

Examples include:

* bytes ↔ `Address`;
* bytes ↔ UTF-8 `string`;
* RLP bytes ↔ `bigint`.

Giving that conversion a public name is semantically useful even without declaration-size concerns.

It also prevents its two function members from being copied into every embedding.

### Annotation changes the value's type

```typescript
export const addressConversion:
  Conversion<RoUint8Array, Address> = {
    to:   (encoded: RoUint8Array) =>
      checksumAddress(hex.encode(encoded, true)),
    from: (addr: Address) =>
      hex.decode(addr),
  };
```

The annotation makes the value's checker type be:

```typescript
Conversion<RoUint8Array, Address>
```

That named type can travel into the item.

### `satisfies` does not change the value's type

This is not equivalent:

```typescript
export const addressConversion = {
  to:   (encoded: RoUint8Array) =>
    checksumAddress(hex.encode(encoded, true)),
  from: (addr: Address) =>
    hex.decode(addr),
} satisfies Conversion<RoUint8Array, Address>;
```

`satisfies` checks compatibility while deliberately preserving the expression's inferred type.

That behavior is normally its virtue.

Here it is exactly what we do not want: the value remains an anonymous object containing two function members, so downstream inference carries that anonymous object.

The distinction is:

```text
annotation

value: Conversion<A, B> = expression
       ^^^^^^^^^^^^^^^^
       becomes the value's declared type


satisfies

expression satisfies Conversion<A, B>
           ^^^^^^^^^^^^^^^^^^^^^^^^^^
           checks the inferred type but does not replace it
```

The package rule is therefore:

> Every reusable conversion is a named value, or an annotated factory return, whose declared type is `Conversion<From, To>`.

### Name the item when its envelope also repeats

Once the conversion is named, the item's shape is the value's inferred shape, and an interface takes it from the value without anyone restating it:

```typescript
const _addressItem = {
  binary: "bytes",
  size:   addressSize,
  custom: addressConversion,
} as const;
export interface AddressItem extends Identity<typeof _addressItem> {}
export const addressItem: AddressItem = _addressItem;
```

`Identity<T>` is `T`. It exists because a heritage clause needs a type reference and `typeof _addressItem` is a type query. The query cannot be made to carry a name on its own: `type AddressItem = typeof _addressItem` would refer to the literal's anonymous type, to which no name attaches, and every inferred embedding would print the three members again while the annotated `addressItem` alone printed `AddressItem`.

The one cost is the `_addressItem` declaration in the emitted file, referenced by the heritage clause.

On the contract SDK measurement, `addressItem` was embedded 387 times:

* naming the conversion and annotating `utf8Conversion` removed 45 KB from an 830 KB declaration set;
* naming the item as well removed 114 KB.

These reductions are nearly independent.

If an item contains a bare conversion literal, changing the declaration form of `Conversion` cannot help because the item type never refers to `Conversion` in the first place.

Likewise, naming only the conversion does not name the surrounding `{ binary, size, custom }` object.

Fix the repeated layer that actually reaches the declarations.

---

# The remaining hard case: `AmountItem`

The amount items are the one identified case whose type names do not survive. A kind-carrying `amountItem` returns `CustomUintItem<S, Amount<K>>` and an optional-kind one the `AmountItem` conditional over it; both resolve at every embedding, so what prints is the resolved branch.

The generic item factories (`uintItem`, `bytesItem`, …) have no item alias to lose. Their own declarations spell `Merge`'s body, but every call resolves it, so it never reaches a declaration that embeds their items.

Before `Conversion` became an object alias (Step 5), that branch carried the conversion pair spelled out: in the contract SDK declarations, 752 times. Today the conversion prints by name, and what repeats is only a two-member envelope:

```typescript
balance: {
  binary: "uint";
  size: 8;
} & {
  custom: Conversion<bigint, _Amount<SolKind>>;
};
```

Measured on 50 layouts with four amount or rate fields each, that is about 100 bytes of declaration per field over a plain `uintItem`, growing linearly: a legibility cost, not a performance problem. The section remains because the obvious ways to name the envelope fail, for reasons worth not rediscovering.

The obvious fixes fail because the current aliases are doing more than formatting a type.

They prove that computed structures satisfy `Item`.

## The load-bearing `infer ... extends`

The relevant definitions are:

```typescript
type PlainUintItem<S extends number> =
  ({ binary: "uint"; size: S; }) extends
    infer R extends Item ? R : never;

export type CustomUintItem<S extends number, To> =
  (PlainUintItem<S> & { custom: Conversion<NumSizeToPrimitive<S>, To> }) extends
    infer R extends Item ? R : never;

export type AmountItem<S extends number, K extends Kind | undefined = undefined> =
  K extends Kind ? CustomUintItem<S, Amount<K>> : PlainUintItem<S>;
```

The constrained inference:

```typescript
extends infer R extends Item ? R : never
```

is load-bearing.

It does not merely simplify or rename the object. It makes downstream code see an already validated `Item` at open generic parameters.

Replacing the result with an interface that repeats only the visible members loses that proof. Generic layout positions expecting `Layout` then reject the type.

## Inheriting the numeric item is too wide

A natural attempt is:

```typescript
interface AmountItem<S extends number, To>
  extends SizedNumItem<"uint"> {
  readonly size: S;
  readonly custom: Conversion<NumSizeToPrimitive<S>, To>;
}
```

`SizedNumItem<"uint">` already declares `custom` through its admitted numeric conversions:

```typescript
type NumConversion =
  Conversion<number> |
  Conversion<bigint>;
```

The interface attempts to narrow that inherited property to:

```typescript
Conversion<NumSizeToPrimitive<S>, To>
```

That narrowing is illegal at an open `S` (TS2430).

`Conversion` is invariant in both parameters because each parameter appears in both input and output positions across `to` and `from`:

```typescript
type Conversion<From, To> = {
  to:   (val: From) => To;
  from: (val: To) => From;
};
```

The precise conversion is therefore not a subtype of the broader `NumConversion` union merely because its raw domain will become `number` or `bigint` at each concrete size.

## Intersecting the conversions destroys surfaced-type inference

Another attempt retains the inherited admissible conversion while adding the precise one:

```typescript
Conversion<NumSizeToPrimitive<S>, To> & NumConversion
```

That makes the property narrowing legal.

It breaks `DeriveType`.

The surfaced type is extracted through:

```typescript
type CustomToType<I> =
  Get<I, "custom"> extends Conversion<infer _From, infer To>
  ? To
  : never;
```

The arms of `NumConversion` use the default surfaced parameter, `Existential`, which is `any` under a name that says why it is there: a parameter no caller is meant to pin, admitting every instantiation of an invariant type.

When TypeScript infers through the intersection, that `any` component contaminates the `To` inference. Derived amount types collapse to `never`, at concrete sizes as much as at open ones. The mechanism is not derived here; the outcome is pinned in binary-layout's `deriveType` test suite, so a compiler that starts inferring through the intersection will say so.

At that point the problem is no longer declaration emit.

Solving it requires changing the variance or admissible-conversion model of numeric items, or changing how `DeriveType` extracts the surfaced type.

Those are public type-design decisions with consequences beyond output size.

They should not be smuggled into an emitter cleanup.

## Names cannot be generated by a type-level helper

It is tempting to imagine a reusable abstraction:

```typescript
type Nominalize<F> = /* a durable named generic interface */;
```

TypeScript cannot do this.

Type expressions compute structures. They do not create declaration symbols with dynamically generated names.

Interfaces, classes, and type aliases introduce names only through literal declarations in source. A generic helper cannot manufacture a new interface identity for each factory, and TypeScript has no higher-kinded abstraction which turns an arbitrary generic factory into a correspondingly generic interface declaration.

One declaration per useful emitted name is the floor.

The empty-interface pattern reaches that floor without restating the inferred members, but it cannot bypass incompatible base types or recover variance information that the underlying design does not expose.

---

# Detection

Source review cannot reliably catch these failures.

The repository therefore checks the artifacts consumers actually receive.

[scripts/check-dist-types.mjs](./scripts/check-dist-types.mjs) inspects every package's `dist` along four axes.

## Maximum line width

Some conditional and mapped expansions print as a single enormous line.

The guard rejects declaration lines wider than:

```typescript
4000
```

characters.

Legitimate long declarations remain well below this threshold:

* SVM's deliberately long `allAddresses` literal was approximately 3000 characters;
* binary-layout's `SetItemEndianness` conditional was approximately 957.

The ceiling is intended to catch explosions, not enforce formatting aesthetics.

## Maximum file size

Object-type expansions usually print across many indented lines.

They can therefore evade the line-width check entirely. One pathological 533 KB declaration file had a widest line of only 915 characters.

The guard also rejects declaration files larger than:

```typescript
65536
```

bytes.

The largest known legitimate file is `common/dist/units.d.ts` at approximately 22 KB. Its size comes from deliberate structural doubling in the brand design rather than accidental anonymous repetition.

The smallest observed catastrophic declaration was approximately 155 KB, leaving useful margin between legitimate and pathological output.

## Node-type leaks

Every package compiles with:

```json
{
  "types": ["node"]
}
```

because `TextEncoder` and `TextDecoder` are otherwise unavailable in this configuration.

That permits inference to select Node-specific API types even for packages intended to work without `@types/node`.

For example, an unannotated call to:

```typescript
TextEncoder.encode(...)
```

can infer:

```typescript
NodeJS.NonSharedUint8Array
```

and leak that name into a public declaration.

The package may compile locally while becoming uninstallable for a consumer without Node's ambient types.

`utf8Conversion.from` therefore states its portable return explicitly:

```typescript
from: (decoded: string): RoUint8Array => {
  // ...
  return textEncoder.encode(decoded);
},
```

The guard type-checks the declarations of every package which is not intentionally Node-only without `@types/node` (`types: []`), with only the libs its dependencies demand: `ESNext`, plus `DOM` for a package on viem or kit. A name that resolves only through Node's ambient types fails there, whether it prints as `NodeJS.*`, `Buffer`, or `import("node:…")`. The check runs once the declarations are known to type-check at all (next section), so every error it reports is a leak.

This is a different symptom with the same cause: inference silently decided what the consumer's API would be.

## Declarations that do not type-check

Declaration emit prints the checker's type back as syntax, and nothing checks what it prints.

A type with no spelling of its own needs one invented for it. For a key-remapping mapped type over `keyof` of an object literal, tsc binds the literal to a fresh name,

```typescript
{ readonly endianness: E } extends infer T_1
  ? { [K in keyof T_1 as undefined extends { readonly endianness: E }[K] ? never : K]: T_1[K] }
  : never
```

and substitutes it everywhere except the `as` clause, where the literal survives. `K` ranges over `T_1`'s keys, which the checker cannot prove are the literal's, so the declaration fails with TS2536. Inside the checker both are one object, which is why the source compiled.

A key filter that must survive inference is therefore spelled as `Pick` over a computed key union, never as an `as` clause: `OmitUndefined` is built that way, so `timestampItem` can leave its return over it to inference.

The builds set `skipLibCheck: true`, so their own compilation never reads the emitted files. A consumer on TypeScript's default of `false` reads all of them, and fails on import whether or not it uses the export.

The guard type-checks every `dist` with [tsconfig.dist.json](./tsconfig.dist.json): the base configuration with lib checks on and `DOM` added, since kit's and ox's declarations name WebCrypto and WebAuthn globals.

## Ratcheting known debt

The checker supports per-file debt entries for known offenders.

A debt entry is a ceiling, not an exemption:

* the file may shrink, and its budget must follow it down: a budget above the file's current value fails until lowered;
* it may not grow;
* once it drops below the ordinary limit, the script fails until the stale debt entry is removed.

There are currently no debt entries.

## Catastrophe guards do not replace inspection

`svm/layouting.d.ts` passed both hard limits at 33 KB even though approximately one third of it was eleven copies of the same inline conditional.

A manual summary exposed it: the file compressed by approximately 11× under gzip, compared with a 2–4× baseline for declarations whose repetition was mostly intentional.

That signal cannot be made a hard rule. Legitimate structural patterns such as `Brand<T>` can also compress extremely well.

It is nevertheless a cheap diagnostic.

The practical release check is:

1. run the automated ceilings and portability checks;
2. compare declaration sizes with the previous release;
3. inspect unusually compressible or rapidly growing files;
4. open the actual `.d.ts` and identify what is repeating.

Every number in this document was sitting in an artifact nobody had opened.

---

# Working rules

The entire design reduces to a small set of rules.

## For a single bloated export

Annotate the declaration that actually ships:

```typescript
export const factory = <T>(arg: T): PublicResult<T> => /* ... */;
```

Do not expect an annotation on an unexported local to be reproduced inside an inferred outer return.

## For a generic helper used inside the annotation

Instantiate the generic parameters that matter:

```typescript
ReturnType<typeof helper<Arg, {}>>
```

Bare `typeof helper` never selects call defaults: the return is read at the constraints, or `ReturnType` fails its match and yields `any`.

## For a return computed from an inferred input

Make the body's generic instantiation match the annotation's instantiation:

```typescript
helper<NamedInput<T>>(value)
```

or pin inference through an annotated local.

Structural equivalence of the inputs may not suffice while the return machinery remains suspended on their identities.

## For a type that must survive many inferred embeddings

Use a name carried by the checker type itself:

* a direct function or object-type alias when the public shape is worth writing; a generic one spells `readonly` on each member rather than wrapping the body in `Readonly<...>`, which would hand the name to `Readonly`;
* an interface where heritage clauses compose the shape, as in the `Item` family's `extends ItemBase<...>, Opts<...>`;
* an empty interface extending an inferred shape, `ReturnType<typeof impl<T>>` for a factory or `Identity<typeof value>` for a value, when restating the shape would duplicate it.

Treat conditional aliases as wrappers whose names disappear when their conditions resolve, and an alias whose body is a bare reference to another alias as carrying that alias's name, not its own.

## For reusable values

Use an annotation when the named type should propagate:

```typescript
const conversion: Conversion<A, B> = /* ... */;
```

Use `satisfies` only when preserving the anonymous inferred type is actually desired.

## For release engineering

Read the declarations.

Source type elegance is not evidence that the emitted API preserved it.
