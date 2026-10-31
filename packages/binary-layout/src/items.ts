import type { RoUint8Array, RoArray, RoPair, Opts,
              Merge, Get, Brand, Unbrand, OptionalArg } from "@onrail-xyz/utils";
import { assertDistinct, capitalize, identity,
         isUint8Array, merge, raise, tryOr, valueEquals } from "@onrail-xyz/utils";
import type { BytesItem, Layout, LayoutObject,
              Struct, Endianness, BitOrder, Conversion,
              NumType, NumSizeToPrimitive, NumBitsToPrimitive,
              NumberSize, Count, IdItem, NumItem, Surfacing,
              SwitchItem, SwitchVariant, VariantId, VariantBody,
              CodecItem, DeriveType, BinaryLiteral, IntegerLiteral } from "./layout.js";
import { isItem, isLayout, isNumType, hasFixed, hasCustom, isRangeId,
         checkItemSize, variantTagMatches, numBitWidth, numBitsToPrimitive } from "./utils.js";
import { checkInDomain, domainBounds } from "./numbers.js";
import { serialize } from "./serialize.js";

// ---- kind factories ----

//a width slot normalized to an opts record: a bare width becomes `{ [K]: width }`. Which widths
//  a kind admits is the signature's job; here numbers and prefix items are widths and opts
//  records are not (they carry no `binary`)
type Width = "size" | "length" | "bits";
//a bare width is a number or an item, told from an opts record by `binary`. Testing against
//  `Count` itself would leave the conditional undecided at an open O: a prefix item of number
//  width is structurally an opts record with a `size`, so tsc keeps the count branch alive
type WidthOpts<O, K extends Width> =
  O extends number | { binary: BinaryLiteral } ? { readonly [P in K]: O } : O;
//a defaulted width sits in opts like every other optional member: widthOf applies the unit
//  width - the default of every kind that defaults its width at all - and WidthOf reads the
//  literal back out of the normalized slot or falls back to it
type WidthOf<O, K extends Width> =
  Get<WidthOpts<O, K>, K> extends infer X extends number ? X : 1;
const widthOf = <O, K extends Width>(specified: number | undefined) =>
  (specified ?? 1) as WidthOf<O, K>;
const widthOpts = <K extends Width, const O>(key: K, arg: O | undefined): WidthOpts<O, K> =>
  (typeof arg === "number" || isItem(arg) ? { [key]: arg } : arg ?? {}) as WidthOpts<O, K>;

//the `never` arms are what make a union of optional bags reject: TS's excess-property check
//  treats a union as one key set. C follows ItemBase's rule: precise where F is (the integer
//  kinds), the existential where F is loose
type BaseOpts<F, C extends Conversion = Conversion> =
  | Opts<{ fixed: F, custom: C }>       & { readonly as?:     never }
  | Readonly<{ fixed: F, as: unknown }> & { readonly custom?: never };

//fixed and custom live in the width's primitive: a `Conversion<number>` on an 8-byte field would
//  be handed a bigint, and a width widened to `number` demands a conversion over both
type NumOpts<F extends NumType>     = BaseOpts<F, Conversion<F>>;
type SizedNumOpts<S extends number> = NumOpts<NumSizeToPrimitive<S>> &
                                      Opts<{ endianness: Endianness }>;
type BitsNumOpts <B extends number> = NumOpts<NumBitsToPrimitive<B>>;

//each factory's own fields, named for the annotated returns to print by: unannotated, the
//  declarations spell out Merge's body
type SizedNumBase<BL extends IntegerLiteral, S extends number> =
  { readonly binary: BL, readonly size: S };
type BitsNumBase<BL extends IntegerLiteral, B extends number> =
  { readonly binary: BL, readonly bits: B };
type BytesBase =
  { readonly binary: "bytes" };
type ArrayBase<L extends Layout> =
  { readonly binary: "array", readonly layout: L };
type PackedBase<S extends Struct> =
  { readonly binary: "packed", readonly layout: S };

//opts are merged in, never spread: TS materializes a spread of a generic type parameter against
//  the parameter's constraint, which both leaks the constraint's optional keys and widens the
//  caller's literals, while Merge is built from mapped types and stays deferred. Merge is
//  left-biased, which is why a kind's own fields are the first argument. The `= {}` defaults
//  guard the same property from the other side: an uninferred type parameter resolves to its
//  constraint, leaking the phantom keys all the same
//named, as uintItem and intItem are instantiations of it: inferred, each export's declaration
//  would respell the signatures, with type parameters that are out of scope where they print.
//  Split so that each signature types its implementation contextually
type SizedNumFactory<BL extends IntegerLiteral> =
  <S extends number, const O extends SizedNumOpts<S> = {}>(
    size:      S,
    ...[opts]: OptionalArg<O>
  ) => Merge<SizedNumBase<BL, S>, O>;
