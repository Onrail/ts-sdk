import type { RoUint8Array, RoArray, RoPair, Opts,
              Merge, Get, Brand, Unbrand, OptionalArg } from "@onrail-xyz/utils";
import { assertDistinct, zip, isUint8Array, merge } from "@onrail-xyz/utils";
import type { Layout, LayoutObject, Struct,
              Endianness, BitOrder, Conversion, NumType,
              NumSizeToPrimitive, NumBitsToPrimitive,
              NumberSize, NumberBits, Count, IdItem,
              SwitchItem, SwitchVariant, VariantId, VariantBody,
              CodecItem, DeriveType, BinaryLiteral, IntegerLiteral } from "./layout.js";
import { bitsPerByte, numberMaxSize } from "./layout.js";
import { isItem, isLayout, hasFixed, hasCustom, isRangeId, variantTagMatches } from "./utils.js";
import { fitsInBits } from "./numbers.js";

// ---- kind factories ----

//a width slot normalized to an opts record: a bare width becomes `{ [K]: width }`. Which widths
//  a kind admits is the signature's job; here numbers and prefix items are widths and opts
//  records are not (they carry no `binary`)
type Width = "size" | "length" | "bits";
//a bare width is a number or an item, told from an opts record by `binary`. Testing against
//  `Count` itself would leave the conditional undecided at an open O: a prefix item of number
//  width is structurally an opts record with a `size`, so tsc keeps the count branch alive
type WidthOpts<O, K extends Width> =
  O extends number | { readonly binary: BinaryLiteral } ? { readonly [P in K]: O } : O;
//a defaulted width sits in opts like every other optional member: widthOf applies the unit
//  width - the default of every kind that defaults its width at all - and WidthOf reads the
//  literal back out of the normalized slot or falls back to it. W is the widths the kind admits
type WidthOf<O, K extends Width, W extends number = number> =
  Get<WidthOpts<O, K>, K> extends infer X extends W ? X : 1;
const widthOf =
  <O, K extends Width, W extends number = number>(specified: Count | undefined) =>
    (specified ?? 1) as WidthOf<O, K, W>;
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
type NumBase<BL extends IntegerLiteral, S extends number> =
  { readonly binary: BL, readonly size: S };
type BitsBase<BL extends IntegerLiteral, B extends number> =
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
  ) => Merge<NumBase<BL, S>, O>;
type BitsNumFactory<BL extends IntegerLiteral> =
  <B extends number, const O extends BitsNumOpts<B> = {}>(
    bits:      B,
    ...[opts]: OptionalArg<O>
  ) => Merge<BitsBase<BL, B>, O>;
type NumFactory<BL extends IntegerLiteral> = SizedNumFactory<BL> & { bits: BitsNumFactory<BL> };

const numFactory = <BL extends IntegerLiteral>(binary: BL): NumFactory<BL> => {
  const sized: SizedNumFactory<BL> = (size, ...[opts]) => merge({ binary, size }, opts);
  const bits:   BitsNumFactory<BL> = (bits, ...[opts]) => merge({ binary, bits }, opts);
  return Object.assign(sized, { bits });
};

export const uintItem = numFactory("uint");
export const intItem  = numFactory("int");

//an opts record is not an item: without the ban, a uint item too wide to be a prefix would pass
//  as a record whose `size` happens to be a number
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

type PackedOpts = BaseOpts<LayoutObject> & Opts<{
  size:       number,
  endianness: Endianness,
  bitOrder:   BitOrder,
}>;

//a lane inherits nothing but its place, and its width defaults to the layout's bit sum; byte
//  order stays with the enclosing word, so the bit form has no endianness to offer
type BitsPackedOpts = BaseOpts<LayoutObject> & Opts<{ bits: number, bitOrder: BitOrder }>;

export const packedItem = Object.assign(
  <const S extends Struct, const O extends number | PackedOpts = {}>(
    layout:          S,
    ...[sizeOrOpts]: OptionalArg<O>
  ): Merge<PackedBase<S>, WidthOpts<O, "size">> =>
    merge({ binary: "packed", layout }, widthOpts("size", sizeOrOpts)), {
  bits: <const S extends Struct, const O extends number | BitsPackedOpts = {}>(
    layout:          S,
    ...[bitsOrOpts]: OptionalArg<O>
  ): Merge<PackedBase<S>, WidthOpts<O, "bits">> =>
    merge({ binary: "packed", layout }, widthOpts("bits", bitsOrOpts)),
});

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

  const bits = id.size * bitsPerByte;
  const signed = id.binary === "int";
  const primitive = id.size > numberMaxSize ? "bigint" : "number";
  for (const vid of ids)
    for (const bound of isRangeId(vid) ? vid : [vid]) {
      if (typeof bound !== primitive)
        throw new Error(`switch variant id ${bound} is a ${typeof bound}, ` +
                        `but a ${id.size}-byte id reads as a ${primitive}`);

      const fits = fitsInBits(bound as any, bits as any, signed);
      if (!fits)
        throw new Error(`switch variant id ${bound} does not fit in ${signed ? "i" : "u"}${bits}`);
    }
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

// ---- custom uints ----

//the width slot arrives already normalized, so WidthOf reads the caller's literal straight off
//  T, and the cast that produces T is where each factory states what it consumed
type CustomUintBase<T, C extends Conversion<number>> =
  { readonly binary: "uint", readonly size: WidthOf<T, "size">, readonly custom: C };
