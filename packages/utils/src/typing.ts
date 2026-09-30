export type Nullish = null | undefined;

//Extend this type to create an object-like interface which is expected to be overridden,
//  e.g. via a type declaration. An empty interface is equivalent to `{}`, which admits every
//  non-nullish value - numbers and strings included. A `Record<PropertyKey, never>` prohibits
//  declaration merging. `object` itself cannot be extended directly, so we define this type alias.
export type BaseObject = object;

//spells "some T" for a defaulted type parameter: a value typed with the default stands for an
//  instantiation at *some* fixed type, unknowable from outside - type theory's ∃, against the ∀
//  of a parameter the caller picks (Java's List<?>, Rust's dyn Trait). TS has no native
//  existentials (microsoft/TypeScript#14466), and `unknown` cannot fake them wherever the
//  parameter occurs in parameter position - contravariant there, invariant when it also occurs
//  in return position. Only `any` admits every instantiation, and admission is all the default
//  buys: nothing guards the erasure - a value read through it is `any`, not `unknown`, and a
//  parameter takes anything, not nothing. Belongs exclusively in type-parameter defaults;
//  anywhere else it has no instantiation to stand for and is merely a disguised `any`.
export type Existential = any;

//Function is a generic overload of the built-in type
//  It should work as a more powerful drop-in replacement.
//  Since the built-in type is not generic and permissive, we have to use RoArray<Existential> as
//    the default type of the parameters, otherwise `Test` would become false after our overload:
// type TestFunc = (...args: [string, number]) => boolean;
// type Test = TestFunc extends Function ? true : false; //true for built-in
export type Function<P extends RoArray<unknown> = RoArray<Existential>, R = unknown> =
  (...args: P) => R;

export type Guard<T, U extends T> = (val: T) => val is U;

export type Predicate<T> = Function<[T], boolean>;

export type NeTuple  <T = unknown> = [T, ...T[]];
export type Tuple    <T = unknown> = NeTuple<T> | [];
export type RoNeTuple<T = unknown> = readonly [T, ...T[]];
export type RoTuple  <T = unknown> = RoNeTuple<T> | readonly [];
export type RoArray  <T = unknown> = readonly T[];
export type RoPair   <T = unknown, U = unknown> = readonly [T, U];
export type StrRecord<T = unknown> = Record<string, T>;

//a tuple whose length is known: an open tail (`[T, ...T[]]`) is a RoTuple, but its length is
//  `number` like any array's, and no walker can promise a tuple over it
export type IsFixedTuple<T extends RoArray> = Not<Extends<number, T["length"]>>;

//A when it is a fixed tuple, never otherwise - meant as the extends type of a distributive
//  conditional, `A extends AsFixedTuple<A> ? … : …`, which then distributes over unions of arrays
//  (a bare IsFixedTuple<A> collapses them: the union's length is `number`) and narrows A to a
//  RoTuple in the true branch
export type AsFixedTuple<A extends RoArray> =
  A extends infer T extends RoTuple
  ? IsFixedTuple<T> extends true
    ? T
    : never
  : never;

//see RoUint8Array.md for detailed explanation of this implementation
declare const roBrand: unique symbol;
interface Marker extends Uint8Array {
  [roBrand]: true;
}

type ReplaceMarker<T, Self> =
  T extends Marker
  ? Self
  : T extends Uint8Array | IteratorObject<unknown>
  ? T
  : T extends Function<infer A, infer R>
  ? Function<ReplaceMarker<A, Self>, ReplaceMarker<R, Self>>
  : T extends RoArray
  ? { readonly [K in keyof T]: ReplaceMarker<T[K], Self> }
  : T extends object
  ? { [K in keyof T]: ReplaceMarker<T[K], Self> }
  : T;

type TypedArrayMutableProperties = "copyWithin" | "fill" | "reverse" | "set" | "sort";
type Uint8ArrayMutableProperties = "setFromBase64" | "setFromHex";
//buffer would hand out a cast-free writable view; the const_cast is mutable(). Without it
//  nothing carries Uint8Array's buffer type parameter, so RoUint8Array has none
type Uint8ArrayOmittedProperties =
  TypedArrayMutableProperties | Uint8ArrayMutableProperties | "subarray" | "buffer" | typeof roBrand;

type RoUint8ArrayBase<Self> =
  ReplaceMarker<Omit<Marker, Uint8ArrayOmittedProperties>, Self> & {
    readonly [n: number]: number;
    subarray(...params: Parameters<Uint8Array["subarray"]>): Self;
  };