type BitsNumFactory<BL extends IntegerLiteral> =
  <B extends number, const O extends BitsNumOpts<B> = {}>(
    bits:      B,
    ...[opts]: OptionalArg<O>
  ) => Merge<BitsNumBase<BL, B>, O>;
type NumFactory<BL extends IntegerLiteral> = SizedNumFactory<BL> & { bits: BitsNumFactory<BL> };

const numFactory = <BL extends IntegerLiteral>(binary: BL): NumFactory<BL> => {
  const sized: SizedNumFactory<BL> = (size, ...[opts]) => merge({ binary, size }, opts);
  const bits:   BitsNumFactory<BL> = (bits, ...[opts]) => merge({ binary, bits }, opts);
  return Object.assign(sized, { bits });
};

export const uintItem = numFactory("uint");
export const intItem  = numFactory("int");

//an opts record is not an item: without the ban, an item the slot does not take (a uint too
//  wide to be a prefix, a surfaced integer as a carrier, any item where widths are plain
//  numbers) would pass as a record whose width happens to be a number
type NotAnItem = { readonly binary?: never };
type BytesOpts = NotAnItem & BaseOpts<unknown> & Opts<{ size: Count, layout: Layout }>;

export const bytesItem = <const O extends Count | BytesOpts = {}>(
  ...[sizeOrOpts]: OptionalArg<O>
): Merge<BytesBase, WidthOpts<O, "size">> =>
  merge({ binary: "bytes" }, widthOpts("size", sizeOrOpts));

type ArrayOpts = NotAnItem & BaseOpts<RoArray<unknown>> & Opts<{ length: Count }>;

export const arrayItem = <const L extends Layout, const O extends Count | ArrayOpts = {}>(
  layout:            L,
  ...[lengthOrOpts]: OptionalArg<O>
): Merge<ArrayBase<L>, WidthOpts<O, "length">> =>
  merge({ binary: "array", layout }, widthOpts("length", lengthOrOpts));

type PackedOpts = NotAnItem & BaseOpts<LayoutObject> & Opts<{
  size:       number,
  endianness: Endianness,
  bitOrder:   BitOrder,
}>;

//a lane inherits nothing but its place, and its width defaults to the layout's bit sum; byte
//  order stays with the enclosing word, so the bit form has no endianness to offer
type BitsPackedOpts = NotAnItem & BaseOpts<LayoutObject> & Opts<{
  bits:     number,
  bitOrder: BitOrder,
}>;

export const packedItem = Object.assign(
  < const S extends Struct,
    const O extends number | PackedOpts = {},
  >(layout: S, ...[sizeOrOpts]: OptionalArg<O>): Merge<PackedBase<S>, WidthOpts<O, "size">> =>
    merge({ binary: "packed", layout }, widthOpts("size", sizeOrOpts)),
  { bits: <const S extends Struct, const O extends number | BitsPackedOpts = {}>(
      layout:          S,
      ...[bitsOrOpts]: OptionalArg<O>
    ): Merge<PackedBase<S>, WidthOpts<O, "bits">> =>
      merge({ binary: "packed", layout }, widthOpts("bits", bitsOrOpts)),
  },
);

type UnnamedSwitchRow<
  I extends VariantId   = VariantId,
  L extends VariantBody = VariantBody
> = RoPair<I, L>;
type NamedSwitchRow<
  I extends VariantId   = VariantId,
  A extends unknown     = unknown,
  L extends VariantBody = VariantBody
> = readonly [I, A, L];
type SwitchRow = UnnamedSwitchRow | NamedSwitchRow;

//named rather than an inline `Readonly<{...}>`: a switch variant is the most-repeated
//  structure in a large layout tree, and an anonymous type is spelled out at every embedding
//  where a declaration is printed by name - see DeclarationEmit.md
export type NamedSwitchVariant<I extends VariantId, A, L extends VariantBody> = {
  readonly id:     I,
  readonly as:     A,
  readonly layout: L,
};

export type UnnamedSwitchVariant<I extends VariantId, L extends VariantBody> = {
  readonly id:     I,
  readonly layout: L,
};

