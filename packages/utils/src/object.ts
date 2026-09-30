import type { RoNeTuple, RoTuple, RoPair, HeadTail, ElementRest,
              Simplify, RoArray, If, Not, Extends, IsNever,
              IsAny, IsUnion, IsLiteral, AllExtend, ExactKeys, Function } from "./typing.js";
import type { MaybeArray, ElementOf } from "./array.js";
import { isArray } from "./array.js";

//What these helpers accept: own enumerable named keys, neither array nor callable. `object` is
//  the closest bound - it states that intent and rejects primitives - but it admits arrays and
//  callables, while `Record<PropertyKey, unknown>` would exclude every interface (interfaces get
//  no implicit index signature). So `Plain`, intersected at the argument, carries what the bound
//  cannot express - the FreshKey idiom below. Best-effort only: "has no prototype" is itself
//  inexpressible, so prototype-carrying instances (Date, Map) pass and get own-enumerable
//  treatment
//`O & Plain<O>` keeps O inferrable from the argument while collapsing to never for what the
//  bound admits but these helpers cannot handle. `any` needs no carve-out here: it distributes
//  into both branches, and `never | any` is any
type Plain<O> = O extends RoArray | Function ? never : O;

//the predicate form, for values whose object-ness is not yet established (a field's type):
//  true only when every union member is a plain object - one primitive, array, or callable
//  member already breaks the helpers' contract
type IsPlain<O> =
  If<IsAny<O>,
    true,
    If<AllExtend<O, object>,
      IsNever<Extract<O, RoArray | Function>>,
      false
    >
  >;

//key arguments can be compile-time tuples or runtime arrays
type KeyOrKeys<O extends object> = MaybeArray<keyof O>;

//A union key or a runtime array may select any subset at runtime, so what the selection claims
//  degrades to what it can promise - the selected keys optional, a replaced key admitting its old
//  value - rather than asserting the whole set.
type Picked<O extends object, K extends KeyOrKeys<O>> =
  If<ExactKeys<K>, Pick<O, ElementOf<K> & keyof O>, Partial<Pick<O, ElementOf<K> & keyof O>>>;

const isComposite = (val: unknown): val is object =>
  typeof val === "object" && val !== null;

// ---- Get ----

//type-level presence discriminator: definitely-present properties yield their type,
//  everything else - optional AND absent - yields undefined. For optional keys this
//  deliberately diverges from runtime access (which may well yield a value): a value
//  merely *annotated* with an interface declaring the key optional may lack it, and
//  consumers (e.g. binary-layout's HasCustom) must treat "not definitely there" as
//  absent. The Record clause (rather than a keyof test) also makes the lookup
//  distribute over unions of objects with disjoint keys
export type Get<O, K extends PropertyKey> =
  O extends Record<K, unknown> ? O[K] : undefined;

// ---- TrueKeys ----

//the type-level counterpart of filtering an object's keys by a predicate: since TS has no
//  type lambdas, the predicate is applied at the call site by mapping fields to a boolean
//  record, and this helper selects the keys mapped to true. Indexing rather than an `as`
//  clause, whose evaluated form emits a declaration that fails TS2536 (DeclarationEmit.md);
//  `keyof O &` strips the undefined an optional key contributes
export type TrueKeys<O extends Record<PropertyKey, boolean>> =
  keyof O & { [K in keyof O]-?: If<O[K], K, never> }[keyof O];

// ---- Pick ----

export function pick<
  const O extends object,
  const K extends KeyOrKeys<O>,
>(obj: O & Plain<O>, keyOrKeys: K): Picked<O, K> {
  const keys = (isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) as RoArray<keyof O>;
  //absent (optionally-declared) keys stay absent rather than materializing with value
  //  undefined, matching Pick's preserved optionality
  return Object.fromEntries(
    keys.filter(key => Object.hasOwn(obj, key)).map(key => [key, obj[key]]),
  ) as any;
}

// ---- Omit ----

export function omit<
  const O extends object,
  const K extends KeyOrKeys<O>,