export interface RoUint8Array extends RoUint8ArrayBase<RoUint8Array> {}

export type Opts<T> = { readonly [K in keyof T]?: T[K] | undefined };

export type Simplify<T> = { [K in keyof T]: T[K] } & unknown;

//an interface's extends clause takes type references only, not `typeof` queries, so
//  `interface X extends Identity<typeof x> {}` needs this alias purely as the reference - X is
//  structurally typeof x, but hovers and .d.ts emit show its name
export type Identity<T> = T;

//utility type to reduce boilerplate of iteration code by replacing:
// `T extends readonly [infer Head extends T[number], ...infer Tail extends RoTuple<T[number]>]`
//with just:
// `T extends HeadTail<T, infer Head, infer Tail>`
//this also avoids the somewhat common mistake of accidentally dropping the readonly modifier
export type HeadTail<T extends RoTuple, Head extends T[number], Tail extends RoTuple<T[number]>> =
  readonly [Head, ...Tail];

//[...runtimeValues, last] has no fixed head, but last is still guaranteed to occur.
//  Peeling either end suits order-independent folds; the middle may remain an unknown-length array
export type ElementRest<T extends RoArray> =
  T extends readonly [infer E extends T[number], ...infer R extends RoArray<T[number]>]
  ? [E, R]
  : T extends readonly [...infer R extends RoArray<T[number]>, infer E extends T[number]]
  ? [E, R]
  : undefined;

export type Primitive = string | number | bigint | boolean | symbol | null | undefined;

export type Widen<T> =
  T extends string  ? string  :
  T extends number  ? number  :
  T extends boolean ? boolean :
  T extends bigint  ? bigint  :
  T extends symbol  ? symbol  :
  T extends object  ? object  :
  T;

export type If<C extends boolean, T, F> = C extends true ? T : F;

export type Extends<T, U> = T extends U ? true : false;
export type AnyExtend<T, U> = true extends Extends<T, U> ? true : false;
export type AllExtend<T, U> = [T] extends [U] ? true : false;

//`any` is the only type that distributes a naked conditional into both branches at once. The
//  more familiar `0 extends 1 & T` idiom silently answers false whenever T is a type parameter
//  whose constraint rules the intersection out - `1 & T` reduces to never under `T extends object`
//  or `T extends string` - so it cannot be used in the bounded positions that most need it
export type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false;

//must be the non-distributive check: a naked conditional over never short-circuits to never
export type IsNever<T> = AllExtend<T, never>;

//distributes over T, so each constituent is compared against the whole
export type IsUnion<T, U = T> = T extends unknown ? Not<AllExtend<U, T>> : never;

//A key (or index) argument names a definite set only when every key is spelled out: a single
//  literal key, or a fixed tuple of them. A union key or a runtime array may select any subset.
export type ExactKeys<K> =
  [K] extends [RoArray]
  ? If< IsFixedTuple<K>,
        AllExtend<{ [I in keyof K]: Not<IsUnion<K[I]>> }[number], true>,
        false>
  : Not<IsUnion<K>>;

//a template literal pattern also fails `string extends T`; case-folding tells the two apart
//  because folding a literal twice lands where folding it once does, while a pattern keeps a
//  `${string}` hole that the second folding widens
type IsStringLiteral<T extends string> =
  If<Extends<string, T>,
    false,
    And<Extends<Uppercase<T>, Uppercase<Lowercase<T>>>,
        Extends<Lowercase<T>, Lowercase<Uppercase<T>>>>
  >;

//a conditional chain rather than `If`s: each branch narrows T to the primitive it tests for
type IsNonUnionLiteral<T> =
    T extends string  ? IsStringLiteral<T>
  : T extends number  ? Not<Extends<number, T>>
  : T extends bigint  ? Not<Extends<bigint, T>>
  : T extends boolean ? true
  : T extends symbol  ? Not<Extends<symbol, T>>
  : Extends<T, null | undefined>;

//whether T is a single primitive value: a string, number, bigint or boolean literal, a unique
//  symbol, null or undefined. For such a type, and only such a type, "same type" means "same value"
export type IsLiteral<T> = If<Or<IsNever<T>, IsUnion<T>>, false, IsNonUnionLiteral<T>>;

export type IsInteger<N extends number> = Extends<`${N}`, `${bigint}`>;

export type IsSigned<N extends number> = Extends<`${N}`, `-${string}`>;