type RowToVariant<R> =
  R extends NamedSwitchRow<infer I, infer A, infer L>
  ? NamedSwitchVariant<I, A, L>
  : R extends UnnamedSwitchRow<infer I, infer L>
  ? UnnamedSwitchVariant<I, L>
  : never;

type RowsToVariants<R extends RoArray<SwitchRow>> =
  { readonly [K in keyof R]: RowToVariant<R[K]> };

const rowBody = (row: SwitchRow): VariantBody => (row.length === 3 ? row[2] : row[1]);

//dev-checks for variant bodies (in raw literals, each violation is UB):
//  * a switch body merges its union into the tag row, so it must derive one - a pinned or
//    converted switch derives a single arbitrary value instead
//  * along a chain of variant-position switches, every tag must differ from the other tags
//    and from all merged field names
const checkVariantBody = (tags: RoArray<string>, body: VariantBody): void => {
  if (isItem(body)) {
    const inner = body as SwitchItem;
    if (hasFixed(inner) || hasCustom(inner))
      throw new Error(`a switch body in variant position must not carry fixed/custom - ` +
                      `its union merges into the tag row`);

    if (tags.includes(inner.tag))
      throw new Error(`switch tag '${inner.tag}' reused along a variant chain`);

    for (const variant of inner.variants)
      checkVariantBody([...tags, inner.tag], variant.layout);
  }
  else
    for (const tag of tags)
      if (tag in body)
        throw new Error(`switch tag '${tag}' collides with a variant field of the same name`);
};

//a variant whose whole id set is covered by its predecessors (vacuously so for an empty range)
//  is deserialization-dead yet still serialization-reachable through its tag - a silent
//  round-trip break. Partial shadowing stays legal (a narrower range before a broader one
//  carves an exception out of it); in raw literals, a dead variant is UB
const checkVariantReachability = (ids: RoArray<VariantId>): void => {
  const succ = (n: NumType) => typeof n === "bigint" ? n + 1n : n + 1;
  const covered: [NumType, NumType][] = []; //ascending by lower bound
  for (const id of ids) {
    const [lo, hi] = isRangeId(id) ? id : [id, id];
    //the frontier only advances, so once an interval starts past it every later one does too:
    //  a single ascending pass leaves it on the first id >= lo that no predecessor covers
    const frontier = covered.reduce((f, [a, b]) => a <= f && f <= b ? succ(b) : f, lo);
    if (frontier > hi)
      throw new Error(`switch variant with id ${id} is deserialization-dead - ` +
                      `empty range or fully shadowed by earlier variants`);

    const at = covered.findIndex(([a]) => a > lo);
    covered.splice(at === -1 ? covered.length : at, 0, [lo, hi]);
  }
};

//a renamed scalar's `as` is the one surfaced tag its raw id does not determine, so it can also
//  be another variant's - that variant's id then decodes to a tag which serializes through this
//  one, or the other way round. Distinct raw ids do not make the tags distinct
const checkTagReversibility = (variants: RoArray<SwitchVariant>): void => {
  for (const [i, variant] of variants.entries()) {
    if (isRangeId(variant.id) || variant.as === undefined)
      continue;

    const other = variants.find((v, j) => j !== i && variantTagMatches(v, variant.as));
    if (other !== undefined)
      throw new Error(`surfaced tag '${String(variant.as)}' of switch variant with id ` +
                      `${variant.id} also routes to the variant with id ${other.id}`);
  }
};

//an id the id item cannot hold is never read back, so its variant is deserialization-dead too;
//  one of the wrong primitive would make every serialization through the switch throw. Checked
//  here rather than in the row types: tying ids to the id item's primitive stays unresolved
//  wherever the id item is itself generic. A codec's domain is the codec's own
const checkIdDomain = (id: IdItem, ids: RoArray<VariantId>): void => {
  if (id.binary === "codec")
    return;

  const bits = numBitWidth(id);
  const signed = id.binary === "int";
  for (const vid of ids)
    for (const bound of isRangeId(vid) ? vid : [vid])
      checkInDomain(bound, bits, signed, "switch variant id");
};

type SwitchOpts = BaseOpts<LayoutObject>;
type SwitchBase<T extends string, I extends IdItem, R extends RoArray<SwitchRow>> = {
  readonly binary:   "switch",
  readonly tag:      T,
  readonly id:       I,
  readonly variants: RowsToVariants<R>,
};

export const switchItem = <
        T extends string,
  const I extends IdItem,
  const R extends RoArray<SwitchRow>,
  const O extends SwitchOpts = {},