>(obj: O & Plain<O>, keyOrKeys: K): Omit<O, ElementOf<K>> {
  const ret: any = { ...obj };
  for (const key of (isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) as RoArray<keyof O>)
    delete ret[key];

  return ret;
}

// ---- OmitUndefined ----

//keys partitioned by whether their value can be undefined: never, only, or sometimes (the rest,
//  which includes any)
type DefinedKeys  <O> = TrueKeys<{ [K in keyof O]: Not<Extends<undefined, O[K]>> }>;
type UndefinedKeys<O> = TrueKeys<{ [K in keyof O]: If<IsAny<O[K]>,
                                                      false,
                                                      AllExtend<O[K], undefined>> }>;
type MaybeKeys<O> = Exclude<keyof O, DefinedKeys<O> | UndefinedKeys<O>>;

//the runtime counterpart of `Opts`: drops undefined-valued keys so an opts object can be spread
//  over a base record without clobbering its fields. Keys that cannot hold undefined keep their
//  required-ness, keys that can become optional, and keys that hold nothing else disappear
export type OmitUndefined<O> = Simplify<
  & Pick<O, DefinedKeys<O>>
  & { [K in keyof Pick<O, MaybeKeys<O>>]?: Exclude<O[K], undefined> }
>;

export function omitUndefined<
  const O extends object,
>(obj: O & Plain<O>): OmitUndefined<O> {
  const ret: any = { ...obj };
  for (const key of Reflect.ownKeys(ret))
    if (ret[key] === undefined)
      delete ret[key];

  return ret;
}

// ---- Replace ----

export type Replace<O extends object, K extends keyof O, V> =
  { [OK in keyof O]: OK extends K ? If<IsUnion<K>, V | O[OK], V> : O[OK] };

export function replace<
  const O extends object,
        K extends keyof O,
  const V,
>(obj: O & Plain<O>, key: K, newValue: V): Replace<O, K, V> {
  return { ...obj, [key]: newValue } as Replace<O, K, V>;
}

// ---- Merge ----

type OptionalKeys<T> = TrueKeys<{ [K in keyof T]: Extends<{}, Pick<T, K>> }>;
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;

//whether the consumer lacks exactOptionalPropertyTypes, so that its optional keys may hold
//  undefined (declarations are checked under their consumer's options: this resolves per consumer)
type LooseOptionals = Extends<{ a: undefined }, { a?: 1 }>;

//the type of `{ ...fallback, ...preferred }`: on key collisions `preferred` wins, and an optional
//  preferred key that is absent lets the fallback's value show through, with the fallback's
//  modifier deciding whether the key is guaranteed - unless the preferred key may be present
//  holding undefined, in which case the key stays optional. Built from homomorphic pieces (Omit,
//  Pick, mappings over them) so property modifiers survive; the partition is by modifier alone, as
//  one by value type would stay deferred wherever a preferred value is generic, as every item
//  factory's is, and deferred Merges do not relate
export type Merge<T, U> = Simplify<
  & Omit<T, OptionalKeys<T> & keyof U>
  & Omit<U, keyof T>
  & If<LooseOptionals,
      { [K in keyof Pick<T, OptionalKeys<T> & keyof U>]:
          Required<T>[K] | Required<U>[K & keyof U] },
      & { [K in keyof Pick<T, OptionalKeys<T> & RequiredKeys<U>>]-?:
            Required<T>[K] | U[K & keyof U] }
      & { [K in keyof Pick<T, OptionalKeys<T> & OptionalKeys<U>>]:
            Required<T>[K] | Required<U>[K & keyof U] }
    >
>;

//the one helper here that takes its arguments unguarded: merging a concrete shape into an open
//  type parameter is the point, and `U & Plain<U>` is undecidable while U is open. Readonly-ness
//  rides in on the arguments, so `ro` composes for callers that need the modifier on top.
//  The fallback admits undefined - callers hold an optional opts record - but is not itself
//  optional: a merge with nothing to merge is just the identity
export function merge<
  const T extends object,
  const U extends object,