const customUint = <
  const T extends Opts<{ size: NumberSize }>,
        C extends Conversion<number>,
>(opts: T, custom: C): Merge<CustomUintBase<T, C>, T> =>
  merge({ binary: "uint", size: widthOf<T, "size">(opts.size), custom }, opts);

const customUintBits = <B extends NumberBits, C extends Conversion<number>>(bits: B, custom: C) =>
  ({ binary: "uint", bits, custom } as const);

// ---- bool ----

const boolConversion = (permissive: boolean) => ({
  to: (encoded: number): boolean => {
    if (encoded === 0)
      return false;

    if (permissive || encoded === 1)
      return true;

    throw new Error(`Invalid bool value: ${encoded}`);
  },
  from: (value: boolean): number => value ? 1 : 0,
} as const);

type SizedBoolOpts = Opts<{
  size:       NumberSize, //default 1
  permissive: boolean,
  endianness: Endianness,
}>;
type BitsBoolOpts = Opts<{
  bits:       NumberBits, //default 1
  permissive: boolean,
}>;

type BoolConversion = ReturnType<typeof boolConversion>;
type SizedBoolItemOpts<O> = Omit<WidthOpts<O, "size">, "permissive">;

export const boolItem = Object.assign(
  <const O extends NumberSize | SizedBoolOpts = {}>(...[sizeOrOpts]: OptionalArg<O>):
    Merge<CustomUintBase<SizedBoolItemOpts<O>, BoolConversion>, SizedBoolItemOpts<O>> => {
    //permissive picks the conversion; it is not an item property and must stay out of the spread
    const { permissive, ...itemOpts } = widthOpts("size", sizeOrOpts) as SizedBoolOpts;
    return customUint(itemOpts as SizedBoolItemOpts<O>, boolConversion(permissive ?? false));
  },
  {
    bits: <const O extends NumberBits | BitsBoolOpts = {}>(
      ...[bitsOrOpts]: OptionalArg<O>
    ) => {
      const { bits, permissive } = widthOpts("bits", bitsOrOpts) as BitsBoolOpts;
      return customUintBits(
        widthOf<O, "bits", NumberBits>(bits),
        boolConversion(permissive ?? false),
      );
    },
  },
);

// ---- enum ----

type EnumEntries = RoArray<RoPair<string, number>>;
type EnumOpts = Opts<{
  size:       NumberSize, //default 1
  endianness: Endianness,
}>;

const enumConversion = <const E extends EnumEntries>(entries: E) => {
  //a repeated name or value makes the mapping non-injective, so a value that serializes fine
  //  deserializes back as a different one - the silent round-trip break
  //  checkVariantReachability rejects for switch variants
  const [names, values] = zip(entries as EnumEntries);
  assertDistinct(...names);
  assertDistinct(...values);
  const valueToName = Object.fromEntries(entries.map(([name, value]) => [value, name]));
  const nameToValue = Object.fromEntries(entries);
  return {
    to: (encoded: number): E[number][0] => {
      const name = valueToName[encoded];
      if (name === undefined)
        throw new Error(`Invalid enum value: ${encoded}`);

      return name;
    },
    from: (name: E[number][0]): number => {
      const value = nameToValue[name];
      if (value === undefined)
        throw new Error(`Invalid enum name: ${name}`);

      return value;
    },
  } as const;
};

type EnumConversion<E extends EnumEntries> = ReturnType<typeof enumConversion<E>>;

export const enumItem = Object.assign(
  <const E extends EnumEntries, const O extends NumberSize | EnumOpts = {}>(
    entries:         E,
    ...[sizeOrOpts]: OptionalArg<O>
  ): Merge<CustomUintBase<WidthOpts<O, "size">, EnumConversion<E>>, WidthOpts<O, "size">> =>
    customUint(widthOpts("size", sizeOrOpts), enumConversion(entries)),
  {
    //the width is required: unlike bool's single bit, no default is natural for an enum
    bits: <const E extends EnumEntries, B extends NumberBits>(entries: E, bits: B) =>
      customUintBits(bits, enumConversion(entries)),
  },
);

// ---- option ----

const baseOptionItem = <const T extends CustomizableBytes>(someValue: T) => ({
  binary:   "switch",
  id:       { binary: "uint", size: 1 },
  tag:      "isSome",
  variants: [ { id: 0, as: false, layout: {}                                          },
              { id: 1, as: true,  layout: { value: customizableBytes({}, someValue) } },
            ],
} as const);

type BaseOption<T extends CustomizableBytes> =
  DeriveType<ReturnType<typeof baseOptionItem<T>>>;

type BaseOptionValue<T extends CustomizableBytes> =
  DeriveType<CustomizableBytesReturn<{}, T>> | undefined;

//`undefined` is the absence, so a payload must not surface it: an option of an option collapses
//  Some(None) into None
export const optionItem = <const T extends CustomizableBytes>(someValue: T) => ({
  ...baseOptionItem(someValue),
  custom: {
    to: (opt: BaseOption<T>): BaseOptionValue<T> =>
      opt.isSome === true
      //the generic union does not narrow on its discriminant while T is open
      ? (opt as Exclude<typeof opt, { isSome: false }>)["value"] as BaseOptionValue<T>
      : undefined,
    from: (value: BaseOptionValue<T>): BaseOption<T> =>
      value === undefined
      ? { isSome: false }
      : { isSome: true, value } as any, //good luck narrowing this type
  } satisfies Conversion<BaseOption<T>, BaseOptionValue<T>>
} as const);

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
