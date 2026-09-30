import type { RoUint8Array, RoArray, RoPair } from "@onrail-xyz/utils";
import { isUint8Array } from "@onrail-xyz/utils";
import type { Layout, Item, Struct, NumType, NumberSize,
              NumSizeToPrimitive, NumBitsToPrimitive, Endianness,
              Conversion, ArrayItem, SwitchItem, SwitchVariant, VariantId } from "./layout.js";
import { binaryLiterals, numberMaxSize, numberMaxBits, bitsPerByte } from "./layout.js";

//JS truncates the operands of << and >> to int32, so shifting a number by a byte has to go
//  through multiplication/division instead
export const byteMulShift = 256;

const isNumType = (x: unknown): x is NumType =>
  typeof x === "number" || typeof x === "bigint";

//the byte sizes the number path carries, i.e. those readNum derives a `number` for
export const isNumberSize = (size: number): size is NumberSize =>
  Number.isInteger(size) && size >= 1 && size <= numberMaxSize;

//the value-level counterparts of NumSizeToPrimitive and NumBitsToPrimitive: a width's domain is
//  `number` while it fits one and `bigint` beyond, so a value the engine accumulated as a bigint
//  narrows here rather than at each caller
export const numSizeToPrimitive = <S extends number>(
  value: bigint,
  size:  S,
): NumSizeToPrimitive<S> =>
  (size <= numberMaxSize ? Number(value) : value) as NumSizeToPrimitive<S>;

export const numBitsToPrimitive = <B extends number>(
  value: bigint,
  bits:  B,
): NumBitsToPrimitive<B> =>
  (bits <= numberMaxBits ? Number(value) : value) as NumBitsToPrimitive<B>;

//called on every node of every pass: one property load and a hash lookup, where a string check
//  and an array scan would load `binary` twice
const binaryLiteralSet: ReadonlySet<unknown> = new Set(binaryLiterals);

export const isItem = (x: any): x is Item => binaryLiteralSet.has(x?.binary);

export const isStruct = (x: unknown): x is Struct =>
  typeof x === "object" && x !== null && !Array.isArray(x) && !isUint8Array(x) && !isItem(x);

export const isLayout = (x: unknown): x is Layout =>
  isItem(x) || (isStruct(x) && Object.values(x).every(isLayout));

export const hasFixed = (item: Item): boolean =>
  (item as { fixed?: unknown }).fixed !== undefined;

export const hasAs = (item: Item): boolean =>
  (item as { as?: unknown }).as !== undefined;

export const hasCustom = (item: Item): boolean =>
  (item as { custom?: unknown }).custom !== undefined;

export const customOf = (item: Item): Conversion | undefined =>
  (item as { custom?: Conversion }).custom;

export const fixedOf = (item: Item): any =>
  (item as { fixed?: unknown }).fixed;

export const asOf = (item: Item): any =>
  (item as { as?: unknown }).as;

//callers must only invoke this for items carrying `fixed`
export const surfaceFixed = (item: Item): unknown =>
  hasAs(item) ? asOf(item) : customOf(item)?.to(fixedOf(item));

//absent from the bit-width arm of the num and packed unions alike: a bit-range is part of an
//  enclosing word, which is what owns the byte order
export const endiannessOf = (item: Item): Endianness | undefined =>
  (item as { endianness?: Endianness }).endianness;

export const isOmitted = (item: Item): boolean =>
  hasFixed(item) && !hasAs(item) && !hasCustom(item);

//the layout that renders a fixed aggregate's raw value: the item's own content rules minus
//  the pinning. A length prefix stays out - like a fixed bytes item's size prefix, it is
//  handled by the generic prefix path around the cached content
export const fixedContentLayout = (item: ArrayItem | SwitchItem): Layout =>
  item.binary === "array"
  ? { binary: "array", layout: item.layout }
  : { binary: "switch", id: item.id, tag: item.tag, variants: item.variants };

export const itemHasLayout = (item: Item): item is Item & { layout: Layout } =>
  (item as { layout?: unknown }).layout !== undefined;