>(preferred: T, fallback: U | undefined): Merge<T, U> {
  return { ...fallback, ...preferred } as Merge<T, U>;
}

// ---- Spread ----

//Spread<{ a: 1; n: { b: 2; c: 3 } }, "n"> = { a: 1; b: 2; c: 3 }
//assumes keyof O[K] is disjoint from the remaining keys (spreading would have to shadow
//  them, collapsing the intersection below) - the function's constraint enforces this
export type Spread<O extends object, K extends keyof O> =
  Simplify<Omit<O, K> & { [SK in keyof O[K]]: O[K][SK] }>;

//keys holding a plain object whose keys are disjoint from the remaining keys
//  (the IsAny guard keeps deliberately type-erased call sites from collapsing to never)
type SpreadableKeys<O extends object> =
  IsAny<O> extends true
  ? keyof O
  : TrueKeys<{ [K in keyof O]:
      If<IsPlain<O[K]>, IsNever<keyof O[K] & Exclude<keyof O, K>>, false>;
    }>;

export function spread<
  const O extends object,
        K extends keyof O & SpreadableKeys<O>,
>(obj: O & Plain<O>, key: K): Spread<O, K> {
  const { [key]: nestedObj, ...rest } = obj;
  return { ...rest, ...nestedObj as object } as Spread<O, K>;
}

// ---- Nest ----

//Nest<{ a: 1; b: 2; c: 3 }, "n", ["b", "c"]> = { a: 1; n: { b: 2; c: 3 } }
export type Nest<O extends object, NK extends PropertyKey, K extends KeyOrKeys<O>> =
  Simplify<Omit<O, ElementOf<K>> & { [_ in NK]: Picked<O, K> }>;

//rejects a new key that collides with a key remaining on the outer object (nesting would
//  have to shadow it); an inexact selection may leave any key behind
type FreshKey<O extends object, NK extends PropertyKey, K> =
  NK extends If<ExactKeys<K>, Exclude<keyof O, ElementOf<K>>, keyof O> ? never : unknown;

export function nest<
  const O extends object,
       NK extends PropertyKey,
  const K extends KeyOrKeys<O>,
>(
  obj:    O & Plain<O>,
  newKey: NK & FreshKey<O, NK, K>,
  toNest: K,
): Nest<O, NK, K> {
  return { ...omit<O, K>(obj, toNest), [newKey]: pick<O, K>(obj, toNest) } as any;
}

// ---- deep paths (DeepOmit / DeepReplace) ----

export const anyKey = Symbol("anyKey");

type LastPathElement = PropertyKey | RoNeTuple<PropertyKey>;
type Path = readonly [...RoTuple<PropertyKey>, LastPathElement];
//runtime (non-tuple) paths carry no positional info, so the keys-tuple form (valid only in
//  last position) is excluded from them; use a list of paths instead
type ArrayPath = RoArray<PropertyKey>;
//an argument whose first element is an array is a list of paths (mirroring the runtime
//  isArray dispatch) - so a *single* path starting with a keys-tuple, i.e. one targeting
//  several root keys, must be wrapped in a list: [[["a", "b"]]]
type Paths = Path | RoTuple<Path> | ArrayPath | RoArray<ArrayPath>;

type CoalescePath<P extends Path> =
  P extends readonly [
    ...infer Start extends RoTuple<PropertyKey>,
    infer Last extends LastPathElement,
  ]
  ? [...Start, Last extends RoNeTuple<PropertyKey> ? Last[number] : Last]
  : P;

//distributes, so anyKey inside a keys-tuple widens the whole set to the wildcard
//  (the runtime matches this)
type ToAnyForAnyKey<H> = H extends typeof anyKey ? any : H;

