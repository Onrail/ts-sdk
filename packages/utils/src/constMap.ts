//What a spec means, what the shape parameter selects and how the resulting maps behave is
//  documented in the README; this header only covers what is needed to follow the implementation,
//  and the walkthrough comments below refer to the README's `units` example.
//
//The type level and the runtime follow the same 4 stages (TransformMapping resp. toMapping):
//  1. CartesianRightRecursive flattens the spec tree into one row per leaf value
//  2. the shape splits those rows' columns into key and value columns, reordering as specified
//  3. ProcessNextKeyColumn regroups the rows by the successive key columns
//  4. ObjectFromMappingEntries turns the resulting entries into the nested object type that the
//     lookup signatures index into (the runtime fuses this into stage 3 and builds nested Maps)
//For the default shape the type level short-circuits stages 2 and 3, since the spec's own nesting
//  already is that grouping and stage 1 then only establishes that the rows are rectangular and
//  non-empty; the runtime materializes the default shape and runs the stages regardless.

//dev notes
//K  = key
//M  = mapping entries (a spec like units)
//KC = key columns
//VC = value columns
//VR = value rows

import type { RoTuple2D, RoArray2D,
              ValueIndexTupleEntries, Flatten, InnerFlatten,
              IsRectangular, TupleZip, Cartesian, TuplePickWithOrder } from "./array.js";
import { range, zip } from "./array.js";
import type { RoTuple, RoNeTuple, RoArray, RoPair, HeadTail, Widen, Function } from "./typing.js";

//symbol probably shouldn't be part of the union (but then our type isn't a superset of PropertyKey
//  anymore which comes with its own set of headaches)
export type MappableKey = PropertyKey | bigint | boolean;
function isMappableKey(key: unknown): key is MappableKey {
  return ["string", "number", "symbol", "bigint", "boolean"].includes(typeof key);
}

export type MapLevel<K extends MappableKey, V> = RoTuple<RoPair<K, V>>;

type MapLevelsTuple = readonly [MappableKey, ...RoTuple<MappableKey>, unknown];
export type MapLevels<T extends MapLevelsTuple> =
  T extends HeadTail<T, infer Head extends MappableKey, infer Tail>
  ? Tail extends MapLevelsTuple
    ? MapLevel<Head, MapLevels<Tail>>
    : MapLevel<Head, Tail[0]>
  : never;

//decrement table: Depth[D] is D-1, and its length caps how many key columns can be supported
type Depth = [never, 0, 1, 2, 3, 4];

//an object type indexes by string (or symbol), onto which every other key kind would collapse -
//  1, 1n and "1" onto one key - so the type level stores those under surrogate keys that stay
//  distinguishable (a string key spelled like a surrogate collides with it, but only in the types:
//  the runtime Maps key natively)
type ToExtPropKey<T extends MappableKey> =
  T extends number
  ? `number(${T})`
  : T extends bigint
  ? `bigint(${T})`
  : T extends boolean
  ? `boolean(${T})`
  : T;

type FromExtPropKey<T extends PropertyKey> =
  T extends `number(${infer V extends number})`
  ? V
  : T extends `bigint(${infer V extends bigint})`
  ? V
  : T extends `boolean(${infer V extends boolean})`
  ? V
  : T;

export type MappingEntry<V = unknown> = RoPair<MappableKey, V>;
export type MappingEntries<V = unknown> = RoTuple<MappingEntry<V>>;

//Recursively sifts through T combining all row indexes that have key K.
//Matching rows (i.e. those with key K) have their indexes placed in IA, non-matching (unfiltered)
//  entries go to U.
type CombineKeyRowIndexes<
  K extends MappableKey,
  T extends MappingEntries<number>,
  IA extends RoTuple<number>, //all values associated with K
  U extends MappingEntries<number> = [], //rows that have been scanned and are not associated with K
> =
  T extends HeadTail<T, infer Head, infer Tail>
  ? Head[0] extends K
    ? CombineKeyRowIndexes<K, Tail, [...IA, Head[1]], U>
    : CombineKeyRowIndexes<K, Tail, IA, [...U, Head]>
  : [IA, U];

//Takes a key column and its indexes (KCI) and for each key creates the set of all row indices
//  that have that key
//In the example for the default shape, it takes the system column and turns
//  [["si", 0], ["si", 1], ["si", 2], ["nautical", 3], ["nautical", 4]]
//into [["si", [0,1,2]], ["nautical", [3,4]]].
type ToMapEntries<KCI extends MappingEntries<number>, M extends MappingEntries = []> =
  KCI extends HeadTail<KCI, infer Head, infer Tail>
  ? Head extends RoPair<infer K extends MappableKey, infer V extends number>
    ? CombineKeyRowIndexes<K, Tail, [V]> extends RoPair<
        infer IA extends RoTuple,
        infer KCIU extends MappingEntries<number>
      >
      ? ToMapEntries<KCIU, [...M, [K, IA]]>
      : never
    : never
  : M;