//a num item's width inside a packed word: its bits, or its bytes as bits
export const numBitWidth = (item: Item): number => {
  const bits = (item as { bits?: number }).bits;
  return bits !== undefined ? bits : bitsPerByte * (item as { size: number }).size;
};

// ---- struct keys ----

const structKeysCache = new WeakMap<Struct, RoArray<string>>();

//a struct's fields in wire order - which is key order, so this reports whatever order JS gives:
//  insertion order, except for the integer-like keys the type level rejects. Cached on the
//  struct's identity like the engine's other per-layout work
export const structKeys = (struct: Struct): RoArray<string> => {
  let keys = structKeysCache.get(struct);
  if (keys === undefined) {
    keys = Object.keys(struct);
    structKeysCache.set(struct, keys);
  }
  return keys;
};

// ---- value checks ----

export const checkSize = (layoutSize: number, dataSize: number): number => {
  if (layoutSize !== dataSize)
    throw new Error(`size mismatch: layout size: ${layoutSize}, data size: ${dataSize}`);

  return dataSize;
};

//checks the size an item states (if a plain number) against its content: the caller's data, or
//  the item's own fixed value
export const checkItemSize = (item: Item, dataSize: number): number => {
  const size = (item as { size?: unknown }).size;
  if (typeof size === "number")
    checkSize(size, dataSize);

  return dataSize;
};

export const checkLength = (layoutLength: number, dataLength: number): void => {
  if (layoutLength !== dataLength)
    throw new Error(
      `array length mismatch: layout length: ${layoutLength}, data length: ${dataLength}`);
};

//the array counterpart of checkItemSize
export const checkItemLength = (item: Item, dataLength: number): void => {
  const length = (item as { length?: unknown }).length;
  if (typeof length === "number")
    checkLength(length, dataLength);
};

//prefixes a failure below a struct field with the field's name on its way up. Conversions and
//  codecs are user code and may throw anything, so a non-Error is wrapped rather than mutated
export const fieldError = (e: unknown, verb: string, key: string): unknown => {
  const context = `when ${verb} field '${key}'`;
  if (e instanceof Error) {
    e.message = `${context}: ${e.message}`;
    return e;
  }
  return new Error(`${context}: ${String(e)}`, { cause: e });
};

//resolves a struct field's slice of the data: omitted fields carry none, all others must be
//  present
export const fieldDataOf = (field: Layout, data: any, key: string): any => {
  if (isItem(field) && isOmitted(field))
    return undefined;

  if (!(key in data))
    throw new Error(`missing data for layout field: ${key}`);

  return data[key];
};

const numEquals = (lhs: NumType, rhs: NumType): boolean =>
  typeof lhs === typeof rhs ? lhs === rhs : BigInt(lhs) === BigInt(rhs);

const numLessOrEqual = (lhs: NumType, rhs: NumType): boolean =>
  typeof lhs === typeof rhs
  ? lhs <= rhs
  : BigInt(lhs) <= BigInt(rhs);

export const checkNumEquals = (fixed: NumType, data: NumType): void => {
  if (!numEquals(fixed, data))
    throw new Error(`value mismatch: (fixed) layout value: ${fixed}, data value: ${data}`);
};

type RoSamePair<T> = RoPair<T, T>;

const hexByte = (byte: number) => byte.toString(16).padStart(2, "0");

//names the first mismatching byte rather than printing the buffers: `bytes` is the whole input,
//  and a discriminator probing candidates hits this on every rejection
export const checkBytesEqual = (
  expected: RoUint8Array,
  bytes:    RoUint8Array,
  start:    number,
): void => {
  for (let i = 0; i < expected.length; ++i)
    if (expected[i] !== bytes[start + i])
      throw new Error(`fixed bytes mismatch at offset ${start + i}: ` +
        `expected 0x${hexByte(expected[i]!)}, got 0x${hexByte(bytes[start + i]!)}`);
};

// ---- switch variants ----

export const isRangeId = (id: VariantId): id is RoSamePair<NumType> =>
  Array.isArray(id);

const variantHasAs = (variant: SwitchVariant): boolean => variant.as !== undefined;

