import type { Existential, StrRecord,
              RoUint8Array, RoArray, RoPair, RoOfLength,
              TupleRange, Opts, Get, If, Not, And, Or, AllExtend } from "@onrail-xyz/utils";

export type NumType = number | bigint;

//used wherever an object is expected that sprung from the DeriveType type defined below
export type LayoutObject = Readonly<StrRecord>;

export const integerLiterals = ["int", "uint"] as const;
export type IntegerLiteral = typeof integerLiterals[number];
export const binaryLiterals =
  [...integerLiterals, "bytes", "array", "switch", "packed", "codec"] as const;
export type BinaryLiteral = typeof binaryLiterals[number];
export type Endianness = "big" | "little";
export const defaultEndianness = "big";
export type BitOrder = "msbFirst" | "lsbFirst";
export const defaultBitOrder = "msbFirst";

export const bitsPerByte = 8;
//number can express integers of up to 53 bits exactly (Number.MAX_SAFE_INTEGER = 2^53 - 1)
export const numberMaxBits = 53;
//the largest whole byte count that stays within numberMaxBits - the number codec chunks
//  wider values through bigint in chunks of this size
export const numberMaxSize = 6;
export type NumberSize = 1 | 2 | 3 | 4 | 5 | 6;

export type NumSizeToPrimitive<Size extends number> =
  Size extends NumberSize
  ? number
  : Size & NumberSize extends never
  ? bigint
  : number | bigint;

export type NumberBits = Exclude<TupleRange<54>[number], 0>; //1..53

export type NumBitsToPrimitive<Bits extends number> =
  Bits extends NumberBits
  ? number
  : Bits & NumberBits extends never
  ? bigint
  : number | bigint;

//both parameters appear in param and return position (invariant), so the Existential
//  defaults make a bare `Conversion` the "some conversion" type; the to/from naming
//  rationale lives in the README's custom section.
//member-by-member `readonly` rather than a `Readonly<{...}>` body, which would emit under
//  `Readonly`'s name with the to/from pair spelled out at every embedding - see DeclarationEmit.md
export type Conversion<FromType = Existential, ToType = Existential> = {
  readonly to:   (val: FromType) => ToType,
  readonly from: (val: ToType  ) => FromType,
};

//items follow one recipe: ItemBase carries the kind tag and the surfacing trio (whose semantics
//  the README owns), kind-defining members sit in the body, the kind's own optional properties in
//  an Opts heritage clause. Opts declares its properties `readonly` and `| undefined`: an
//  explicitly undefined property counts as absent (the runtime and HasFixed/HasAs/HasCustom
//  agree), so under exactOptionalPropertyTypes generic factories can pass unset options through
//  verbatim instead of conditionally spreading.
//F is the kind's raw domain and C the conversions it admits. Both stay as loose as the kind's
//  shape wherever the correlation with `layout` cannot be carried at interface level: a narrower
//  F would reject legal layouts (a bytes-with-layout over a scalar-deriving sub-layout) and
//  `Conversion<unknown>` would reject every real conversion (contravariance) - factories and
//  DeriveType carry the precision
export interface ItemBase<
  BL extends BinaryLiteral,
  F,
  C  extends Conversion = Conversion,
> extends Opts<{ fixed: F, as: unknown, custom: C }> {
  readonly binary: BL,
}

// ---- uint / int ----

type NumConversion = Conversion<number> | Conversion<bigint>;

export interface SizedNumItem<BL extends IntegerLiteral = IntegerLiteral>
    extends ItemBase<BL, NumType, NumConversion>, Opts<{
  endianness: Endianness, //see defaultEndianness
}> {
  readonly size: number,
}

export interface BitsNumItem<BL extends IntegerLiteral = IntegerLiteral>
    extends ItemBase<BL, NumType, NumConversion> {
  readonly bits: number,
}

export type NumItem<BL extends IntegerLiteral = IntegerLiteral> =
  SizedNumItem<BL> | BitsNumItem<BL>;
export type UintItem = NumItem<"uint">;
export type IntItem  = NumItem<"int">;

// ---- codec ----

//Raw is no claim of unprocessedness - a codec may emit richly processed values
export interface CodecItem<Raw = Existential>
    extends ItemBase<"codec", Raw, Conversion<Raw>>, Opts<{
  //declared size bounds *of the encoding* - consumed by the discriminator and size
  //  calculation (minSize === maxSize implies a static size); default [0, Infinity);
  //  moot under `fixed`, whose exact encoded size (and bytes) supersede them
  minSize: number,
  maxSize: number,
}> {
  readonly read:   (bytes: RoUint8Array, offset: number) => RoPair<Raw, number>,
  readonly write:  (raw: Raw, bytes: Uint8Array, offset: number) => number, //new offset
  readonly sizeOf: (raw: Raw) => number,
}