type CartesianRightRecursive<M extends RoTuple> =
  M extends infer IM extends MappingEntries<RoTuple>
  ? Flatten<[...{ [K in keyof IM]:
    K extends `${number}`
    ? InnerFlatten<Cartesian<IM[K][0], CartesianRightRecursive<IM[K][1]>>>
    : never
  }]>
  : M extends infer IM extends MappingEntry<RoTuple>
  ? Cartesian<IM[0], IM[1]>
  : M;

type Shape = RoPair<RoTuple<number>, RoTuple<number>>; //key columns, value columns
type IndexLike = number | RoNeTuple<number>;
export type ShapeLike = RoPair<IndexLike, IndexLike>;
type ShapeLikeToShape<S extends ShapeLike> =
  S extends RoPair<infer KC extends IndexLike, infer VC extends IndexLike>
  ? [KC extends number ? [KC] : KC, VC extends number ? [VC] : VC]
  : never;

type CartesianSet<T = unknown> = RoTuple2D<T>; //CartesianSet is always rectangular
type Transpose<T extends RoTuple2D, E = unknown> =
  TupleZip<T> extends infer R extends RoTuple2D<E>
  ? R
  : never;

type KeyRowIndexes = MappingEntries<RoTuple<number>>;
type KeyColumnToKeyRowIndexes<KC extends RoTuple<MappableKey>> =
  ValueIndexTupleEntries<KC> extends infer VIE extends MappingEntries<number>
  ? ToMapEntries<VIE>
  : never;

//must agree with the runtime eliminateDuplicates on which duplicate survives: the first. The
//  shorter `Head extends Tail[number]` formulation keeps the last instead and hence reorders
//  non-contiguous repeats
type EliminateDuplicates<R extends RoTuple, Seen extends RoTuple = []> =
  R extends HeadTail<R, infer Head, infer Tail>
  ? Head extends Seen[number]
    ? EliminateDuplicates<Tail, Seen>
    : [Head, ...EliminateDuplicates<Tail, [...Seen, Head]>]
  : R;

//Takes the first of the remaining key columns and splits it into chunks that share the same key
//  value. Then invokes itself for each sub-chunk passing along only those value rows that belong
//  to that chunk. The row indexes are the column's own, so every pick is in range; the infer
//  guard discharges the `undefined` that a `number`-typed index carries while KRI is open, and
//  its miss is the last key column, where no columns remain to transpose.
//In the example for the default shape, it starts with the system column and splits it into the
//  "si" and "nautical" chunk. The first chunk gets the first 3 rows, the second chunk gets the
//  last 2. Then the "si" chunk is recursively split into 3 chunks again, ...
type ProcessNextKeyColumn<KC extends CartesianSet<MappableKey>, VR extends RoTuple> =
  KC extends HeadTail<KC, infer Head, infer Tail>
  ? KeyColumnToKeyRowIndexes<Exclude<Head, undefined>> extends infer KRI extends KeyRowIndexes
    ? [...{ [K in keyof KRI]: [
        KRI[K][0],
        ProcessNextKeyColumn<
          TuplePickWithOrder<Transpose<Tail>, KRI[K][1]> extends infer Rows extends RoTuple2D
          ? Transpose<Rows, MappableKey>
          : [],
          TuplePickWithOrder<VR, KRI[K][1]>
        >,
      ] }]
    : never
  : EliminateDuplicates<VR>;

//We encode leaf values as tuples of void (which does not constitute a value type and hence can't
//  come from the user) and the actual value. This allows us to later distinguish whether a value
//  is a single (singleton) leaf value and hence whether the mapping is injective (= only one value
//  per full key group) or not.
type LeafValue<T = unknown> = RoPair<void, T>;

//Takes the value columns and combines them into leaf value rows.
type CombineValueColumnsToLeafValues<VC extends CartesianSet> =
  //if we only have a single value column, we don't have to use tuples for values
  (VC["length"] extends 1 ? VC[0] : Transpose<VC>) extends infer VCT extends RoTuple
  ? [...{ [K in keyof VCT]: K extends `${number}` ? LeafValue<VCT[K]> : never }]
  : never;