>(tag: T, id: I, rows: R, ...[opts]: OptionalArg<O>): Merge<SwitchBase<T, I, R>, O> => {
  if (hasFixed(id) || hasCustom(id))
    throw new Error(`switch ids are read raw: fixed/custom on the id item are not supported - ` +
                    `name variants via the 'as' column instead`);

  const ids = rows.map(row => row[0]);
  checkIdDomain(id, ids);
  checkVariantReachability(ids);
  for (const row of rows)
    checkVariantBody([tag], rowBody(row));

  const variants = rows.map(row =>
    row.length === 3
    ? { id: row[0], as: row[1], layout: row[2] }
    : { id: row[0], layout: row[1] }
  ) as RowsToVariants<R>;
  checkTagReversibility(variants as RoArray<SwitchVariant>);
  return merge({ binary: "switch", tag, id, variants }, opts);
};

//Raw is inferred from `read` and unifies the function trio - the one consistency a raw
//  literal cannot enforce (each function checks independently against the Existential
//  defaults). O's constraint deliberately drops Raw: a Raw reference there makes contextual
//  typing fix Raw to unknown before `read` is processed whenever the opts literal holds
//  functions (TS inference design, not a bug) - and factory opts type custom loosely across
//  the board anyway (conversions bind by obligation)
type CodecFnKeys   = "read" | "write" | "sizeOf";
type CodecFns<Raw> = Pick<CodecItem<Raw>, CodecFnKeys>;
type CodecOpts     = BaseOpts<unknown> & Opts<{ minSize: number, maxSize: number }>;
type CodecBase = { readonly binary: "codec" };
export const codecItem = <Raw, const O extends CodecOpts = {}>(
  fns:       CodecFns<Raw>,
  ...[opts]: OptionalArg<O>
): Merge<CodecBase, Merge<CodecFns<Raw>, O>> => {
  const minSize = opts?.minSize ?? 0;
  const maxSize = opts?.maxSize ?? Infinity;
  if (minSize < 0 || maxSize < minSize)
    throw new Error(`invalid codec size bounds: [${minSize}, ${maxSize}]`);

  return merge({ binary: "codec" }, merge(fns, opts));
};

// ---- customizable bytes (helper for factory authors) ----

type PinnedBytes = Readonly<{ fixed: RoUint8Array } & Opts<{ as: unknown }>>;

export type CustomizableBytes =
  | undefined
  | RoUint8Array
  | PinnedBytes
  | Layout
  | Conversion<RoUint8Array>;

type CustomizableBytesMerged<B, P extends CustomizableBytes> =
  Merge<
    { binary: "bytes" } & (
      P extends undefined
      ? {}
      : P extends RoUint8Array
      ? { fixed: P }
      : P extends PinnedBytes //overlaps with Layout and hence must come first
      ? P
      : P extends Layout
      ? { layout: P }
      : P extends Conversion<RoUint8Array>
      ? { custom: P }
      : never
    ),
    B
  >;

//a readonly mapped type spelled out rather than Readonly<...>, so the alias keeps its own name
//  in declaration emit; distributed over P, as a spec that may be absent frames either shape
export type CustomizableBytesReturn<B, P extends CustomizableBytes> =
  P extends unknown
  ? { readonly [K in keyof CustomizableBytesMerged<B, P>]: CustomizableBytesMerged<B, P>[K] }
  : never;

export const customizableBytes = <
  const B extends object,
  const P extends CustomizableBytes = undefined,
>(base: B, ...[spec]: OptionalArg<P>): CustomizableBytesReturn<B, P> => {
  const specProps =
    spec === undefined
    ? {}
    : isUint8Array(spec)
    ? { fixed: spec }
    : isUint8Array((spec as { fixed?: unknown }).fixed)
    ? spec
    : isLayout(spec)
    ? { layout: spec }
    : { custom: spec };

  return { ...base, binary: "bytes", ...specProps } as any;
};

// ---- padding ----

export const paddingItem = Object.assign(
  (size: number) => ({ binary: "bytes", fixed: new Uint8Array(size) } as const),
  { bits: <B extends number>(bits: B) => ({ binary: "uint", bits, fixed: 0 } as const) },
);

// ---- carriers ----

type UintOpts<S extends number = number> = Opts<{ size: S /*default 1*/, endianness: Endianness }>;
type PermissiveOpts = Opts<{ permissive: boolean }>;