//path semantics, identical at type and value level:
//  * named keys and final deletion/replacement address plain-object levels; arrays are
//    left untouched by them
//  * anyKey traverses every value of a plain object and every element of an array
//  * as the final element, anyKey deletes all keys resp. replaces all values/elements
function deepApply(
  obj:       any,
  path:      Path | ArrayPath,
  applyLast: (target: object, last: LastPathElement) => any,
): any {
  const [head, ...rest] = path;
  if (head === undefined) //only reachable via an empty runtime (non-tuple) path
    return obj;

  if (rest.length === 0)
    return applyLast(obj, head as LastPathElement);

  const restPath = rest as unknown as Path;
  if (isArray(obj))
    return head === anyKey
      ? obj.map(v => isComposite(v) ? deepApply(v, restPath, applyLast) : v)
      : obj;

  if (head === anyKey) {
    const ret = { ...obj };
    for (const key of Reflect.ownKeys(ret))
      if (isComposite(ret[key]))
        ret[key] = deepApply(ret[key], restPath, applyLast);

    return ret;
  }

  const key = head as PropertyKey;
  return (Object.hasOwn(obj, key) && isComposite(obj[key]))
    ? { ...obj, [key]: deepApply(obj[key], restPath, applyLast) }
    : { ...obj };
}

const isWildcard = (last: LastPathElement) =>
  last === anyKey || (isArray(last) && last.includes(anyKey));

// ---- DeepOmit ----

//mirrors deepApply: a primitive is left alone, an array is entered by anyKey alone and never
//  has elements deleted, a plain object is entered by name or by anyKey
type _DeepOmit<O, SP extends RoNeTuple<PropertyKey>> =
  O extends object
  ? SP extends HeadTail<SP, infer H, infer T>
    ? O extends RoArray
      ? H extends typeof anyKey
        ? T extends RoNeTuple<PropertyKey> ? { [K in keyof O]: _DeepOmit<O[K], T> } : O
        : O
      : ToAnyForAnyKey<H> extends infer HA
      ? T extends RoNeTuple<PropertyKey>
        ? { [K in keyof O]: K extends HA ? _DeepOmit<O[K], T> : O[K] }
        : { [K in keyof O as K extends HA ? never : K]: O[K] }
      : never
    : never
  : O;

type DeepOmitPath<O, P extends Path> =
  CoalescePath<P> extends infer SP extends RoNeTuple<PropertyKey>
  ? _DeepOmit<O, SP>
  : unknown;

type DeepOmitList<O, P extends RoTuple<Path>> =
  P extends HeadTail<P, infer H, infer T>
  ? DeepOmitList<DeepOmitPath<O, H>, T>
  : O;

//the list arm comes first because a single-element list of a path also parses as a path. A
//  runtime (non-tuple) path could have reached anything, so the result is unknown: the caller
//  states what it knows
export type DeepOmit<O extends object, P extends Paths> =
  P extends RoTuple<Path>
  ? DeepOmitList<O, P>
  : P extends Path
  ? DeepOmitPath<O, P>
  : unknown;

function deepOmitPath(obj: any, path: Path | ArrayPath): any {
  return deepApply(obj, path, (target, last) => {
    if (isArray(target))
      return target;

    if (isWildcard(last))
      return {};

    const ret: any = { ...target };
    for (const key of isArray(last) ? last : [last])
      delete ret[key];

    return ret;
  });
}

export function deepOmit<
  const O extends object,
  const P extends Paths,
>(obj: O & Plain<O>, pathOrPaths: P): DeepOmit<O, P> {
  if (pathOrPaths.length === 0)
    return obj as any;

  if (isArray(pathOrPaths[0]))
    return (pathOrPaths as RoArray<Path>).reduce<any>(
      (acc, path) => deepOmitPath(acc, path),
      obj,
    );

  return deepOmitPath(obj, pathOrPaths as Path) as any;
}

// ---- DeepReplace ----

type _DeepReplace<O, SP extends RoNeTuple<PropertyKey>, V> =
  O extends object
  ? SP extends HeadTail<SP, infer H, infer T>
    ? O extends RoArray
      ? H extends typeof anyKey
        ? { [K in keyof O]: T extends RoNeTuple<PropertyKey> ? _DeepReplace<O[K], T, V> : V }
        : O
      : ToAnyForAnyKey<H> extends infer HA
      ? T extends RoNeTuple<PropertyKey>
        ? { [K in keyof O]: K extends HA ? _DeepReplace<O[K], T, V> : O[K] }
        : { [K in keyof O]: K extends HA ? V : O[K] }
      : never
    : never
  : O;