//Takes a full cartesian set in row order and splits it into its key and value columns according to
//  the specified shape.
type SplitAndReorderKeyValueColumns<R extends CartesianSet, S extends Shape> =
  Transpose<R> extends infer C extends CartesianSet
  ? [TuplePickWithOrder<C, S[0]>, TuplePickWithOrder<C, S[1]>]
  : never;

//returns the mapping with "unwrapped" values (i.e. turns the singleton arrays back into their one
//  constituent element) if all leaves are indeed singletons, otherwise returns void
type UnwrapValuesIfAllAreSingletons<M extends MappingEntries, D extends Depth[number]> =
  D extends 1
  ? M extends infer IM extends MappingEntries<readonly [LeafValue]>
    ? [...{ [K in keyof IM]: K extends `${number}` ? [M[K][0], M[K][1][0][1]] : never }]
    : void
  : M extends infer IM extends MappingEntries<MappingEntries>
  ? [...{ [K in keyof IM]: K extends `${number}`
      ? [IM[K][0], UnwrapValuesIfAllAreSingletons<IM[K][1], Depth[D]>]
      : never
    }] extends infer U extends MappingEntries
    ? U extends MappingEntries<infer T>
      ? void extends T
        ? void
        : U
      : never
    : never
  : never;

type MaybeUnwrapValuesIfAllAreSingletons<M extends MappingEntries, D extends Depth[number]> =
  UnwrapValuesIfAllAreSingletons<M, D> extends infer V extends MappingEntries ? V : M;

//creates the transformed mapping and its key column count
type TransformMapping<M extends MappingEntries, S extends Shape | void = void> =
  //check that M has a valid structure for mapping entries
  CartesianRightRecursive<M> extends infer CRR extends RoTuple2D
  ? IsRectangular<CRR> extends true
    //ensure CRR is not empty
    ? CRR extends RoNeTuple<RoTuple>
      ? S extends Shape
        ? SplitAndReorderKeyValueColumns<CRR, S> extends [
          infer KC extends CartesianSet<MappableKey>,
          infer VC extends CartesianSet,
        ]
        ? KC["length"] extends infer D extends Depth[number]
          ? CombineValueColumnsToLeafValues<VC> extends infer VR extends RoTuple<LeafValue>
            ? ProcessNextKeyColumn<KC, VR> extends infer TM extends MappingEntries
              ? [MaybeUnwrapValuesIfAllAreSingletons<TM, D>, D]
              : never
            : never
          : never
        : never
      //if we don't have an explicit shape, take the first row and subtract 1 (for the value
      //  column) to determine the count of key columns
      : CRR[0] extends readonly [...infer KC extends RoTuple, unknown]
        ? KC["length"] extends infer D extends Depth[number]
          ? [M, D]
          : never
        : never
      : never
    : never
  : never;

type ObjectFromMappingEntries<M extends MappingEntries, D extends Depth[number]> = {
  [K in keyof M as (K extends `${number}` ? ToExtPropKey<M[K][0]> : never)]:
  M[K] extends infer ME extends MappingEntry ?
    ME[1] extends infer V
    ? D extends 1
      ? V extends LeafValue<infer T>
        ? T
        : V extends RoTuple<LeafValue>
        ? [...{ [K2 in keyof V]: K2 extends `${number}` ? V[K2][1] : never }]
        : V
      : V extends MappingEntries
      ? ObjectFromMappingEntries<V, Depth[D]>
      : never
    : never
  : never
};

type ToMappingAndDepth<
  M extends MappingEntries,
  S extends ShapeLike | undefined,
> =
  TransformMapping<M, S extends ShapeLike ? ShapeLikeToShape<S> : void> extends [
    infer TM extends MappingEntries,
    infer D extends Depth[number],
  ]
  ? [ObjectFromMappingEntries<TM, D>, D]
  : never;

type Mapped = { [key: PropertyKey]: unknown };

type RecursiveAccess<M, KA extends RoTuple<MappableKey>> =
  KA extends HeadTail<KA, infer Head, infer Tail>
  ? M extends Mapped
    ? RecursiveAccess<M[ToExtPropKey<Head>], Tail>
    : never
  : M;