//an item a carrier slot takes whole: an integer, or bytes without a layout, surfaced through a
//  conversion of its own or bare; `fixed` and `as` leave no values to convert
type Unpinned = Readonly<{ fixed?: undefined, as?: undefined }>;
export type Carrier =
  | NumItem   & Unpinned
  | BytesItem & Unpinned & { readonly layout?: undefined };

//the bare integers bool and enum convert
export type NumCarrier = NumItem & { readonly [K in keyof Surfacing]?: undefined };

type SlotUintOpts<S extends number = number> = UintOpts<S> & { readonly carrier?: never };
type CarrierOpts<C extends Carrier> = NotAnItem & (
  | SlotUintOpts
  | { readonly carrier: C } & { readonly [K in keyof UintOpts]?: never }
);

type CarrierSlot<O> =
  O extends number
  ? { readonly size: O }
  : O extends { binary: BinaryLiteral }
  ? { readonly carrier: O }
  : O;
const carrierSlot = <const O>(arg: O | undefined): CarrierSlot<O> => (
  typeof arg === "number"
  ? { size: arg }
  : isItem(arg)
  ? { carrier: arg }
  : arg ?? {}
) as CarrierSlot<O>;

type SlotUint<O> =
  Merge<SizedNumBase<"uint", WidthOf<O, "size">>, Omit<CarrierSlot<O>, "permissive">>;
type SizedCarrier<O, C extends Carrier> =
  Get<CarrierSlot<O>, "carrier"> extends infer I extends C ? I : SlotUint<O>;
const sizedCarrier = <const O, C extends Carrier>(arg: O | undefined) => {
  const { permissive, ...opts } = carrierSlot(arg) as CarrierOpts<C> & PermissiveOpts;
  const carrier =
    opts.carrier ?? merge({ binary: "uint", size: widthOf<O, "size">(opts.size) }, opts);
  return { carrier: carrier as SizedCarrier<O, C>, permissive: permissive ?? false };
};

type BitsCarrier<B extends number> = BitsNumBase<"uint", B>;

//the raw domain, beneath the carrier's own conversion if it has one
type CarrierRaw<C extends Carrier> =
  C extends BytesItem
  ? RoUint8Array
  : Get<C, "size"> extends infer S extends number
  ? NumSizeToPrimitive<S>
  : NumBitsToPrimitive<Extract<Get<C, "bits">, number>>;

//CarrierRaw<I> itself, which tsc can't see to be a NumType while I is open
type NumCarrierRaw<I extends NumCarrier> = Extract<CarrierRaw<I>, NumType>;

type Converted<I extends NumCarrier, T> =
  Merge<{ readonly custom: Conversion<NumCarrierRaw<I>, T> }, I>;

const converted = <I extends NumCarrier, T>(
  carrier: I,
  custom:  Conversion<NoInfer<NumCarrierRaw<I>>, T>,
): Converted<I, T> =>
  merge({ custom }, carrier);

type RawSpec<R> = R | "min" | "max";

//a raw value the carrier cannot hold is never read back, and a repeat on either side makes the
//  mapping non-injective - the silent round-trip break checkVariantReachability rejects for
//  switch variants
const resolveMapping = <V, R extends CarrierRaw<Carrier>>(
  carrier: Carrier,
  entries: RoArray<RoPair<V, RawSpec<R>>>,
  subject: string,
): RoArray<RoPair<V, R>> => {
  let resolved: RoArray<RoPair<V, R>>;
  if (carrier.binary === "bytes") {
    resolved = entries as RoArray<RoPair<V, R>>;
    for (const [, raw] of resolved)
      checkItemSize(carrier, (raw as RoUint8Array).length);
  }
  else {
    const bits = numBitWidth(carrier);
    const signed = carrier.binary === "int";
    const [min, max] = domainBounds(bits, signed) as RoPair<R, R>;
    resolved = entries.map(([value, spec]): RoPair<V, R> =>
      [value, spec === "min" ? min : spec === "max" ? max : spec]
    );
    for (const [, raw] of resolved)
      checkInDomain(raw as NumType, bits, signed, subject);
  }

  assertDistinct(...resolved.map(([value]) => value));
  assertDistinct(...resolved.map(([, raw]) => raw));
  return resolved;
};

// ---- bool ----

const boolConversion = <R extends NumType>(
  carrier:    NumCarrier,
  permissive: boolean,
): Conversion<R, boolean> => {
  const bits = numBitWidth(carrier);
  const [zero, one] = [numBitsToPrimitive(0n, bits), numBitsToPrimitive(1n, bits)] as [R, R];
  checkInDomain(one, bits, carrier.binary === "int", "Bool value");
  return {
    to: encoded => {
      if (encoded === zero)
        return false;

      if (permissive || encoded === one)
        return true;

      throw new Error(`Invalid bool value: ${encoded}`);
    },
    from: value => value ? one : zero,
  };
};