type DeepReplacePath<O, P extends Path, V> =
  CoalescePath<P> extends infer SP extends RoNeTuple<PropertyKey>
  ? _DeepReplace<O, SP, V>
  : unknown;

export type DeepReplace<O extends object, P extends Path | ArrayPath, V> =
  P extends Path
  ? DeepReplacePath<O, P, V>
  : unknown;

type Replacement = RoPair<Path | ArrayPath, unknown>;

type DeepReplaceList<O, R extends RoTuple<Replacement>> =
  R extends HeadTail<R, infer H, infer T>
  ? DeepReplaceList<
      H extends RoPair<infer P extends Path, infer V>
      ? DeepReplacePath<O, P, V>
      : unknown,
      T
    >
  : O;

function deepReplacePath(obj: any, path: Path | ArrayPath, newValue: unknown): any {
  return deepApply(obj, path, (target, last) => {
    const wildcard = isWildcard(last);
    if (isArray(target))
      return wildcard ? target.map(() => newValue) : target;

    const ret: any = { ...target };
    if (wildcard) {
      for (const key of Reflect.ownKeys(ret))
        ret[key] = newValue;

      return ret;
    }

    for (const key of isArray(last) ? last : [last])
      if (Object.hasOwn(ret, key))
        ret[key] = newValue;

    return ret;
  });
}

export function deepReplace<
  const O extends object,
  const P extends Path | ArrayPath,
  const V,
>(obj: O & Plain<O>, path: P, newValue: V): DeepReplace<O, P, V>;
export function deepReplace<
  const O extends object,
  const R extends RoNeTuple<Replacement>,
>(obj: O & Plain<O>, replacements: R): DeepReplaceList<O, R>;
export function deepReplace(
  obj:     object,
  ...args: [Path | ArrayPath, unknown] | [RoNeTuple<Replacement>]
) {
  const replacements = args.length === 2 ? ([[args[0], args[1]]] as const) : args[0];
  return replacements.reduce<any>(
    (acc, [path, value]) => deepReplacePath(acc, path, value),
    obj,
  );
}

// ---- FromEntries ----

export type ObjectEntry<K extends PropertyKey = PropertyKey, V = unknown> = RoPair<K, V>;

type CertainEntryKeys<A extends RoArray<ObjectEntry>, K extends PropertyKey = never> =
  ElementRest<A> extends [infer E extends ObjectEntry, infer R extends RoArray<ObjectEntry>]
  ? CertainEntryKeys<R, K | (IsLiteral<E[0]> extends true ? E[0] : never)>
  : K;

type PropertyName<K extends PropertyKey> = K extends number ? `${K}` : K;
type EntryValue<E extends ObjectEntry, K extends PropertyKey> =
  E extends unknown
  ? If<IsNever<PropertyName<K> & PropertyName<E[0]>>, never, E[1]>
  : never;

//index signatures already admit missing keys; only named properties need the optional modifier
type EntryIndexKeys<R> =
  { [K in keyof R]: {} extends Pick<R, K> ? K : never }[keyof R];

export type TupleFromEntries<T extends RoTuple<ObjectEntry>> = FromEntries<T>;

export type FromEntries<A extends RoArray<ObjectEntry>> =
  A extends unknown
  ? { [K in PropertyName<A[number][0]>]: EntryValue<A[number], K> } extends infer R
    ? Simplify<
        Partial<R> & Pick<R, EntryIndexKeys<R>> &
        Pick<R, PropertyName<CertainEntryKeys<A>> & keyof R>
      >
    : never
  : never;

export function fromEntries<
  const A extends RoArray<ObjectEntry>,
>(entries: A): FromEntries<A> {
  return Object.fromEntries(entries) as any;
}