//4 layers deep ought to be enough for anyone ;) (couldn't figure out a way to make this recursive
//  as to avoid having to hardcode arity...)
type GenericMappingFunc<M extends Mapped, D extends number> =
  D extends 1
  ? <K1 extends FromExtPropKey<keyof M>
    >(...args: readonly [K1]) => RecursiveAccess<M, [K1]>
  : D extends 2
  ? <K1 extends FromExtPropKey<keyof M>,
     K2 extends FromExtPropKey<keyof RecursiveAccess<M, [K1]>>,
    >(...args: readonly [K1, K2]) => RecursiveAccess<M, [K1, K2]>
  : D extends 3
  ? <K1 extends FromExtPropKey<keyof M>,
     K2 extends FromExtPropKey<keyof RecursiveAccess<M, [K1]>>,
     K3 extends FromExtPropKey<keyof RecursiveAccess<M, [K1, K2]>>,
    >(...args: readonly [K1, K2, K3]) => RecursiveAccess<M, [K1, K2, K3]>
  : D extends 4
  ? <K1 extends FromExtPropKey<keyof M>,
     K2 extends FromExtPropKey<keyof RecursiveAccess<M, [K1]>>,
     K3 extends FromExtPropKey<keyof RecursiveAccess<M, [K1, K2]>>,
     K4 extends FromExtPropKey<keyof RecursiveAccess<M, [K1, K2, K3]>>,
    >(...args: readonly [K1, K2, K3, K4]) => RecursiveAccess<M, [K1, K2, K3, K4]>
  : never;

type SubMap<M extends Mapped, D extends number, K extends PropertyKey> =
  K extends keyof M
  ? M[K] extends Mapped
    ? _ConstMap<M[K], Depth[D]>
    : never
  : never;

type SubMapFunc<M extends Mapped, D extends number> =
  { readonly subMap: <K extends FromExtPropKey<keyof M>>(key: K) => SubMap<M, D, ToExtPropKey<K>> };

//both distribute: `keyof` over a union of sub-maps yields only their common keys, which would
//  drop every key (and hence value) that exists in just some of them
type KeysOfObjectUnion<T> = T extends unknown ? keyof T : never;
type ValsOfObjectUnion<T> = T extends unknown ? T[keyof T] : never;

type WidenedParamsAndRetRec<M extends Mapped, D extends number> =
  D extends 1
  ? [ValsOfObjectUnion<M>]
  : ValsOfObjectUnion<M> extends infer SubMapUnion extends Mapped
  ? WidenedParamsAndRet<SubMapUnion, Depth[D]>
  : never;

type WidenedParamsAndRet<M extends Mapped, D extends number> =
  [Widen<FromExtPropKey<KeysOfObjectUnion<M>>>, ...WidenedParamsAndRetRec<M, D>];

type HasGetFuncs<M extends Mapped, D extends number> =
  WidenedParamsAndRet<M, D> extends [...infer P extends RoTuple<unknown>, infer R]
  ? { readonly has: (...args: P) => boolean; readonly get: (...args: P) => R | undefined }
  : never;

type _ConstMap<M extends Mapped, D extends number> =
  D extends 1
  ? GenericMappingFunc<M, D> & HasGetFuncs<M, D>
  : GenericMappingFunc<M, D> & HasGetFuncs<M, D> & SubMapFunc<M, D>;

export type ConstMap<M extends MappingEntries, S extends ShapeLike | undefined = undefined> =
  ToMappingAndDepth<M, S> extends [infer TM extends Mapped, infer D extends Depth[number]]
  ? _ConstMap<TM, D>
  : never;

const isRecursiveTuple = (arr: RoArray) =>
  arr.length === 2 && !Array.isArray(arr[0]) && Array.isArray(arr[1]);

//leaf values are either single column values or rows thereof, hence the recursion into arrays
const leafValueEq = (lhs: unknown, rhs: unknown): boolean =>
  Array.isArray(lhs) && Array.isArray(rhs)
  ? lhs.length === rhs.length && lhs.every((ele, i) => leafValueEq(ele, rhs[i]))
  : lhs === rhs;

//counterpart of the type level EliminateDuplicates
const eliminateDuplicates = <T>(vals: RoArray<T>): T[] =>
  vals.filter((val, i) => i === vals.findIndex(other => leafValueEq(val, other)));

const cartesianRightRecursive =
  <const M extends MappingEntries>(me: M): CartesianRightRecursive<M> => (
    me.flatMap(([key, val]: MappingEntry) => (
      Array.isArray(val)
      ? (val.length > 0 && isRecursiveTuple(val[0]))
        ? cartesianRightRecursive(val as unknown as MappingEntries).map(ele => [key, ele].flat())
        : val.map(ele => [key, ele].flat())
      : [[key, val]]
  ))) as CartesianRightRecursive<M>;

//one per (shaped) key column, mapping onto the next column's map or, at the last, onto the leaf
//  values, so its value type is only known given the depth - any lets the lookups chain through
type KeyColumnMap = Map<MappableKey, any>;