type BitsBoolOpts = NotAnItem & Opts<{ bits: number /*default 1*/ }> & PermissiveOpts;

export const boolItem = Object.assign(
  <const O extends number | NumCarrier | CarrierOpts<NumCarrier> & PermissiveOpts = {}>(
    ...[carrierOrOpts]: OptionalArg<O>
  ): Converted<SizedCarrier<O, NumCarrier>, boolean> => {
    const { carrier, permissive } = sizedCarrier<O, NumCarrier>(carrierOrOpts);
    return converted(carrier, boolConversion(carrier, permissive));
  },
  { bits: <const O extends number | BitsBoolOpts = {}>(
      ...[bitsOrOpts]: OptionalArg<O>
    ): Converted<BitsCarrier<WidthOf<O, "bits">>, boolean> => {
      const { bits, permissive } = widthOpts("bits", bitsOrOpts) as BitsBoolOpts;
      const carrier: BitsCarrier<WidthOf<O, "bits">> =
        { binary: "uint", bits: widthOf<O, "bits">(bits) };
      return converted(carrier, boolConversion(carrier, permissive ?? false));
    },
  },
);

// ---- enum ----

type EnumEntries<R extends NumType = NumType> = RoArray<RoPair<string, RawSpec<R>>>;

const enumConversion = <R extends NumType, const E extends EnumEntries<R>>(
  carrier: NumCarrier,
  entries: E,
): Conversion<R, E[number][0]> => {
  const mapping = resolveMapping<string, R>(carrier, entries, "Enum value");
  const valueToName = new Map<NumType, string>(mapping.map(([name, value]) => [value, name]));
  const nameToValue = new Map<string, R>(mapping);
  return {
    to:   encoded => valueToName.get(encoded) ?? raise(`Invalid enum value: ${encoded}`),
    from: name    => nameToValue.get(name)    ?? raise(`Invalid enum name: ${name}`),
  };
};

type EnumItem<E extends EnumEntries, C extends NumCarrier> = Converted<C, E[number][0]>;

export const enumItem = Object.assign(
  < const E extends EnumEntries<NumCarrierRaw<SizedCarrier<O, NumCarrier>>>,
    const O extends number | NumCarrier | CarrierOpts<NumCarrier> = {},
  >(entries: E, ...[carrierOrOpts]: OptionalArg<O>): EnumItem<E, SizedCarrier<O, NumCarrier>> => {
    const { carrier } = sizedCarrier<O, NumCarrier>(carrierOrOpts);
    return converted(carrier, enumConversion(carrier, entries));
  },
  { bits: //the width is required: unlike bool's single bit, no default is natural for an enum
    < const E extends EnumEntries<NumCarrierRaw<BitsCarrier<B>>>,
            B extends number,
    >(entries: E, bits: B): EnumItem<E, BitsCarrier<B>> => {
      const carrier: BitsCarrier<B> = { binary: "uint", bits };
      return converted(carrier, enumConversion(carrier, entries));
    },
  },
);

// ---- niche ----

//a niche surfaces some of the carrier's raw values under names and passes the rest through its
//  conversion: unlike bool and enum, which replace a bare integer's meaning, it extends the
//  carrier's, so a name must not be one of the carrier's own values. A reserved niche gives its
//  raw value a meaning the plain spelling lacks, so that spelling is rejected; an alias is an
//  unreserved niche, whose plain spelling is the same value and reads back as the name

//non-numeric primitives: a Map matches each by value, and none is a bare carrier's value; a
//  converted carrier's values are excluded at construction
export type NicheValue = string | boolean | symbol | null | undefined;

//a niche is spelled as the carrier surfaces its values, an integer's extremes also as min/max
//  where the carrier has no value of that spelling
type NicheSpec<C extends Carrier> =
  DeriveType<C> | (C extends NumItem ? "min" | "max" : never);
type Niches<C extends Carrier> = RoArray<RoPair<NicheValue, NicheSpec<C>>>;
//the internals' niche list: specs are left unknown, as the factory's signature checked each
//  against its carrier
type NicheList = RoArray<RoPair<NicheValue, unknown>>;