// ---- prefix ----

//a `fixed?: undefined` ban on the malformed fixed-prefix case would reject any value
//  *annotated* with an item interface, since the interfaces declare fixed as optional
export type PrefixItem =
  | SizedNumItem<"uint"> & { readonly size: NumberSize } //only uints that produce numbers
  | CodecItem<number>
  | Readonly<{ binary: BinaryLiteral, custom: Conversion<Existential, number> }>;

export type IdItem = SizedNumItem | CodecItem<number>;

export type Count = number | PrefixItem;

// ---- bytes ----

export interface BytesItem extends ItemBase<"bytes", unknown>, Opts<{
  size:   Count,
  layout: Layout,
}> {}

// ---- array ----

export interface ArrayItem extends ItemBase<"array", RoArray<unknown>>, Opts<{
  length: Count,
}> {
  readonly layout: Layout,
}

// ---- switch ----

export type ScalarId = NumType;
export type RangeId  = RoPair<NumType, NumType>; //inclusive [lo, hi] range of wire values

//wire value(s), in the id item's raw domain
export type VariantId = ScalarId | RangeId;

export type VariantBody = Struct | SwitchItem;

export interface SwitchVariant extends Opts<{
  as: unknown, //surfaced tag value; scalar ids only; defaults to id (undefined counts as
               //  absent, so a nothing-flavored tag is spelled null)
}> {
  readonly id:     VariantId,
  readonly layout: VariantBody,
}

export interface SwitchItem extends ItemBase<"switch", LayoutObject> {
  readonly tag:      string, //property name of the discriminant in the derived type
  readonly id:       IdItem, //wire encoding of the discriminant (conversion-free)
  readonly variants: RoArray<SwitchVariant>,
}

// ---- packed ----

interface PackedItemBase extends ItemBase<"packed", LayoutObject>, Opts<{
  bitOrder: BitOrder, //see defaultBitOrder
}> {
  readonly layout: Struct, //fields are bit-granular items (or byte-sized: 8 * size bits)
}

export interface SizedPackedItem extends PackedItemBase, Opts<{
  size:       number,     //derived from the bit sum when absent - may exceed it, the
                          //  slack is padded with zeros
  endianness: Endianness, //byte order of the word; see defaultEndianness
}> {}

export interface BitsPackedItem extends PackedItemBase, Opts<{
  bits: number, //derived from the bit sum when absent - may exceed it, the slack is zero-padded
}> {}

export type PackedItem = SizedPackedItem | BitsPackedItem;

// ---- layout ----

export type Item = NumItem | BytesItem | ArrayItem | SwitchItem | PackedItem | CodecItem;

export interface Struct extends Readonly<StrRecord<Item | Struct>> {}

export type Layout = Item | Struct;

// ---- DeriveType ----

type NumericKeys<S> = Extract<keyof S, number | `${number}`>;

type _Has<I, K extends "fixed" | "as" | "custom"> = Not<AllExtend<Get<I, K>, undefined>>;
export type HasFixed <I> = _Has<I, "fixed" >;
export type HasAs    <I> = _Has<I, "as"    >;
export type HasCustom<I> = _Has<I, "custom">;

export type IsOmitted<I> = And<HasFixed<I>, Not<Or<HasAs<I>, HasCustom<I>>>>;

type StructKey<S extends Struct, K extends keyof S> =
  If<IsOmitted<S[K]>, never, K>;

type StructToType<S extends Struct> =
  //a lingering index signature marks a wildcard struct (a concrete literal has exact keys;
  //  `Struct extends S` would misfire since the empty struct `{}` also matches it)
  string extends keyof S
  ? LayoutObject
  : NumericKeys<S> extends never
  ? { readonly [K in keyof S as StructKey<S, K>]: DeriveType<S[K]> }
  : { "!error": `struct keys must not be integer-like`, keys: NumericKeys<S> };

export type DeriveType<L extends Layout> =
  Layout extends L
  ? unknown
  : L extends infer LI extends Item
  ? ItemToType<LI>
  : L extends infer S extends Struct
  ? StructToType<S>
  : never;

type ItemToType<II extends Item> =
  II extends infer I extends Item //force distribution over unions
  ? I extends NumItem
    ? NumItemToType<I>
    : I extends BytesItem
    ? BytesItemToType<I>
    : I extends ArrayItem
    ? ArrayItemToType<I>
    : I extends SwitchItem
    ? SwitchItemToType<I>
    : I extends PackedItem
    ? PackedItemToType<I>
    : I extends CodecItem
    ? CodecItemToType<I>
    : never
  : never;

