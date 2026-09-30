# Amount: Kind-safe amounts across concrete, union, and generic kinds

Implementation: [src/amount.ts](./src/amount.ts), [src/kind.ts](./src/kind.ts). Compile-time behavior is pinned in [tests/typePins.ts](./tests/typePins.ts) with identity assertions, typechecked as part of `pnpm test`.

The claims below were tested under TypeScript 7.0.2 — those pinned there on every run, the rest with probe files and deliberate assignment failures. The package requires **tsc >= 7**; see the compiler-floor note at the end.

## The Problem

`_Amount<K>` is a class parameterized by its `Kind`.

For a single concrete kind, this is straightforward:

```typescript
_Amount<UsdKind>
```

means an amount of US dollars, and methods such as `add` can require another amount with that same kind.

The difficulty is that the public type needs to behave correctly in three different cases:

1. **A concrete kind** — `Amount<UsdKind>`.
2. **A closed union of kinds** — `Amount<UsdKind | EurKind>`.
3. **An open type parameter** — generic code such as `<K extends Kind>(amount: Amount<K>) => ...`.

The first case works almost regardless of how we define `Amount`.

The other two pull the type in opposite directions.

---

## Closed kind unions need to distribute

Suppose:

```typescript
type EitherKind = UsdKind | EurKind;
```

What should this mean?

```typescript
Amount<EitherKind>
```

Semantically, an amount has exactly one kind, so it should mean:

```typescript
Amount<UsdKind> | Amount<EurKind>
```

It should **not** mean:

```typescript
_Amount<UsdKind | EurKind>
```

Those two types have importantly different method semantics.

Consider the class instantiated directly at the union:

```typescript
declare const amount: _Amount<UsdKind | EurKind>;
declare const eur: _Amount<EurKind>;

amount.add(eur); // typechecks
```

The call is allowed because both the receiver and argument are compatible with `UsdKind | EurKind`.

But `amount` may actually hold the USD kind at runtime. In that case the call reaches `checkKind` and throws.

The class instantiated at a union therefore admits exactly the mismatch we want the type system to prevent.

The standard TypeScript fix is a distributive conditional alias:

```typescript
type Amount<K extends Kind> =
  K extends Kind ? _Amount<K> : never;
```

Now:

```typescript
Amount<UsdKind | EurKind>
```

becomes:

```typescript
_Amount<UsdKind> | _Amount<EurKind>
```

which has the semantics we want: the value is one constituent amount or the other.

Binary operations now require narrowing before they can be called safely, because the two constituents require different same-kind operands.

So distribution solves the union case.

Unfortunately, it creates the generic case.

---

## Open generic kinds turn the alias into a deferred conditional

Consider:

```typescript
const generic = <K extends Kind>(amount: Amount<K>) => {
  // K is still unknown here
};
```

The alias expands to:

```typescript
K extends Kind ? _Amount<K> : never
```

but TypeScript cannot distribute it yet because it does not know what `K` is.

So `Amount<K>` remains a **deferred conditional type**.

That matters as soon as we try to access a member:

```typescript
const generic = <K extends Kind>(amount: Amount<K>) => {
  amount.add;
};
```

At this point TypeScript needs some usable type from which to look up `add`.

Before getting to `Amount`, it is useful to look at a smaller TypeScript oddity.

### A small generic-default quiz

Consider:

```typescript
declare const foo:
  <T extends number = 42>() => { value: T };
```

What is this?

```typescript
type A = ReturnType<typeof foo>;
```

A reasonable guess is `{ value: 42 }`.

After all, `T` has a default of `42`.

But the answer is:

```typescript
type A = { value: number };
```

To get `{ value: 42 }` we have to instantiate the generic explicitly:

```typescript
type B = ReturnType<typeof foo<42>>;
//   ^? { value: 42 }
```

