import type { NeTuple, Spread as ObjSpread, RoArray,
              RoTuple, RoNeTuple, HeadTail, Function,
              Merge, Get, If, IsNever, IsAny, Not, And, TrueKeys } from "@onrail-xyz/utils";
import { spread as objSpread, nest as objNest, assertDistinct } from "@onrail-xyz/utils";
import type { Layout, Item, Struct, Conversion,
              DeriveType, HasFixed, HasAs, HasCustom, IsOmitted } from "./layout.js";
import { isItem, isOmitted, hasFixed, hasAs, asOf, customOf, structKeys } from "./utils.js";

// ---- conversion composition ----

//typed off the function members rather than via `extends Conversion<infer A, infer B>`: a
//  conversion may be a strict subtype of its contract (`from` returning a subtype of A), and
//  the inference then sees two candidates for A and takes the covariant one - narrowing the
//  composite `to`'s parameter below what the function accepts
export type PipedConversion<CT extends RoTuple<Conversion>> =
  CT extends HeadTail<CT, infer F, infer Rest>
  ? Rest extends HeadTail<Rest, infer G, infer Tail>
    ? PipedConversion<[
        Readonly<{
          to:   Function<[Parameters<F["to"  ]>[0]], ReturnType<G["to"  ]>>,
          from: Function<[Parameters<G["from"]>[0]], ReturnType<F["from"]>>,
        }>,
        ...Tail
      ]>
    : F
  : never;

//every conversion past the first must convert what its predecessor surfaces (utils' pipe
//  applies the same discipline to plain functions)
type ChainedTail<Prev extends Conversion, CT extends RoTuple<Conversion>> =
  CT extends HeadTail<CT, infer G, infer Tail>
  ? readonly [
      Readonly<{
        to:   Function<[ReturnType<Prev["to"]>  ], ReturnType<G["to"]>>,
        from: Function<[Parameters<G["from"]>[0]], Parameters<Prev["from"]>[0]>,
      }>,
      ...ChainedTail<G, Tail>
    ]
  : readonly [];

type Chained<CT extends RoTuple<Conversion>> =
  CT extends HeadTail<CT, infer F, infer Tail>
  ? readonly [F, ...ChainedTail<F, Tail>]
  : CT;

//composes conversions wire-outward, left to right: `to` runs them in order, `from` in reverse
export const pipedConversion = <const CT extends RoNeTuple<Conversion>>(
  ...conversions: CT & Chained<CT>
): PipedConversion<CT> => {
  const convs = conversions as RoArray<Conversion>;
  return {
    to:   (val: unknown) => convs.reduce     ((acc, conv) => conv.to(acc),   val),
    from: (val: unknown) => convs.reduceRight((acc, conv) => conv.from(acc), val),
  } as PipedConversion<CT>;
};

// ---- withCustom ----

//what a layout hands a conversion attached to it: its surfaced value - or, for a pinned item
//  that surfaces nothing, its raw constant
type RawType<I extends Item> =
  Omit<I, "fixed" | "as"> extends infer R extends Layout ? DeriveType<R> : never;

export type ConversionSource<L extends Layout> =
  L extends infer I extends Item
  ? If<IsOmitted<I>, RawType<I>, DeriveType<I>>
  : DeriveType<L>;

export type WithCustom<L extends Layout, T> =
  L extends infer I extends Item
  ? Readonly<Merge<
      If<And<HasFixed<I>, HasAs<I>>,
        { as: T },
        { custom:
            Get<I, "custom"> extends infer C extends Conversion
            ? PipedConversion<[C, Conversion<DeriveType<I>, T>]>
            : Conversion<ConversionSource<I>, T>
        }
      >,
      I
    >>
  : Readonly<{ binary: "bytes", layout: L, custom: Conversion<DeriveType<L>, T> }>;

const composeCustom = (existing: Conversion | undefined, custom: Conversion): Conversion =>
  existing === undefined ? custom : pipedConversion(existing, custom);

//a conversion sits on the node of the value it converts: on an item that is the item itself,
//  composed onto whatever conversion it already carries - or, when the item states its surfaced
//  value, applied to that constant once and folded into `as` (only a pinned item surfaces its
//  `as`; without `fixed` it is inert); a struct has no node, so it gets its item-form - the
//  size-less bytes item that is the struct's own spelling
export const withCustom = <const L extends Layout, T>(
  layout: L,
  custom: Conversion<ConversionSource<L>, T>,
): WithCustom<L, T> => (
  !isItem(layout)
  ? { binary: "bytes", layout, custom }
  : hasFixed(layout) && hasAs(layout)
  ? { ...layout, as: custom.to(asOf(layout)) }
  : { ...layout, custom: composeCustom(customOf(layout), custom) }
) as WithCustom<L, T>;

// ---- pin ----

//the raw domain of an item: what its conversion's `from` produces, or its bare value
type RawDomain<I extends Item> =
  Get<I, "custom"> extends infer C extends Conversion ? ReturnType<C["from"]> : RawType<I>;