type CustomToType<I> =
  Get<I, "custom"> extends Conversion<infer _From, infer To> ? To : never;

type ConvertOrOmit<I, Bare> =
  If<HasFixed<I>,
    If<HasAs<I>, Get<I, "as">, If<HasCustom<I>, CustomToType<I>, undefined>>,
    If<HasCustom<I>, CustomToType<I>, Bare>
  >;

//---NumItem---

type NumItemToType<I extends NumItem> =
  ConvertOrOmit<I,
    Get<I, "size"> extends infer S extends number
    ? NumSizeToPrimitive<S>
    : Get<I, "bits"> extends infer B extends number
    ? NumBitsToPrimitive<B>
    : never
  >;

//---BytesItem---

type BytesItemToType<I extends BytesItem> =
  ConvertOrOmit<I,
    Get<I, "layout"> extends infer L extends Layout
    ? DeriveType<L>
    : RoUint8Array
  >;

//---ArrayItem---

//branches on the length alone: a check on the element type would stay deferred while that type
//  is still generic (an amount at an open kind), where the length never is
type ArrayItemToType<I extends ArrayItem> =
  ConvertOrOmit<I,
    Get<I, "length"> extends infer AL extends number
    ? RoOfLength<DeriveType<I["layout"]>, AL> //tuple for a literal length, RoArray for `as number`
    : RoArray<DeriveType<I["layout"]>> //count prefix or flex array
  >;

//---SwitchItem---

//the primitive the id item reads off the wire - used as the tag type of range variants
type IdPrimitive<I extends SwitchItem> =
  DeriveType<I["id"]> extends infer P extends NumType ? P : number;

type VariantTagValue<V extends SwitchVariant, IdPrim> =
  V["id"] extends RangeId
  ? IdPrim //range variants surface the concrete wire value; a stray `as` is ignored
  : [Get<V, "as">] extends [undefined]
  ? V["id"]
  : Get<V, "as">;

//distributes over DTU: a switch body contributes one union member per inner variant, each
//  gaining the outer tag - the flat multi-tag union of the subcommand pattern
type MergeTag<DTU, Tag extends string, TagValue> =
  DTU extends LayoutObject
  ? { readonly [K in Tag | keyof DTU]: K extends keyof DTU ? DTU[K] : TagValue }
  : never;

//an unspecific switch body (`VariantBody` itself) would recurse forever through
//  SwitchItemToType - collapse it to the wildcard object, mirroring StructToType. A pinned or
//  converted switch body derives one arbitrary value rather than an object union to merge,
//  so it derives a readable error instead. For struct bodies, Exclude narrows the declared union
//  without adding Struct's index signature (an `& Struct` would trip the wildcard check) and stays
//  resolvable when field types are still generic
type VariantBodyToType<L extends VariantBody> =
  L extends infer I extends SwitchItem
  ? SwitchItem extends I
    ? LayoutObject
    : If<Or<HasFixed<I>, HasCustom<I>>,
        { "!error": `a switch body in variant position must not carry fixed/custom` },
        SwitchItemToType<I>
      >
  : StructToType<Exclude<L, SwitchItem>>;

//the infer is necessary: it resolves the body type into concrete members before MergeTag can
//  defer on it, keeping variant unions discriminable while field types are still generic
//  (optionItem's isSome narrowing is the canary)
type VariantToType<V extends SwitchVariant, Tag extends string, IdPrim> =
  VariantBodyToType<V["layout"]> extends infer DT extends LayoutObject
  ? MergeTag<DT, Tag, VariantTagValue<V, IdPrim>>
  : never;

type VariantsToTypeUnion<V extends RoArray<SwitchVariant>, Tag extends string, IdPrim> =
  V extends RoArray<infer VI extends SwitchVariant>
  ? VI extends SwitchVariant
    ? VariantToType<VI, Tag, IdPrim>
    : never
  : never;

type SwitchItemToType<I extends SwitchItem> =
  ConvertOrOmit<I, VariantsToTypeUnion<I["variants"], I["tag"], IdPrimitive<I>>>;

//---PackedItem---

type PackedItemToType<I extends PackedItem> =
  ConvertOrOmit<I, StructToType<I["layout"]>>;

//---CodecItem---

type CodecItemToType<I extends CodecItem> =
  ConvertOrOmit<I, I extends CodecItem<infer Raw> ? Raw : never>;