const nicheConversion = <R extends CarrierRaw<Carrier>, S, const N extends NicheList>(
  carrier:  Carrier,
  niches:   N,
  reserved: boolean,
): Conversion<R, S | N[number][0]> => {
  const kind = reserved ? "niche" : "alias";
  const inner =
    (carrier.custom ?? { to: identity, from: identity }) as unknown as Conversion<R, S>;
  //a raw the carrier reads as a name would serialize back as the name's raw. Under the
  //  conversion contract, a value is the carrier's iff it converts to a raw that converts back
  //  to it - a raw of the carrier's primitive, as `from` may pass a foreign value through (the
  //  identity does, and so does a niche for all but its names)
  const isCarrierValue = tryOr(false)((value: unknown) => {
    const raw = inner.from(value as S);
    return (carrier.binary === "bytes" ? isUint8Array(raw) : isNumType(raw)) &&
           inner.to(raw) === value;
  });
  for (const [value] of niches)
    if (isCarrierValue(value))
      throw new Error(`${capitalize(kind)} ${String(value)} is a value of the carrier`);

  const isExtreme = (spec: unknown): spec is "min" | "max" =>
    carrier.binary !== "bytes" && (spec === "min" || spec === "max") && !isCarrierValue(spec);
  const mapping = resolveMapping<NicheValue, R>(
    carrier,
    niches.map(([value, spec]) => [value, isExtreme(spec) ? spec : inner.from(spec as S)]),
    capitalize(kind),
  );
  const nicheOf = (raw: R) => mapping.find(([, nicheRaw]) => valueEquals(nicheRaw, raw));
  const valueToRaw = new Map<unknown, R>(mapping);
  return {
    to: raw => {
      const niche = nicheOf(raw);
      return niche !== undefined ? niche[0] as N[number][0] : inner.to(raw);
    },
    from: value => {
      if (valueToRaw.has(value))
        return valueToRaw.get(value)!;

      const raw = inner.from(value as S);
      if (reserved) {
        const niche = nicheOf(raw);
        if (niche !== undefined)
          throw new Error(`${String(value)} is the niche of ${String(niche[0])}`);
      }
      return raw;
    },
  };
};

type NicheItem<N extends NicheList, C extends Carrier> =
  Merge<{ readonly custom: Conversion<CarrierRaw<C>, DeriveType<C> | N[number][0]> }, C>;

const niched = <C extends Carrier, const N extends NicheList>(
  carrier:  C,
  niches:   N,
  reserved: boolean,
): NicheItem<N, C> => merge(
  { custom: nicheConversion<CarrierRaw<C>, DeriveType<C>, N>(carrier, niches, reserved) },
  carrier,
);

//named, as nicheItem and aliasItem are instantiations of it - see numFactory
type SizedNicheFactory =
  < const N extends Niches<SizedCarrier<O, Carrier>>,
    const O extends number | Carrier | CarrierOpts<Carrier> = {},
  >(niches: N, ...[carrierOrOpts]: OptionalArg<O>) => NicheItem<N, SizedCarrier<O, Carrier>>;
type BitsNicheFactory =
  < const N extends Niches<BitsCarrier<B>>,
            B extends number,
  >(niches: N, bits: B) => NicheItem<N, BitsCarrier<B>>;
type NicheFactory = SizedNicheFactory & { bits: BitsNicheFactory };

const nicheFactory = (reserved: boolean): NicheFactory => {
  const sized: SizedNicheFactory = (niches, ...[carrierOrOpts]) => {
    type O = NonNullable<typeof carrierOrOpts>;
    const { carrier } = sizedCarrier<O, Carrier>(carrierOrOpts);
    return niched(carrier, niches, reserved);
  };
  const bits: BitsNicheFactory = (niches, bits) =>
    niched({ binary: "uint", bits }, niches, reserved);
  return Object.assign(sized, { bits });
};

export const nicheItem = nicheFactory(true);
export const aliasItem = nicheFactory(false);

// ---- option ----

type TagOpts = NotAnItem & SlotUintOpts<NumberSize>;

//spelled out rather than inferred, so it prints by name - see DeclarationEmit.md
type OptionSwitch<T extends CustomizableBytes, A extends Struct, I extends IdItem> = {
  readonly binary:   "switch",
  readonly id:       I,
  readonly tag:      "isSome",
  readonly variants: readonly [
    NamedSwitchVariant<0, false, A                              >,
    NamedSwitchVariant<1, true,  { readonly value: SomeBody<T> }>,
  ],
};
type SomeBody   <T extends CustomizableBytes> = CustomizableBytesReturn<{}, T>;
type OptionValue<T extends CustomizableBytes> = DeriveType<SomeBody<T>>;

