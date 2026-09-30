import type { RoPair, RoTuple, RoArray, RoUint8Array,
              HeadTail, Extends, AnyExtend, Not, And, If,
              ExactKeys, IsInteger, IsSigned, IsFixedTuple, AsFixedTuple } from "./typing.js";

export function isArray<T>(val: T | RoArray<T>): val is RoArray<T>;
export function isArray<T>(val: T): val is Extract<T, RoArray>;
export function isArray(val: unknown): boolean {
  return Array.isArray(val);
}

//works across realms: instanceof settles the common case, and only a foreign view falls through
//  to the tag, whose getter is what makes the check slow
export function isUint8Array<T>(value: T): value is T extends RoUint8Array ? T : T & Uint8Array {
  return value instanceof Uint8Array || (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

export type RoTuple2D<T = unknown> = RoTuple<RoTuple<T>>;
export type RoArray2D<T = unknown> = RoArray<RoArray<T>>;

export type PreserveReadonly<A extends RoArray, R extends RoArray> =
  A extends unknown[]
  ? R
  : Readonly<R>;

type IsUnsignedInteger<N extends number> = And<IsInteger<N>, Not<IsSigned<N>>>;

type _TupleRange<L extends number, A extends number[] = []> =
  A["length"] extends L
  ? A
  : _TupleRange<L, [...A, A["length"]]>;

//the impl has to sit in a branch rather than in an `If` argument: type arguments are
//  instantiated eagerly, so a non-uint L would exhaust the recursion budget (TS2589, degrading
//  to `any`) before the predicate is ever consulted
export type TupleRange<L extends number> =
  L extends unknown
  ? IsUnsignedInteger<L> extends true
    ? _TupleRange<L>
    : never
  : never;

export type Range<L extends number> =
  L extends unknown
  ? number extends L
    ? number[]
    : TupleRange<L>
  : never;

//the `never` from TupleRange<number> would satisfy the infer clause and map to `[]`
export type TupleOfLength<T, L extends number> =
  number extends L
  ? never
  : TupleRange<L> extends infer R extends RoArray<number>
  ? [...{ [K in keyof R]: T }]
  : never;

export type RoTupleOfLength<T, L extends number> =
  TupleOfLength<T, L> extends infer R extends unknown[] ? readonly [...R] : never;

export type OfLength<T, L extends number> =
  number extends L
  ? T[]
  : TupleOfLength<T, L>;

export type RoOfLength<T, L extends number> =
  number extends L
  ? RoArray<T>
  : RoTupleOfLength<T, L>;

export const range = <L extends number>(length: L) =>
  Array.from({ length }, (_, i) => i) as Range<L>;

export type MaybeArray<T> = T | RoArray<T>;
export type ElementOf<P> = P extends RoArray<infer T> ? T : P;

export type MapArrayness<P, R> = P extends RoArray ? { [K in keyof P]: R } : R;

type MapFunc<P> = (value: ElementOf<P>) => unknown;
type MappedRet<P, F extends MapFunc<P>> = MapArrayness<P, ReturnType<F>>;
export type MapTo<P> = <F extends MapFunc<P>>(f: F) => MappedRet<P, F>;
//normal tuple.map does not yield a tuple, but an array, i.e.:
//  const func = (x: number) => x.toString();
//  const tup = [1, 2, 3] as const;
//  tup.map(func); // => string[], not readonly [string, string, string]
//with mapTo, however:
//  mapTo(tup)(func); // => readonly [string, string, string]
//and of course:
//  mapTo(tup as number[])(func); // => string[]
//and finally, mapTo can also be used with a single value too:
//  mapTo(1)(func); // => string
export const mapTo = <const P>(p: P): MapTo<P> =>
  <F extends MapFunc<P>>(f: F): MappedRet<P, F> =>
    (isArray(p) ? (p as RoArray<ElementOf<P>>).map(v => f(v)) : f(p as ElementOf<P>)) as any;

//capitalization to highlight that this is intended to be a literal or a union of literals
type IndexEs = number;

export type TupleEntries<T extends RoTuple> =
  IsFixedTuple<T> extends true
  ? [...{ [K in keyof T]: K extends `${infer N extends number}` ? [N, T[K]] : never }]
  : never;

//const aware version of Array.entries
export type Entries<A extends RoArray> =
  A extends AsFixedTuple<A> ? TupleEntries<A> : [number, A[number]][];

export function entries<const T extends RoArray>(arr: T): Entries<T> {
  return [...arr.entries()] as Entries<T>;
}

export type ValueIndexTupleEntries<T extends RoTuple> =
  IsFixedTuple<T> extends true
  ? [...{ [K in keyof T]: K extends `${infer N extends number}` ? [T[K], N] : never }]
  : never;

//const aware version of Array.entries but with value first, index second
export type ValueIndexEntries<T extends RoArray> =
  T extends AsFixedTuple<T> ? ValueIndexTupleEntries<T> : [T[number], number][];

export function valueIndexEntries<const T extends RoArray>(arr: T): ValueIndexEntries<T> {
  return arr.map((value, index) => [value, index]) as ValueIndexEntries<T>;
}

export type IsArray<T> = Extends<T, RoArray>;
export type IsFlat<A extends RoArray> = Not<AnyExtend<A[number], RoArray>>;

//elements must be tuples or scalars - Flatten handles the degradation for unbounded
//  array elements
export type TupleFlatten<T extends RoTuple> =
  IsFixedTuple<T> extends true
  ? T extends HeadTail<T, infer Head, infer Tail>
    ? Head extends RoTuple
      ? [...Head, ...TupleFlatten<Tail>]
      : [Head, ...TupleFlatten<Tail>]
    : []
  : never;

type StripArray<T> = T extends RoArray<infer E> ? E : T;

//an unbounded element - a plain array or an open-tailed tuple - makes the flattened shape
//  unknowable (a tuple type can hold at most one unbounded spread), so such tuples degrade to a
//  plain array, as does an open tail on the tuple itself
type HasUnboundedElement<T extends RoTuple> =
  T[number] extends infer E
  ? E extends RoArray ? Not<IsFixedTuple<E>> : false
  : never;

export type Flatten<A extends RoArray> =
  A extends AsFixedTuple<A>
  ? true extends HasUnboundedElement<A>
    ? StripArray<A[number]>[]
    : TupleFlatten<A>
  : StripArray<A[number]>[];

export const flatten = <const A extends RoArray>(arr: A) =>
  arr.flat() as Flatten<A>;

//an element key is an index string over a tuple, but `number` over a plain array
export type InnerFlatten<A extends RoArray> =
  [...{ [K in keyof A]:
    K extends `${number}` | number
    ? A[K] extends RoArray
      ? Flatten<A[K]>
      : A[K]
    : never
  }];

export type Unflatten<A extends RoArray> =
  [...{ [K in keyof A]: K extends `${number}` | number ? [A[K]] : never }];

type _TupleChunk<T extends RoTuple, N extends number, PC extends RoTuple = []> =
  PC["length"] extends N
  ? [T, PC]
  : T extends HeadTail<T, infer Head, infer Tail>
  ? _TupleChunk<Tail, N, [...PC, Head]>
  : [[], PC];

export type TupleChunk<T extends RoTuple, N extends number> =
  number extends N
  ? never
  : IsFixedTuple<T> extends false
  ? never
  : _TupleChunk<T, N> extends [infer R extends RoTuple, infer C]
  ? C extends readonly []
    ? []
    : [C, ...TupleChunk<R, N>]
  : never;

type ArrayChunk<A extends RoArray> = A extends RoArray<infer U> ? U[][] : never;

export type Chunk<A extends RoArray, N extends number> =
  A extends AsFixedTuple<A>
  ? number extends N
    ? ArrayChunk<A>
    : N extends unknown //distribute over unions of sizes
    ? TupleChunk<A, N>
    : never
  : ArrayChunk<A>;

//non-positive sizes get no defensive handling: a codebase where a chunk size of 0 can even
//  reach this call has problems that no check here could fix
export const chunk = <const A extends RoArray, N extends number>(arr: A, size: N): Chunk<A, N> =>
  range(Math.ceil(arr.length / size)).map(i => arr.slice(i * size, (i+1) * size)) as Chunk<A, N>;

export type IsRectangular<T extends RoTuple> =
  T extends RoTuple2D
  ? T extends HeadTail<T, infer Head extends RoTuple, infer Tail extends RoTuple2D>
    ? Tail extends readonly []
      ? true //a column is rectangular
      : Tail[number]["length"] extends Head["length"] ? true : false
    : true //empty is rectangular
  : true; //a row is rectangular

export type Column<A extends RoArray2D, I extends number> =
  [...{ [K in keyof A]: K extends `${number}` | number ? A[K][I] : never }];

export const column = <const A extends RoArray2D, I extends number>(tupArr: A, index: I) =>
  tupArr.map(tuple => tuple[index]) as Column<A, I>;

export type TupleZip<T extends RoTuple2D> =
  IsRectangular<T> extends true
  ? T[0] extends infer Head extends RoTuple
    ? [...{ [K in keyof Head]:
        K extends `${number}`
        ? [...{ [K2 in keyof T]: K extends keyof T[K2] ? T[K2][K] : never }]
        : never
      }]
    : []
  : never;

export type Zip<A extends RoArray2D> =
  A extends RoTuple2D
  ? And<IsFixedTuple<A>, IsFixedTuple<A[number]>> extends true
    ? TupleZip<A>
    : Flatten<A>[number][][]
  : A extends infer T extends RoTuple
  ? [...{ [K in keyof T]: T[K] extends RoArray ? T[K][number] : never }][]
  : A extends RoArray<infer T extends RoTuple>
  ? [...{ [K in keyof T]: T[K][] }]
  : Flatten<A>[number][][];

//rectangularity of runtime (non-tuple) rows is uncheckable: ragged input yields undefined
//  holes typed as element values (tuple rows are caught by IsRectangular -> never)
export const zip = <const Args extends RoArray2D>(arr: Args) =>
  Array.from({ length: arr[0]?.length ?? 0 }, (_, col) => arr.map(row => row[col])) as Zip<Args>;

//a runtime index can land anywhere, including past the end
type PickAt<A extends RoArray, I extends number> =
  number extends I
  ? A[number] | undefined
  : IsFixedTuple<A> extends true
  ? A[I]
  : A[number] | undefined;

//the indexes decide the output's length, so they alone must be a tuple; the elements they pick
//  are as exact as the array allows
export type TuplePickWithOrder<A extends RoArray, I extends RoTuple<number>> =
  IsFixedTuple<I> extends true
  ? I extends HeadTail<I, infer Head, infer Tail>
    ? [PickAt<A, Head>, ...TuplePickWithOrder<A, Tail>]
    : []
  : never;

export type PickWithOrder<A extends RoArray, I extends RoArray<number>> =
  I extends AsFixedTuple<I> ? TuplePickWithOrder<A, I> : PickAt<A, number>[];

export const pickWithOrder =
  <const A extends RoArray, const I extends RoArray<number>>(arr: A, indexes: I) =>
    indexes.map(i => arr[i]) as PickWithOrder<A, I>;

type _FilterIndexesKeep<T extends RoTuple, I extends IndexEs> =
  T extends HeadTail<T, infer Head, infer Tail>
  ? Head extends RoPair<infer J extends number, infer V>
    ? J extends I
      ? [V, ..._FilterIndexesKeep<Tail, I>]
      : _FilterIndexesKeep<Tail, I>
    : never
  : [];

type _FilterIndexesRemove<T extends RoTuple, I extends IndexEs> =
  T extends HeadTail<T, infer Head, infer Tail>
  ? Head extends RoPair<infer J extends number, infer V>
    ? J extends I
      ? _FilterIndexesRemove<Tail, I>
      : [V, ..._FilterIndexesRemove<Tail, I>]
    : never
  : [];

export type FilterIndexes<A extends RoArray, I extends IndexEs, FilterOut extends boolean = false> =
  A extends AsFixedTuple<A>
  ? number extends I //a runtime index set can't say which elements survive
    ? A[number][]
    : boolean extends FilterOut //neither can an indeterminate direction
    ? A[number][]
    : TupleEntries<A> extends infer E extends RoTuple
    ? FilterOut extends true
      ? _FilterIndexesRemove<E, I>
      : _FilterIndexesKeep<E, I>
    : never
  : A[number][]; //nor can an open tail

export const filterIndexes = <
  const T extends RoArray,
  const I extends MaybeArray<number>,
  const E extends boolean = false,
>(arr: T, indexes: I, exclude?: E) => {
  const indexSet = new Set(isArray(indexes) ? indexes : [indexes]);
  return arr.filter((_, i) =>
    indexSet.has(i) !== (exclude ?? false)
  ) as If<ExactKeys<I>, FilterIndexes<T, ElementOf<I>, E>, T[number][]>;
};

//scalar operands act as singletons; a scalar-scalar product is the bare pair
export type Cartesian<L, R> =
  L extends RoArray
  ? Flatten<[...{ [K in keyof L]:
      K extends `${number}` | number
      ? L[K] extends RoArray
        ? Cartesian<L[K], R>
        : R extends RoArray
        ? Cartesian<L[K], R>
        : [[L[K], R]] //scalar-scalar yields a bare pair, which the flatten would splice open
      : never
    }]>
  : R extends RoArray
  ? [...{ [K in keyof R]: K extends `${number}` | number ? [L, R[K]] : never }]
  : [L, R];