When TypeScript inspects the still-generic function type, it does not instantiate `T` with its declared default `42`. The visible approximation is based on its **constraint**, `number`. (A return type that depends on `T` in a way the constraint-level reading cannot satisfy can even make `ReturnType`'s match fail outright, yielding its fallback `any` - see DeclarationEmit.md, Step 2.)

The same basic issue appears with our open `Amount<K>`.

`K` is declared as:

```typescript
K extends Kind
```

so when TypeScript needs a usable shape for member lookup on the still-deferred `Amount<K>`, it effectively sees:

```typescript
Amount<Kind>
```

rather than preserving the caller's particular:

```typescript
Amount<K>
```

In other words:

```text
amount : Amount<K>
            |
            | access `amount.add`
            v
        Amount<Kind>
```

The caller's `K` has disappeared.

This loss happens while TypeScript is interpreting the expression `amount.add`: it first has to determine what members the expression `amount` has, and only then can it inspect the signature of `add`.

That ordering matters.

If `add` is declared in terms of the class's `K`, changing only its return type cannot repair anything. By the time TypeScript gets to the method signature, the particular `K` from `Amount<K>` has already been replaced by the constraint-level `Kind`.

At first glance, this seems to leave us stuck.

TypeScript does, however, have one mechanism that behaves differently.

---

# The Solution

The key is TypeScript's polymorphic `this` **type**.

This is not merely the JavaScript runtime `this` value, and—more importantly—it is **not another spelling of `Amount<K>`**.

That distinction is the central fact the design relies on.

Consider these two method signatures:

```typescript
add(other: Amount<K>): Amount<K>
```

and:

```typescript
add(other: this): this
```

For an ordinary concrete instance they look almost interchangeable.

For an open `Amount<K>`, they are not interchangeable at all.

The first spelling refers back to the class-level `K`, which member lookup has already reduced to its constraint.

The second uses a special TypeScript type whose meaning is rebound from the actual expression on which the member is accessed.

If:

```typescript
amount: Amount<K>
```

then for:

```typescript
amount.add(...)
```

the `this` in `add` is bound to the type of `amount` itself:

```typescript
Amount<K>
```

It does **not** go through the same class-level `K` lookup that erased the kind.

Conceptually:

```text
class-level K:

amount : Amount<K>
            |
            | member lookup
            v
        Amount<Kind>
            |
            v
      K is now Kind


polymorphic this:

amount : Amount<K>
            |
            | bind `this` from the expression
            v
       this = Amount<K>
```

If `this` were merely shorthand for `Amount<K>`, none of this would work.

It is the one special mechanism that lets a method preserve the exact open receiver type after ordinary member lookup has lost the class generic.

The rest of the design follows from what this mechanism can—and cannot—express.

The next sections build that up one piece at a time.

---

## Step 1: The public type remains distributive

The implementation is a class:

```typescript
export class _Amount<K extends Kind> {
  // ...
}
```

but the public type is:

```typescript
type Amount<K extends Kind> =
  K extends Kind ? _Amount<K> : never;
```

The class is exported only because the alias needs it to remain reachable in generated declarations. Public signatures use the alias.

That gives us the desired closed-union behavior:

```typescript
Amount<K1 | K2>
```

means:

```typescript
Amount<K1> | Amount<K2>
```

rather than:

```typescript
_Amount<K1 | K2>
```

There is also an important asymmetry at an open `K`:

```typescript
Amount<K>  -> _Amount<K>   // assignable
_Amount<K> -> Amount<K>    // not assignable
```

A deferred conditional used as a source can be related by checking its possible branches against the target.

A deferred conditional used as a target cannot simply choose a branch while `K` remains open.

This is another reason `_Amount<K>` must not leak into consumer-facing generic signatures.

---

## Step 2: Kind-preserving methods use `this`

Any operation that preserves the complete amount type is expressed using polymorphic `this`.

For example:

```typescript
abs(): this
neg(): this

add(other: this): this
sub(other: this): this
mod(other: this): this
```

The rounding methods likewise return `this`:

```typescript
ceilTo<S extends SymbolsOf<K>>(unitSymbol: S): this
roundTo<S extends SymbolsOf<K>>(unitSymbol: S): this
floorTo<S extends SymbolsOf<K>>(unitSymbol: S): this
```

and scalar arithmetic preserves it as well:

```typescript
mul(other: Rationalish | Amount<Brand<Kind, "scalar">>): this;
div(other: Rationalish | Amount<Brand<Kind, "scalar">>): this;
```

### Open generic code

Given:

```typescript
const generic =
  <K extends KindWithAtomic>(supply: Amount<K>) =>
    supply.mul(2).floorTo("atomic");
```

the first call sees:

```typescript
this = Amount<K>
```

so `mul(2)` returns:

```typescript
Amount<K>
```

The next call therefore again binds:

```typescript
this = Amount<K>
```

and the complete chain remains:

```typescript
Amount<K>
```

No cast is needed.

Had these methods instead returned a type written directly in terms of the class's `K`, the method would see the erased constraint-level version.

### Same-kind operands

The same mechanism handles operations whose operand must have exactly the receiver's type:

```typescript
eq(other: this): boolean
ne(other: this): boolean
lt(other: this): boolean
le(other: this): boolean
gt(other: this): boolean
ge(other: this): boolean

add(other: this): this
sub(other: this): this
mod(other: this): this

ratio(other: this): Rational
```

For:

```typescript
const f = <K extends Kind>(
  a: Amount<K>,
  b: Amount<K>,
) => a.add(b);
```

`a` binds `this` to `Amount<K>`, so `b` is accepted.

Accepted as a type, not proven equal: `K` may itself be a union — a union-typed argument or an explicit `f<K1 | K2>` makes it one — and a call at `K1 | K2` may pass one amount of each kind. The signature says both operands come from the same *set* of kinds; that they are one kind is what `checkKind` verifies at runtime. `mul` and `div` take no `this` operand at all, only scalars — see [why the same-kind quotient is `ratio`](#the-same-kind-quotient-is-ratio-not-a-div-overload). See [`NoInfer`](#use-noinfer-when-only-one-argument-should-choose-k) for how the aggregators keep such a union from being inferred by accident.

But:

```typescript
const f = <K1 extends Kind, K2 extends Kind>(
  a: Amount<K1>,
  b: Amount<K2>,
) => {
  a.add(b); // rejected
};
```

fails because `b` is not known to have the exact type bound from `a`.

### Closed unions still require narrowing

Now consider:

```typescript
declare const either: Amount<UsdKind | EurKind>;
```

This is really:

```typescript
Amount<UsdKind> | Amount<EurKind>
```

and each constituent binds `this` separately.

Conceptually:

```typescript
UsdAmount.add(other: UsdAmount): UsdAmount
EurAmount.add(other: EurAmount): EurAmount
```

There is no safe same-kind operand that can be supplied before the receiver has been narrowed.

So the two mechanisms complement one another:

* the distributive alias makes closed unions strict;
* polymorphic `this` preserves open generic receivers.

---

## Step 3: "Another amount of my kind" is also a `this` operation

The `kind` property itself is declared as:

```typescript
readonly kind: K;
```

At a concrete kind this is exact, and on a closed union it produces the corresponding union of kinds.

At an open `Amount<K>`, however, reading:

```typescript
amount.kind
```

requires member lookup on `amount`, so it suffers the same erasure as any other ordinary member written in terms of the class-level `K`.

A tempting workaround is to try to express the property through `this`, for example with an accessor involving:

```typescript
this["kind"]
```

That does bind to the exact receiver.

But now the resulting type is expressed as:

```typescript
Amount<K>["kind"]
```

rather than as the original generic parameter:

```typescript
K
```

and the two do not unify cleanly in APIs that expect that original `K`.

For the common operation "make another amount with my own kind", extracting the kind is unnecessary anyway.

So `_Amount` provides instance factories:

```typescript
zero(): this
```

and:

```typescript
ofSame<S extends SymbolsOf<K>>(
  numericalValue: Rationalish | string,
  unitSymbol: S,
): this
```

Generic code can therefore write:

```typescript
amount.zero()
```

or:

```typescript
amount.ofSame(value, "atomic")
```

instead of:

```typescript
Amount.ofKind(amount.kind as K)(value, "atomic")
```

The cast in the latter version is needed precisely because `.kind` lost the original open `K`.

If what we want is "another value exactly like this one except for its numerical value", preserving `this` directly is the more faithful operation.

---

## Step 4: `this` only works if the result is still `this`

So far `this` looks almost magical.

But it has a severe limitation: it preserves the receiver **as a whole**.

That is enough for:

```typescript
Amount<K> -> Amount<K>
```

and:

```typescript
Rate<NK, DK> -> Rate<NK, DK>
```

It is not enough when an operation needs to inspect the type arguments inside the receiver and rearrange them.

This becomes obvious with `_Rate`.

A rate has two kinds:

```typescript
Rate<NK, DK>
```

and inversion should produce:

```typescript
Rate<DK, NK>
```

If inversion preserved the complete receiver type we could simply return:

```typescript
this
```

but that would mean:

```typescript
Rate<NK, DK>
```

not:

```typescript
Rate<DK, NK>
```

What we would like is some imaginary operation such as:

```typescript
Swap<this>
```

that could crack open the specially rebound `this`, recover `NK` and `DK`, and rebuild the type with them exchanged.

TypeScript does not provide such a mechanism.

Polymorphic `this` can be passed around or returned whole. It does not expose the original generic parameters from which the receiver was constructed.

This puts us back in the original problem.

If the instance method falls back to its class-level `NK` and `DK`, those are precisely the parameters hidden behind the deferred generic receiver and subject to the same erasure.

So an exact generic `inv()` method has no `this`-based spelling available.

At this point we need a second escape hatch.

---

## Step 5: Free functions get fresh generic parameters

The package provides a free function:

```typescript
const invert =
  <NK extends Kind, DK extends Kind>(
    rate: Rate<NK, DK>,
  ): Rate<DK, NK> => {
    // ...
  };
```

Now generic code works exactly:

```typescript
const generic =
  <NK extends Kind, DK extends Kind>(
    rate: Rate<NK, DK>,
  ) => {
    const inverse: Rate<DK, NK> = invert(rate);
  };
```

At first glance this looks suspicious.

Why should moving what appears to be the same type relationship outside the class make any difference?

The important distinction is **when the generic parameters come into existence**.

### Class generics are already buried in the receiver

For an instance method on:

```typescript
Rate<NK, DK>
```

the class-level `NK` and `DK` were part of constructing the receiver type before the method call begins.

When TypeScript evaluates:

```typescript
rate.inv()
```

it first has to interpret the expression `rate` and look up the member `inv`.

For an open distributive alias, that is exactly the point where the receiver's class generics are hidden by the constraint-level apparent type.

The method does not get a fresh chance to infer them.

### Function generics are fresh inference variables

The `NK` and `DK` here:

```typescript
<NK extends Kind, DK extends Kind>(
  rate: Rate<NK, DK>,
)
```

are different.

They are new inference variables created for this function call.

When we write:

```typescript
invert(rate)
```

TypeScript gets to infer those variables from the argument and then construct:

```typescript
Rate<DK, NK>
```

from the freshly inferred types.

That call-site inference boundary is something an instance method does not have for its class parameters.

---

## Why inference through the alias works

There is one more important detail.

The free-function parameter is written using the same alias as the argument:

```typescript
Rate<NK, DK>
```

rather than the implementation class:

```typescript
_Rate<NK, DK>
```

This matters because an open `Rate<NK, DK>` is itself a deferred conditional type.

When TypeScript infers one alias-shaped conditional from another alias-shaped conditional, their structures correspond. It can relate the type expressions and infer the fresh function parameters without first reducing the argument to the constraint-level class shape.

In rough terms, it can match:

```text
Rate<CallerNK, CallerDK>
```

against:

```text
Rate<FunctionNK, FunctionDK>
```

and infer:

```text
FunctionNK = CallerNK
FunctionDK = CallerDK
```

while the conditional structure is still intact.

If the function parameter instead uses the implementation-class spelling, the two shapes no longer correspond:

```typescript
Rate<NK, DK>
```

against:

```typescript
_Rate<NK, DK>
```

and inference falls back to the apparent type, losing the original kind parameters again.

So the free-function mechanism depends on two facts:

1. the function gets **fresh call-site generic parameters**;
2. the parameter uses the **same distributive alias shape** as the argument.

The currently exported helpers using this mechanism are:

```typescript
kindOf(...)
numKindOf(...)
denKindOf(...)
invert(...)
```

`kindOf`, `numKindOf`, and `denKindOf` recover exact kind values where ordinary properties erase at an open generic.

`invert` performs the exact kind swap that an instance method cannot express.

Further kind transformations can use the same pattern if consumers need them.

One limitation remains: inference for helpers with several kind parameters is weaker for union-typed arguments and may infer a single constituent rather than the complete union. Those calls require explicit type arguments.

---

## Kind-changing operations that infer from an argument do not need a free function

Not every operation that changes kind has the `inv` problem.

For example:

```typescript
mul<NK extends Kind>(
  other: Rate<NK, K>,
): Amount<NK>;
```

changes the result kind, but `NK` is a **method-level** type parameter inferred freshly from `other`.

Likewise:

```typescript
div<DK extends Kind>(
  other: Rate<K, DK>,
): Amount<DK>;
```

gets `DK` from the argument.

Those method-level generics are call-site-live, just like generics on a free function.

The problem only arises when the transformation requires us to recover or rearrange generic parameters that exist solely in the receiver. (The kind such a method *consumes* is the class-level `K` again, which is why an open receiver checks it only at runtime - see [Remaining limitations](#a-rate-operands-receiver-side-kind-is-checked-at-runtime-only).)

This gives us the complete rule:

* preserve the complete receiver → use `this`;
* derive a new kind from an argument → use a method-level generic;
* recover or rearrange kinds hidden inside the receiver → use a free function with fresh generic parameters.

That is the core design.

Everything below is additional machinery needed to keep it strict.

---

# Additional typing details

## Unit symbols must reflect what an open constraint actually promises

Methods such as:

```typescript
floorTo(...)
```

need to accept only valid unit symbols.

For a concrete kind, this is straightforward.

If a kind declares literal unit keys, `SymbolsOf<K>` should expose all of them.

The harder case is open generic code:

```typescript
const f =
  <K extends KindWithAtomic>(amount: Amount<K>) =>
    amount.floorTo("atomic");
```

At an open `K`, ordinary references to the class-level kind are viewed through its constraint.

So the allowed symbols should be exactly those that the constraint guarantees.

For `KindWithAtomic`, `"atomic"` is guaranteed.

An arbitrary concrete symbol such as `"wei"` is not.

### Why `keyof K["units"]` is too broad

The obvious formulation is:

```typescript
Extract<keyof K["units"], string>
```

but the general kind constraints use an index signature for `units`.

At the constraint level:

```typescript
keyof K["units"]
```

therefore becomes:

```typescript
string
```

and absorbs all literal distinctions.

That would make this compile:

```typescript
const f =
  <K extends KindWithAtomic>(amount: Amount<K>) =>
    amount.floorTo("bogus");
```

even though the constraint promises no such unit.

`SymbolsOf<K>` instead distinguishes three regimes.

### Concrete kind

For a kind with literal unit keys:

```typescript
SymbolsOf<ConcreteKind>
```

contains all symbols declared by that kind.

### Constraint promising particular meta units

For:

```typescript
K extends KindWithAtomic
```

only symbols guaranteed by that constraint are accepted.

For example:

```typescript
"atomic" | "standard"
```

rather than arbitrary strings.

### Bare `Kind`

For:

```typescript
K extends Kind
```

nothing more specific is promised, so:

```typescript
SymbolsOf<K>
```

must be:

```typescript
string
```

This top case is also needed for class relations such as:

```typescript
_Amount<ConcreteKind> <= _Amount<Kind>
```

Every concrete symbol set must remain a subtype of the bare-`Kind` symbol set.

---

## Two details in `SymbolsOf` are intentional

The actual `SymbolsOf` formulation contains two shapes that look like obvious cleanup targets but change compiler behavior if removed.

### `"standard"` remains a top-level union member

A plain `"standard"` member remains outside the guarded conditional portion.

This keeps the resulting type compatible with assignability and cast relations that occur while the rest of `SymbolsOf<K>` remains deferred.

Moving the entire expression behind the conditional breaks those relations.

### `any` is handled explicitly

The outer form includes an `any` guard equivalent to:

```typescript
If<IsAny<K>, string, ...>
```

This matters because overload/implementation compatibility checks can compare signatures after effectively instantiating the class-level `K` with `any`.

Conditional types involving `any` consider both possible branches. Without the guard, the meta-symbol logic can incorrectly conclude that every meta symbol is promised.

For these checks, `any` must behave like the top `Kind` case and produce:

```typescript
string
```

---

## Unit-taking methods need their own generic parameter

The rounding methods are written as:

```typescript
ceilTo<S extends SymbolsOf<K>>(unitSymbol: S): this
roundTo<S extends SymbolsOf<K>>(unitSymbol: S): this
floorTo<S extends SymbolsOf<K>>(unitSymbol: S): this
```

rather than:

```typescript
ceilTo(unitSymbol: SymbolsOf<K>): this
```

The additional `S` looks unnecessary, but it is required when TypeScript relates different instantiations of the class.

For example:

```typescript
_Amount<ConcreteKind>
```

must relate to:

```typescript
_Amount<Kind>
```

but those two instantiations have different resolved `SymbolsOf<K>` types.

A method whose parameter is directly:

```typescript
SymbolsOf<K>
```

can make that class relation fail.

When both sides instead have the same generic method shape:

```typescript
<S extends SymbolsOf<K>>(...)
```

the signatures can unify across the difference in their constraints.

The same pattern is used by `_Rate`, including separate unit-symbol parameters where numerator and denominator units differ and the `DS` parameter on `_Rate.toString`.

---

## The same-kind quotient is `ratio`, not a `div` overload

Dividing an amount by another of its kind yields a plain number, and dividing it by a scalar amount yields an amount. Both read as division, and one `div` with an overload for each would be the natural spelling:

```typescript
div(other: this): Rational;
div(other: Rationalish | Amount<Brand<Kind, "scalar">>): this;
```

The two overloads cannot be told apart soundly once `K` is a union. At `K1 | K2`, `div(other: this)` accepts an amount of either kind — the whole point of `this` is that it is exactly the receiver's type — so a call whose operands are one of each type-checks as a same-kind quotient returning `Rational`. The runtime then sees an operand of another kind, and when that kind is a scalar one (`ETH | Percentage`), scaling by it is exactly what it would do for the scalar overload. No check can recover which reading the types chose: the call site that decided is gone by the time the method runs.

Unions of kinds are not an exotic instantiation. Code over "one of these kinds, known only at runtime" — a tranche's note, say — calls at the union because no single kind is known statically.

So the readings get separate methods:

```typescript
ratio(other: this): Rational;   //checkKind at runtime, like add and sub

div(other: Rationalish | Amount<Brand<Kind, "scalar">>): this;
div<DK extends Kind>(other: Rate<K, DK>): Amount<DK>;
```

`ratio` is safe at a union for the same reason `add` is: its runtime kind check catches the pair the types let through. `div` takes no `this` operand, so an `Amount<K>` at an open or union `K` — which is no scalar — does not type-check against it at all. What remains unguarded is a scalar operand forged through a cast.

A scalar divided by a scalar is then scalar division like any other: `percent(10).div(percent(50))` is `20 %`, and `percent(10).ratio(percent(50))` the `Rational` 0.2.

---

## `const` marks parameters that infer a kind from a kind value

A kind's literal structure is part of its type-level meaning.

`SymbolsOf<K>` depends on literal unit keys.

`isOfKind` narrows using the literal kind name.

Therefore, any generic parameter that can be inferred directly from an inline kind value must preserve those literals.

Such signatures use `const` type parameters:

```typescript
static from<const K extends Kind>(...)
static ofKind<const K extends Kind>(...)
static parse<const KS extends RoArray<Kind>>(...)
per<const DK extends Kind>(...)
```

and similarly in `Rate.from`, `getUnit`, and other functions that accept kind values directly.

By contrast, a type parameter inferred only through an existing:

```typescript
Amount<K>
```

or:

```typescript
Rate<NK, DK>
```

does not receive a fresh kind object literal and therefore does not need `const`.

The convention is:

> `const` appears where an inline kind value can enter inference.

---

## Aggregators return the common kind

A free function over several amounts faces the question the methods answer with `this`: what does it return when the operands' kinds differ? The answer is exact. An aggregate of amounts is an amount of the kind every operand has, or a kind mismatch at runtime, so its type is the *intersection* of the operands' kinds:

```typescript
declare function sum<K extends Kind, Ks extends RoArray<Kind>>(
  first: Amount<K>,
  ...rest: { [I in keyof Ks]: Amount<Ks[I]> },
): Amount<K & CommonKind<Ks>>;
```

where `CommonKind` folds `&` over the tuple. A union-typed operand narrows to what the others admit, two distinct kinds intersect to `never` (their names are disjoint literals), and `Amount<never>` distributes to `never`: the type of a call that cannot return.

```typescript
declare const usd: Amount<UsdKind>;
declare const eur: Amount<EurKind>;
declare const either: Amount<UsdKind | EurKind>;

sum(either, usd); // Amount<UsdKind> — or a throw, if either held euros
sum(usd, either); // Amount<UsdKind> — the same, in either order
sum(usd, eur);    // never
```

This is not a distributive tuple (see the next section): the kinds are inferred one per position through a mapped rest tuple, so an open `K` folds to `K & K`, which is `K`, and generic code keeps its kind. Rates carry two kinds and a tuple of pairs does not infer, so their kinds are read back from the inferred rate tuple instead — exact at concrete kinds and assignable to `Rate<NK, DK>` at open ones.

## Use `NoInfer` when the result cannot carry the intersection

The same `K` in several inference positions is only a problem when there is no result type to carry the intersection. Two arguments of distinct kinds never unite — TypeScript takes `K` from the first candidate and rejects the second — but a later argument whose type *contains* the first one's is a supertype candidate, and inference widens to it:

```typescript
declare const compare:
  <K extends Kind>(
    a: Amount<K>,
    b: Amount<K>,
  ) => -1 | 0 | 1;

compare(usd, either); // K = UsdKind | EurKind, a legal call that throws when either holds euros
```

`compare` returns no amount, so nothing says "the kind both share". The first argument is made authoritative and the second uses `NoInfer`:

```typescript
declare const compare:
  <K extends Kind>(
    a: Amount<K>,
    b: Amount<NoInfer<K>>,
  ) => -1 | 0 | 1;
```

The second argument is still checked against the chosen `K`; it simply no longer contributes a candidate, so `either` is rejected against `UsdKind`. Authoritative means the first argument's *set* of kinds: `compare(either, usd)` compiles and throws when `either` holds euros, where the method form `either.eq(usd)` does not compile. A plain-tuple free function cannot be as strict as the method — the distributive tuple that would make it so is uncallable, as the next section shows.

Consumer APIs should follow the same rule whenever one kind parameter appears in several positions and the result cannot express their intersection.

---

## `Amount.from` uses a plain tuple, not a distributive tuple

A tempting definition for kind-correlated parameters is:

```typescript
K extends any
  ? [kind: K, unitSymbol?: SymbolsOf<K>]
  : never
```

The idea is to distribute the argument tuple along with the kind.

This fails in both cases where it would be useful.

### Open `K`

Inside generic code, the parameter tuple itself becomes a deferred conditional type.

Its branch depends on the check type parameter through:

```typescript
kind: K
```

and TypeScript deliberately restricts assignment to such distribution-dependent conditional targets.

As a result:

```typescript
Amount.from(value, kind, unit)
```

becomes uncallable inside the generic body.

### Closed union

If:

```typescript
K = K1 | K2
```

then a union-typed kind value produces an argument tuple shaped like:

```typescript
[K1 | K2, ...]
```

But a tuple containing a union is not the same type as:

```typescript
[K1, ...] | [K2, ...]
```

so the distributive parameter form rejects the union-typed value.

That is exactly the use case it was supposed to support.

### The plain tuple already has the needed correlation

For a union:

```typescript
K1 | K2
```

`SymbolsOf<K1 | K2>` already represents the symbols valid for the union as a whole.

So:

```typescript
[kind: K, unitSymbol: SymbolsOf<K>]
```

does what we need.

For example:

```typescript
Amount.from(1, eitherKind, "atomic");
```

is accepted if `"atomic"` is valid for every constituent, while:

```typescript
Amount.from(1, eitherKind, "wei");
```

is rejected if `"wei"` belongs only to one.

The result remains:

```typescript
Amount<K1 | K2>
```

Accordingly:

```typescript
export type AmountFromArgs<K extends Kind> = [
  kind: K,
  unitSymbol: SymbolsOf<K>,
];
```

The `KindWithHuman` overload separately permits omission of the unit:

```typescript
[kind: K, unitSymbol?: SymbolsOf<K>]
```

because such kinds have a valid human unit available as the default.

---

# Remaining limitations

## Truthiness narrowing can defeat `SymbolsOf`

Suppose:

```typescript
K extends KindWithAtomic | undefined
```

and generic code does:

```typescript
if (kind) {
  // ...
}
```

TypeScript narrows `kind` to an intersection approximately like:

```typescript
K & {}
```

`SymbolsOf` cannot resolve that intersection back to the original constraint's promised meta symbols.

So:

```typescript
Amount.from(value, kind, "atomic");
```

may reject `"atomic"` despite the truthy value being on the `KindWithAtomic` side.

Casting the narrowed value to:

```typescript
kind as K & KindWithAtomic
```

restores that information.

The result remains typed as:

```typescript
Amount<K & KindWithAtomic>
```

rather than being widened further.

---

## `.kind` still erases at an open `K`

For "construct another amount of my own kind", use:

```typescript
zero()
```

or:

```typescript
ofSame(...)
```

For an exact read of the kind itself, use:

```typescript
kindOf(...)
```

At a concrete kind or closed union, `.kind` remains precise.

---

## Unit-symbol methods require narrowing on union receivers

The method-level generic:

```typescript
<S extends SymbolsOf<K>>
```

is needed for class compatibility.

One consequence is that a closed-union receiver contains a union of generic call signatures.

TypeScript does not synthesize a callable signature for that union.

So unit-symbol methods such as `floorTo` must be called after narrowing the receiver to one constituent.

---

## The union implementation class remains explicitly reachable

Because `_Amount` is exported for type reachability, a consumer can deliberately write:

```typescript
const widened: _Amount<K1 | K2> = amount;
```

That type has the unsafe union-class semantics described at the beginning: its binary methods accept either constituent kind.

`checkKind` remains the runtime backstop.

The public API avoids producing this type naturally by using only the distributive alias in signatures.

---

## `_Amount<K>` must not leak into generic signatures

At an open `K`:

```typescript
Amount<K>
```

is assignable to:

```typescript
_Amount<K>
```

but not vice versa.

Consumer-facing generic signatures should therefore consistently use:

```typescript
Amount<K>
```

rather than:

```typescript
_Amount<K>
```

Using the implementation-class spelling reintroduces the generic asymmetry the alias is designed to avoid.

---

## A rate operand's receiver-side kind is checked at runtime only

The kind-changing methods take a method-level generic for the kind they produce, but the kind they consume is the class-level one:

```typescript
mul<NK extends Kind>(other: Rate<NK, K>): Amount<NK>;
div<DK extends Kind>(other: Rate<K, DK>): Amount<DK>;
```

At a concrete kind that `K` is exact, so `btc.mul(usdPerEth)` is rejected. At an open `K` it is the class-level parameter that member lookup erases (see the beginning of this document), so generic code may pass a rate whose denominator has nothing to do with the amount:

```typescript
const convert = <K extends Kind, T extends Kind>(
  amount: Amount<K>,
  price:  Rate<T, EthKind>,
) => amount.mul(price); // compiles; checkKind throws unless K is ETH
```

`this["kind"]` does not help: it erases the same way. Only a free function with fresh parameters, `<K, NK>(amount: Amount<K>, rate: Rate<NK, K>) => Amount<NK>`, would check the pair statically. Generic code converting between kinds is rare enough that the runtime check is the backstop instead.

---

## `this` promises the receiver's whole static type

Polymorphic `this` returns whatever static type the receiver had, and that can be more than `Amount<K>`: a brand intersected onto an instance, a property attached with `Object.assign`. The class builds bare amounts, so no refinement is carried over — `x.add(x).note` is `undefined` under a type that says `string`, and `nonZero.zero()` still wears the brand. This is the general cost of the strategy rather than a hole specific to amounts: `this` is the only type that survives an open `K`, and it cannot tell the class's own type from a refinement of it. Refinements of an amount belong on the values around it, not on the instance.

---

# Compiler floor: tsc >= 7

The three-regime `SymbolsOf` formulation does not typecheck under TypeScript 5.9 when used in the complete `_Amount` class.

The relevant class relation is of the form:

```typescript
_Amount<ConcreteKind> <= _Amount<Kind>
```

which is needed by code such as `isOfKind`.

Reduced reproductions of the individual generic method patterns work under 5.9, but the full class fails through relation cycles involving methods including `per`, `mul`, and `div`. `per` has been independently confirmed as one participant.

TypeScript 7 relates the complete type correctly.

Rather than weaken `SymbolsOf` or expose a less strict public type in order to accommodate the older relation machinery, the package deliberately requires **TypeScript 7 or newer**.