type ConvertedOption<T extends CustomizableBytes, A extends Struct, I extends IdItem> =
  OptionSwitch<T, A, I> & {
    readonly custom: Conversion<DeriveType<OptionSwitch<T, A, I>>, OptionValue<T> | undefined>,
  };

type DefaultOptionOpts = TagOpts & PermissiveOpts;

//if permissive, any bytes of the default's size are read and discarded, and the default written;
//  if strict, the body must be the default's encoding
type AbsentItem<P extends boolean | undefined> = BytesBase & Readonly<
  P extends true
  ? { size: number, custom: Conversion<RoUint8Array, undefined> }
  : { fixed: RoUint8Array }
>;
type AbsentBody<P extends boolean | undefined> =
  P extends unknown ? { readonly value: AbsentItem<P> } : never;

export interface OptionItem<
  T extends CustomizableBytes,
  O extends NumberSize | TagOpts = {},
> extends ConvertedOption<T, {}, SlotUint<O>> {}

export interface DefaultOptionItem<
  T extends CustomizableBytes,
  O extends NumberSize | DefaultOptionOpts = {},
> extends ConvertedOption<T, AbsentBody<Get<O, "permissive">>, SlotUint<O>> {}

const convertedOption = <T extends CustomizableBytes, A extends Struct, I extends IdItem>(
  someValue: T,
  absent:    A,
  id:        I,
): ConvertedOption<T, A, I> => ({
  binary:   "switch",
  id,
  tag:      "isSome",
  variants: [ { id: 0, as: false, layout: absent                                      },
              { id: 1, as: true,  layout: { value: customizableBytes({}, someValue) } },
            ],
  custom: {
    to: opt =>
      opt["isSome"] === true
      //the generic union does not narrow on its discriminant while T is open
      ? (opt as Exclude<typeof opt, { isSome: false }>)["value"] as OptionValue<T>
      : undefined,
    from: value =>
      //a permissive absent body is a field and needs its key; a strict one ignores it
      ( { isSome: value !== undefined, value } ) as any, //good luck narrowing this type
  },
});

export const optionItem = <
  const T extends CustomizableBytes,
  const O extends NumberSize | TagOpts = {},
>(someValue: T, ...[tagSizeOrOpts]: OptionalArg<O>): OptionItem<T, O> =>
  convertedOption(someValue, {}, sizedCarrier<O, never>(tagSizeOrOpts).carrier as SlotUint<O>);

export const defaultOptionItem = <
  const T extends CustomizableBytes,
  const O extends NumberSize | DefaultOptionOpts = {},
>(
  someValue:          T,
  defaultValue:       OptionValue<T>,
  ...[tagSizeOrOpts]: OptionalArg<O>
): DefaultOptionItem<T, O> => {
  const fixed = serialize(customizableBytes({}, someValue) as Layout, defaultValue as any);
  const { carrier: tag, permissive } = sizedCarrier<O, never>(tagSizeOrOpts);
  const value: AbsentItem<boolean> =
    permissive
    ? { binary: "bytes", size: fixed.length, custom: { to: () => undefined, from: () => fixed } }
    : { binary: "bytes", fixed };
  return convertedOption(
    someValue,
    { value } as AbsentBody<Get<O, "permissive">>,
    tag as SlotUint<O>,
  );
};

// ---- brand ----

export const brandConversion = <B extends Brand>(): Conversion<Unbrand<B>, B> => ({
  to:   (raw: Unbrand<B>): B => raw as B,
  from: (val: B): Unbrand<B> => val as Unbrand<B>,
});

// ---- utf8 ----

//a wire codec must round-trip faithfully, so the TextDecoder defaults are overridden:
//  malformed UTF-8 throws instead of U+FFFD-substituting (fatal), and a leading BOM is
//  preserved as its character instead of silently swallowed (ignoreBOM)
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

export const utf8Conversion: Conversion<RoUint8Array, string> = {
  to:   (encoded: RoUint8Array): string => textDecoder.decode(encoded as Uint8Array),
  //explicitly annotated: TextEncoder.encode's inferred return type is Node-namespaced and would
  //  leak into the emitted declarations, breaking consumers without @types/node
  from: (decoded: string): RoUint8Array => {
    //TextEncoder never throws - it silently encodes lone surrogates as U+FFFD
    if (!decoded.isWellFormed())
      throw new Error(`string is not well-formed UTF-16 (contains lone surrogates)`);

    return textEncoder.encode(decoded);
  },
};