//one closure per key column count instead of a loop over rest args, so that a lookup allocates
//  nothing. Each walks to the level holding the last key (undefined if the path left the map
//  early) and hands it to `atLast`; `has` asks that level itself because a leaf may hold a
//  nullish value.
const lookups = (
  atLast: (level: KeyColumnMap | undefined, key: MappableKey) => unknown,
): RoArray<(root: KeyColumnMap) => Function<RoArray<MappableKey>>> => [
  root =>  k1              => atLast(root, k1),
  root => (k1, k2)         => atLast(root.get(k1), k2),
  root => (k1, k2, k3)     => atLast(root.get(k1)?.get(k2), k3),
  root => (k1, k2, k3, k4) => atLast(root.get(k1)?.get(k2)?.get(k3), k4),
];
const getters  = lookups((level, key) => level?.get(key));
const checkers = lookups((level, key) => level?.has(key) ?? false);

const toMapping = (
  mapping: MappingEntries,
  shape?:  ShapeLike,
): [root: KeyColumnMap, depth: number] => {
  const crr: RoArray2D = cartesianRightRecursive(mapping);
  if (crr.length === 0)
    throw new Error("Invalid mapping: empty");

  const definedShape = (shape === undefined)
    ? [range(crr[0]!.length - 1), [crr[0]!.length - 1]]
    : shape.map(ind => typeof ind === "number" ? [ind] : ind);

  const leafMaps: KeyColumnMap[] = [];
  let allSingletons = true;
  const buildMappingRecursively = (
    keyCartesianSet: MappableKey[][],
    values: RoArray2D,
  ): KeyColumnMap => {
    const distinctKeys = [...new Set<MappableKey>(keyCartesianSet[0]).values()];
    const keyRows = new Map<MappableKey, number[]>(distinctKeys.map(key => [key, []]));
    for (const [i, key] of keyCartesianSet[0]!.entries())
      keyRows.get(key)!.push(i);

    if (keyCartesianSet.length === 1) {
      //the default shape's type takes the spec as it is, one leaf per row, so a repeated key
      //  path has no single value to answer with (an explicit shape groups instead)
      if (shape === undefined)
        for (const [key, rows] of keyRows)
          if (rows.length > 1)
            throw new Error(`Invalid mapping: key path repeats at ${String(key)}`);

      const leafValueRows = distinctKeys.map(key => eliminateDuplicates(
        keyRows.get(key)!.map(i => values[i]!.length === 1 ? values[i]![0] : values[i]),
      ));
      const ret: KeyColumnMap = new Map(distinctKeys.map((key, i) => [key, leafValueRows[i]!]));

      if (allSingletons) {
        if (leafValueRows.some(rows => rows.length > 1))
          allSingletons = false;
        else
          leafMaps.push(ret);
      }

      return ret;
    }

    const droppedKeyCol = zip(keyCartesianSet.slice(1));
    return new Map(distinctKeys.map((key) => {
      const rows = keyRows.get(key)!;
      const keyCartesianSubset = zip(rows.map(i => droppedKeyCol[i]!));
      const valuesSubset = rows.map(i => values[i]!);
      return [key, buildMappingRecursively(keyCartesianSubset, valuesSubset)];
    }));
  };

  const cols = zip(crr);
  const getCol = (col: number) => {
    const colArr = cols[col];
    if (colArr === undefined)
      throw new Error(`Invalid shape: column ${col} does not exist`);

    return colArr;
  };

  const [keyCartesianSet, leafValues] =
    definedShape.map(indx => indx.map(col => getCol(col)));

  //like the checks above, this guards a spec whose ConstMap type silently comes out as never
  if (keyCartesianSet!.length > getters.length)
    throw new Error(`Invalid shape: more than ${getters.length} key columns`);

  for (const keyCol of keyCartesianSet!)
    for (const key of keyCol)
      if (!isMappableKey(key))
        throw new Error(`Invalid key: ${key} in ${keyCol}`);

  const root = buildMappingRecursively(keyCartesianSet! as any, zip(leafValues!));

  if (allSingletons)
    for (const leafMap of leafMaps)
      for (const [key, vals] of leafMap)
        leafMap.set(key, vals[0]);

  return [root, keyCartesianSet!.length];
};

export function constMap<
  const M extends MappingEntries,
  const S extends ShapeLike | undefined = undefined,
>(mappingEntries: M, shape?: S): ConstMap<M, S> {
  const toConstMap = (root: KeyColumnMap, depth: number): ConstMap<M, S> => {
    const get = getters[depth - 1]!(root);
    return Object.assign(get, {
      has: checkers[depth - 1]!(root),
      get,
      ...(depth > 1 && { subMap: (key: MappableKey) => toConstMap(root.get(key), depth - 1) }),
    }) as unknown as ConstMap<M, S>;
  };
  return toConstMap(...toMapping(mappingEntries, shape));
}