export type Pinned<L extends Layout, V> =
  L extends infer I extends Item
  ? Readonly<Merge<{ fixed: RawDomain<I>, as: V }, Omit<I, "custom">>>
  : Readonly<{ binary: "bytes", layout: L, fixed: V, as: V }>;

//pins a layout by its *surfaced* value - the dual of spelling `fixed` in the raw domain. The
//  conversion runs once, here, and is then dropped: the wire constant is recorded as `fixed`,
//  the value as `as`. The layout must not already be pinned
export const pin = <const L extends Layout, const V extends DeriveType<L>>(
  layout: L,
  value:  V,
): Pinned<L, V> => {
  if (!isItem(layout))
    return { binary: "bytes", layout, fixed: value, as: value } as Pinned<L, V>;

  const { custom, ...rest } = layout as Item & { custom?: Conversion };
  return {
    ...rest,
    fixed: custom !== undefined ? custom.from(value) : value,
    as:    value,
  } as Pinned<L, V>;
};

// ---- spreadLayout ----

//a field is spreadable if it derives a plain object whose keys can be pulled into the parent
type SpreadableFieldStruct<F> =
  F extends Item
  ? F extends { binary: "bytes" | "packed", layout: infer S extends Struct }
    ? If<HasCustom<F>, never, S> //a conversion replaces the raw nesting
    : never
  : F extends Struct
  ? F
  : never;

//...and whose surfaced keys are disjoint from the remaining ones, as utils' spread demands of a
//  plain object: a shared key would have to shadow the other (the IsAny guard keeps deliberately
//  type-erased call sites from collapsing to never, as there). Omitted fields - padding, magic -
//  derive no key, so a name they share collides with nothing
type SpreadableNames<S extends Struct> =
  IsAny<S> extends true
  ? string
  : string & TrueKeys<{ [K in keyof S]:
      SpreadableFieldStruct<S[K]> extends infer F extends Struct
      ? If<IsNever<F>, false, IsNever<NonOmittedKeys<F> & Exclude<NonOmittedKeys<S>, K>>>
      : false
    }>;

//the derived value after the spread - named so the conversion below can state it, which is what
//  keeps the inferred T precise instead of collapsing to the erased shape objSpread returns
type SpreadDerived<S extends Struct, N extends PropertyKey> =
  DeriveType<S> extends infer O extends object
  ? N extends keyof O
    ? ObjSpread<O, N>
    : never
  : never;

//qualified because `Spread` and `spread` are utils' object-level operation
export type SpreadLayout<S extends Struct, N extends SpreadableNames<S>> =
  WithCustom<S, SpreadDerived<S, N>>;

export const spreadLayout = <
  const S extends Struct,
        N extends SpreadableNames<S>,
>(layout: S, name: N): SpreadLayout<S, N> => {
  const field = layout[name]!;
  const inner = (isItem(field) ? (field as { layout: Struct }).layout : field) as Struct;
  const surfacedKeys = (struct: Struct) => structKeys(struct).filter(key => {
    const keyField = struct[key]!;
    return !(isItem(keyField) && isOmitted(keyField));
  });
  const innerKeys = surfacedKeys(inner);
  //a type-erased call site is the one place the type-level disjointness does not reach, and a
  //  shared key would silently reconstruct into the wrong nesting
  assertDistinct(...surfacedKeys(layout).filter(key => key !== name), ...innerKeys);

  return withCustom(layout, {
    to:   derived => objSpread(derived as any, name as any) as SpreadDerived<S, N>,
    from: (transformed: SpreadDerived<S, N>) =>
      objNest(transformed as any, name as any, innerKeys as NeTuple<string>) as any,
  }) as SpreadLayout<S, N>;
};

// ---- unwrapSingleton ----

type NonOmittedKeys<S extends Struct> =
  string & TrueKeys<{ [K in keyof S]: Not<IsOmitted<S[K]>> }>;

type UnwrapDerived<S extends Struct> =
  NonOmittedKeys<S> extends infer N extends string
  ? If<IsNever<N>,
      never,
      DeriveType<S> extends infer O extends object
      ? N extends keyof O
        ? O[N]
        : never
      : never
    >
  : never;

export type UnwrapSingleton<S extends Struct> =
  If<IsNever<UnwrapDerived<S>>, never, WithCustom<S, UnwrapDerived<S>>>;

export const unwrapSingleton = <const S extends Struct>(
  layout: S,
): UnwrapSingleton<S> => {
  const nonOmitted = structKeys(layout).filter(key => {
    const field = layout[key]!;
    return !(isItem(field) && isOmitted(field));
  });
  if (nonOmitted.length !== 1)
    throw new Error(`unwrapSingleton requires exactly one non-omitted field, ` +
      `got: ${nonOmitted.length}`);

  const name = nonOmitted[0]!;
  return withCustom(layout, {
    to:   derived => (derived as any)[name] as UnwrapDerived<S>,
    from: (unwrapped: UnwrapDerived<S>) => ({ [name]: unwrapped }) as any,
  }) as UnwrapSingleton<S>;
};