//what a class type guard narrows T to: T's own C-constituents when it has any (so a union keeps
//  exactly its matching members), the plain intersection otherwise (so an unknown narrows to C)
export type NarrowTo<T, C> = If<IsNever<Extract<T, C>>, T & C, Extract<T, C>>;

//The boolean algebra below is three-valued: an indeterminate `boolean` operand propagates,
//  unless an absorbing operand settles the result regardless (false for And, true for Or;
//  Xor has none).
export type Not<B extends boolean> = B extends true ? false : true;

type _Junction<T extends RoArray<boolean>, Absorb extends boolean, Ind extends boolean = false> =
  T extends unknown
  ? ElementRest<T> extends [infer E extends boolean, infer R extends RoArray<boolean>]
    ? AllExtend<E, Absorb> extends true
      ? Absorb
      : _Junction<R, Absorb, boolean extends E ? true : Ind>
    //a runtime middle may be empty; only neutral elements leave the result determinate
    : AllExtend<T[number], Not<Absorb>> extends true
    ? If<Ind, boolean, Not<Absorb>>
    : boolean
  : never;

//takes an array of operands or a single one; R contributes one more operand either way.
//  The `infer` indirection is required because the unreduced conditional leaks `boolean`
//  into the operand-list constraint (same reason Xor needs it below)
type Junction<T extends RoArray<boolean> | boolean, R extends boolean, Absorb extends boolean> =
  (T extends RoArray<boolean> ? readonly [...T, R] : RoPair<T, R>) extends
    infer Operands extends RoArray<boolean>
  ? _Junction<Operands, Absorb>
  : never;

//empty And is true (neutral element)
export type And<T extends RoArray<boolean> | boolean, R extends boolean = true> =
  Junction<T, R, false>;

//empty Or is false (neutral element)
export type Or<T extends RoArray<boolean> | boolean, R extends boolean = false> =
  Junction<T, R, true>;

//`boolean extends A | B` would also hold for two determinate, differing operands, so
//  indeterminacy is tested per operand
type Xor2<A extends boolean, B extends boolean> =
  boolean extends A
  ? boolean
  : boolean extends B
  ? boolean
  : [A] extends [B] ? false : true;

type _Xor<T extends RoArray<boolean>, Acc extends boolean = false> =
  T extends unknown
  ? ElementRest<T> extends [infer E extends boolean, infer R extends RoArray<boolean>]
    ? _Xor<R, Xor2<Acc, E>>
    : If<AllExtend<T[number], false>, Acc, boolean>
  : never;

//the bracketed check keeps a bare `boolean` operand from distributing into two determinate ones
export type Xor<T extends RoArray<boolean> | boolean, R extends boolean | undefined = undefined> =
  ([T] extends [RoArray<boolean>] ? T : [T]) extends infer Operands extends RoArray<boolean>
  ? [...Operands, ...(undefined extends R ? [] : [Exclude<R, undefined>])] extends
      infer V extends RoArray<boolean>
    ? _Xor<V>
    : never
  : never;

//functions pass through: a homomorphic mapped type over a call signature keeps no signature.
//  Being a conditional, this stays deferred over an open type parameter - a generic position
//  whose result has to satisfy a constraint needs `Readonly` directly
export type Ro<T> =
  T extends Primitive //a branded primitive is an intersection, so Readonly would map over its base
  ? T
  : T extends RoUint8Array
  ? RoUint8Array
  : T extends Function
  ? T
  : Readonly<T>;

export const ro = <const T>(value: T): Ro<T> => value as Ro<T>;

export type DeepRo<T> =
  IsAny<T> extends true //prevent DeepRo<any> from giving type instantiation too deep error
  ? any
  : T extends Primitive
  ? T
  : T extends RoUint8Array
  ? RoUint8Array
  : T extends Function
  ? T
  : T extends object
  ? { readonly [K in keyof T]: DeepRo<T[K]> }
  : T;

export const deepRo = <const T>(value: T): DeepRo<T> => value as DeepRo<T>;

export type Mutable<T> =
  T extends Primitive
  ? T
  : T extends RoUint8Array
  ? Uint8Array
  : T extends Function
  ? T
  : { -readonly [P in keyof T]: T[P] };

export const mutable = <const T>(value: T): Mutable<T> => value as Mutable<T>;

export type DeepMutable<T> =
  IsAny<T> extends true
  ? any
  : T extends Primitive
  ? T
  : T extends RoUint8Array
  ? Uint8Array
  : T extends Function
  ? T
  : T extends object
  ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
  : T;

export const deepMutable = <const T>(value: T): DeepMutable<T> => value as DeepMutable<T>;