export const variantTagValue = (variant: SwitchVariant, rawId: NumType): unknown =>
  isRangeId(variant.id)
  ? rawId
  : variantHasAs(variant)
  ? variant.as
  : variant.id;

//Variant lookup is first-match in variant order in both directions, so overlapping ids
//  resolve consistently: the earlier variant takes precedence on the wire and in data.

//a scalar id or bare tag value matches across number and bigint, so a lookup key is entered
//  under both spellings wherever both are exact
const numKeys = (value: NumType): NumType[] => {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) && BigInt(asNumber) === value
      ? [value, asNumber]
      : [value];
  }
  return Number.isInteger(value) ? [value, BigInt(value)] : [value];
};

const rangeCovers = (id: RoSamePair<NumType>, value: NumType): boolean =>
  numLessOrEqual(id[0], value) && numLessOrEqual(value, id[1]);

type RangeVariant = SwitchVariant & { readonly id: RoSamePair<NumType> };

const findRange = (ranges: RoArray<RangeVariant>, value: NumType): RangeVariant | undefined =>
  ranges.find(range => rangeCovers(range.id, value));

//per-switch lookup tables: exact keys resolve through a Map, whatever misses falls back to the
//  ranges in variant order. A key is entered only for the first variant matching it, and not at
//  all when an earlier range already covers it - so a hit is always the first match
type VariantIndex = {
  byRawId:    Map<unknown, SwitchVariant>,
  byTagValue: Map<unknown, SwitchVariant>,
  ranges:     RoArray<RangeVariant>,
};

const variantIndexCache = new WeakMap<SwitchItem, VariantIndex>();

function variantIndexOf(item: SwitchItem): VariantIndex {
  let index = variantIndexCache.get(item);
  if (index === undefined) {
    const byRawId = new Map<unknown, SwitchVariant>();
    const byTagValue = new Map<unknown, SwitchVariant>();
    const ranges: RangeVariant[] = [];
    const enter = (map: Map<unknown, SwitchVariant>, key: unknown, variant: SwitchVariant) => {
      if (!map.has(key) && (!isNumType(key) || findRange(ranges, key) === undefined))
        map.set(key, variant);
    };
    for (const variant of item.variants) {
      const { id } = variant;
      if (isRangeId(id)) {
        ranges.push(variant as RangeVariant);
        continue;
      }
      for (const key of numKeys(id))
        enter(byRawId, key, variant);

      if (variantHasAs(variant))
        enter(byTagValue, variant.as, variant);
      else
        for (const key of numKeys(id))
          enter(byTagValue, key, variant);
    }
    index = { byRawId, byTagValue, ranges };
    variantIndexCache.set(item, index);
  }
  return index;
}

//variant lookup by deserialized wire id
export function findVariantByRawId(item: SwitchItem, rawId: NumType): SwitchVariant {
  const index = variantIndexOf(item);
  const variant = index.byRawId.get(rawId) ?? findRange(index.ranges, rawId);
  if (variant === undefined)
    throw new Error(`unknown id value: ${rawId}`);

  return variant;
}

//whether a tag value routes to the variant: a range takes the wire values it spans, a renamed
//  scalar its `as`, a bare scalar its id
export const variantTagMatches = (variant: SwitchVariant, tagValue: unknown): boolean => {
  const { id } = variant;
  return isRangeId(id)
    ? isNumType(tagValue) && rangeCovers(id, tagValue)
    : variantHasAs(variant)
    ? variant.as === tagValue
    : isNumType(tagValue) && numEquals(id, tagValue);
};

//variant lookup by tag value of the data (serialization direction)
export function findVariantByTagValue(item: SwitchItem, tagValue: unknown): SwitchVariant {
  const index = variantIndexOf(item);
  const variant = index.byTagValue.get(tagValue)
    ?? (isNumType(tagValue) ? findRange(index.ranges, tagValue) : undefined);
  if (variant === undefined)
    throw new Error(`unknown tag value: ${tagValue}`);

  return variant;
}

export const rawIdOf = (variant: SwitchVariant, tagValue: unknown): NumType =>
  isRangeId(variant.id) ? tagValue as NumType : variant.id;
