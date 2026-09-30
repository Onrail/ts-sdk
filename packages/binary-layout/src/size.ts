import type { RoUint8Array, RoArray, Opts } from "@onrail-xyz/utils";
import type { Layout, Item, SizedPackedItem,
              DeriveType, PrefixItem, Count, CodecItem, BytesItem } from "./layout.js";
import { bitsPerByte } from "./layout.js";
import { isItem, structKeys, customOf, fixedOf, fieldDataOf,
         itemHasLayout, checkItemSize, checkItemLength,
         isRangeId, findVariantByTagValue, rawIdOf, fieldError } from "./utils.js";
import { getCachedFixedBytes } from "./serialize.js";

// ---- concrete sizing ----

export function calcSize<const L extends Layout>(layout: L, data: DeriveType<L>): number {
  return internalCalcSize(layout, data);
}

//Entries produced during the size pass and consumed by the serialization pass in the exact
//  same traversal order:
//  * items with `custom` whose raw value the passes traverse (bytes, array, switch, codec):
//    the raw conversion result (avoids re-converting)
//  * bytes items with a prefix item as `size`: the payload byte size (must be known before
//    the payload is written since the prefix comes first and may be variable-width) - the
//    slot is reserved before recursing and backpatched after, keeping pop order pre-order
export type SerializationQueue = {
  entries:  any[],
  position: number,
};

export function calcSizeForSerialization<const L extends Layout>(
  layout: L,
  data:   DeriveType<L>
): [number, SerializationQueue] {
  const queue: SerializationQueue = { entries: [], position: 0 };
  return [internalCalcSize(layout, data, queue), queue];
}

export function internalCalcSize(
  layout: Layout,
  data:   any,
  queue?: SerializationQueue,
): number {
  if (isItem(layout))
    return calcItemSize(layout, data, queue);

  let size = 0;
  for (const key of structKeys(layout)) {
    const fieldLayout = layout[key]!;
    const fieldData = fieldDataOf(fieldLayout, data, key);
    try {
      size += internalCalcSize(fieldLayout, fieldData, queue);
    }
    catch (e) {
      throw fieldError(e, "sizing", key);
    }
  }
  return size;
}

function calcItemSize(
  item:   Item,
  data:   any,
  queue?: SerializationQueue,
): number {
  switch (item.binary) {
    case "int":
    case "uint": {
      if (!("size" in item) || item.size === undefined)
        throw new Error(`num items with bit width are only legal inside packed layouts`);

      return item.size;
    }
    case "bytes": {
      const size = (item as { size?: Count }).size;
      const prefix = typeof size === "object" ? size : undefined;
      const custom = customOf(item);
      const fixed = fixedOf(item);

      //fixed: the content is a constant, rendered once into the cache - no traversal, no queue
      //  entries
      if (fixed !== undefined) {
        const contentSize = getCachedFixedBytes(item).length;
        return (prefix !== undefined ? prefixEncodedWidth(prefix, contentSize) : 0) + contentSize;
      }

      //with custom, traversal happens on the raw conversion result
      let raw = data;
      if (custom !== undefined) {
        raw = custom.from(data);
        queue?.entries.push(raw);
      }

      //reserve the payload size slot before recursing so the serializer pops it pre-order
      const slot = queue !== undefined && prefix !== undefined ? queue.entries.length : -1;
      if (slot >= 0)
        queue!.entries.push(undefined);

      const contentSize = itemHasLayout(item)
        ? internalCalcSize(item.layout, raw, queue)
        : (raw as RoUint8Array).length;

      if (slot >= 0)
        queue!.entries[slot] = contentSize;

      return (prefix !== undefined ? prefixEncodedWidth(prefix, contentSize) : 0)
        + checkItemSize(item, contentSize);
    }
    case "array": {
      const { length } = item;
      const fixed = fixedOf(item);

      //fixed: the content is a constant, rendered once into the cache - no traversal, no queue
      //  entries
      if (fixed !== undefined)
        return (typeof length === "object" ? prefixEncodedWidth(length, fixed.length) : 0)
          + getCachedFixedBytes(item).length;

      const custom = customOf(item);
      let raw = data;
      if (custom !== undefined) {
        raw = custom.from(data);
        queue?.entries.push(raw);
      }

      checkItemLength(item, raw.length);
      let size = typeof length === "object" ? prefixEncodedWidth(length, raw.length) : 0;
      for (let i = 0; i < raw.length; ++i)
        size += internalCalcSize(item.layout, raw[i], queue);

      return size;
    }
    case "switch": {
      if (fixedOf(item) !== undefined)
        return getCachedFixedBytes(item).length;

      const custom = customOf(item);
      let raw = data;
      if (custom !== undefined) {
        raw = custom.from(data);
        queue?.entries.push(raw);
      }

      const tagValue = raw[item.tag];
      const variant = findVariantByTagValue(item, tagValue);
      const rawId = rawIdOf(variant, tagValue);
      const idWidth = item.id.binary !== "codec" ? item.id.size : item.id.sizeOf(rawId as number);
      return idWidth + internalCalcSize(variant.layout, raw, queue);
    }
    case "packed":
      return packedByteSize(item);
    case "codec": {
      const fixed = fixedOf(item);
      if (fixed !== undefined)
        return item.sizeOf(fixed);

      const custom = customOf(item);
      let raw = data;
      if (custom !== undefined) {
        raw = custom.from(data);
        queue?.entries.push(raw);
      }

      return item.sizeOf(raw);
    }
  }
}

// ---- static sizing ----

export function calcStaticSize(layout: Layout): number | null {
  if (isItem(layout))
    return calcItemStaticSize(layout);

  let size = 0;
  for (const key of structKeys(layout)) {
    let fieldSize;
    try {
      fieldSize = calcStaticSize(layout[key]!);
    }
    catch (e) {
      throw fieldError(e, "sizing", key);
    }

    if (fieldSize === null)
      return null;

    size += fieldSize;
  }
  return size;
}

//deliberately parallels calcItemSize rather than sharing its body: merging the modes would
//  force number|null (and dead null guards) onto the concrete path, which can never be null
function calcItemStaticSize(item: Item): number | null {
  switch (item.binary) {
    case "int":
    case "uint": {
      if (!("size" in item) || item.size === undefined)
        throw new Error(`num items with bit width are only legal inside packed layouts`);

      return item.size;
    }
    case "bytes": {
      const size = (item as { size?: Count }).size;
      const prefix = typeof size === "object" ? size : undefined;
      const fixed = fixedOf(item);

      //fixed: the content is a constant - its size is static regardless of any custom
      if (fixed !== undefined) {
        const contentSize = getCachedFixedBytes(item).length;
        return (prefix !== undefined ? prefixEncodedWidth(prefix, contentSize) : 0) + contentSize;
      }

      if (typeof size === "number")
        return size;

      const contentSize = itemHasLayout(item) ? calcStaticSize(item.layout) : null;
      if (contentSize === null)
        return null;

      return (prefix !== undefined ? prefixEncodedWidth(prefix, contentSize) : 0)
        + contentSize;
    }
    case "array": {
      const { length } = item;
      const fixed = fixedOf(item);

      //fixed: the content is a constant - its size is static regardless of any custom
      if (fixed !== undefined)
        return (typeof length === "object" ? prefixEncodedWidth(length, fixed.length) : 0)
          + getCachedFixedBytes(item).length;

      if (typeof length === "number") {
        if (length === 0)
          return 0;

        const elementSize = calcStaticSize(item.layout);
        return elementSize !== null ? length * elementSize : null;
      }
      return null;
    }
    case "switch": {
      if (fixedOf(item) !== undefined)
        return getCachedFixedBytes(item).length;

      //static only if the id width and every variant's size are static and all totals agree
      let size: number | null = null;
      for (const variant of item.variants) {
        const idWidth = item.id.binary !== "codec"
          ? item.id.size
          : isRangeId(variant.id)
          ? codecStaticSize(item.id)
          : item.id.sizeOf(variant.id as number);
        if (idWidth === null)
          return null;

        const layoutSize = calcStaticSize(variant.layout);
        if (layoutSize === null)
          return null;

        const total = idWidth + layoutSize;
        if (size === null)
          size = total;
        else if (size !== total)
          return null;
      }
      return size;
    }
    case "packed":
      return packedByteSize(item);
    case "codec": {
      const fixed = fixedOf(item);
      if (fixed !== undefined)
        return item.sizeOf(fixed);

      return codecStaticSize(item);
    }
  }
}

//a codec states a static size by bounding its encoding from both sides at one width
const codecStaticSize = (codec: CodecItem): number | null =>
  codec.minSize !== undefined && codec.minSize === codec.maxSize ? codec.minSize : null;

// ---- prefix items ----

//a prefix is an ordinary item whose derived value is the count, so its encoded width is
//  just its size for that value
function prefixEncodedWidth(prefix: PrefixItem, count: number): number {
  return internalCalcSize(prefix as Layout, count);
}

// ---- packed bit sizes ----

//inside a packed word a size-less bytes item with a layout is what it is everywhere else: that
//  layout's struct with an item's properties around it - the item form withCustom,
//  spreadLayout, unwrapSingleton and pin give a struct. So, like the struct, it is a group of
//  the word's bits with its fixed/custom on top; only a stated size makes a bytes item
//  standalone content (a prefix size is one itemBitSize rejects)
export const isBitGroup = (item: Item): item is BytesItem & { layout: Layout } =>
  item.binary === "bytes" && item.size === undefined && itemHasLayout(item);

//layouts are stable while in use, so a node's width is computed once per node rather than on
//  every size pass, pack and unpack
const bitSizeCache = new WeakMap<Layout, number>();

//the bit width an item occupies inside a packed layout - everything inside packed must be
//  statically sized, enforced by construction (throws on dynamic constructs)
export function itemBitSize(layout: Layout): number {
  let bits = bitSizeCache.get(layout);
  if (bits === undefined) {
    bits = _itemBitSize(layout);
    bitSizeCache.set(layout, bits);
  }
  return bits;
}

function _itemBitSize(layout: Layout): number {
  if (!isItem(layout)) {
    let bits = 0;
    for (const key of structKeys(layout))
      bits += itemBitSize(layout[key]!);

    return bits;
  }

  const item = layout as Item;
  switch (item.binary) {
    case "int":
    case "uint": {
      if ("bits" in item && item.bits !== undefined)
        return item.bits;

      //byte-sized fields are bit-ranges of the packed word, so byte order does not apply
      if ("endianness" in item && item.endianness !== undefined)
        throw new Error(`num items inside packed layouts must not specify endianness`);

      return bitsPerByte * (item as { size: number }).size;
    }
    case "bytes": {
      if (isBitGroup(item))
        return itemBitSize(item.layout);

      const size = item.size;
      if (typeof size === "number")
        return bitsPerByte * size;

      //fixed: the content is a constant - its size is static
      if (size === undefined && fixedOf(item) !== undefined)
        return bitsPerByte * getCachedFixedBytes(item).length;

      throw new Error(`bytes items inside packed layouts must have a static size`);
    }
    case "array": {
      const { length } = item;
      if (typeof length === "number")
        return length * itemBitSize(item.layout);

      //fixed: the sequence is a constant - its length is static
      const fixed = fixedOf(item);
      if (length === undefined && fixed !== undefined)
        return (fixed as RoArray<unknown>).length * itemBitSize(item.layout);

      throw new Error(`arrays inside packed layouts must have a fixed length`);
    }
    case "packed":
      return laneBitSize(item);
    case "switch":
    case "codec":
      throw new Error(`${item.binary} items cannot appear inside packed layouts`);
  }
}

//the width-carrying face of a packed item - what the helpers below read of it
export type PackedWord =
  Pick<SizedPackedItem, "layout" | "size" | "endianness" | "bitOrder"> & Opts<{ bits: number }>;

//a lane that speaks of whole bytes - by claiming a byte order, which only whole bytes have, or
//  by stating its width in them. It renders through that byte order and owes the byte alignment
//  a wire-facing word owes; every other lane is a raw bit range of the word around it
export const isByteLane = (item: PackedWord): boolean =>
  item.size !== undefined || item.endianness !== undefined;

//the bits a packed item occupies as a lane of an enclosing word: a byte lane's are its bytes,
//  a bit range's are its stated width or, absent one, exactly its content - byte alignment is
//  an obligation of the wire, which a bit range does not face
export function laneBitSize(item: PackedWord): number {
  if (item.bits !== undefined && isByteLane(item))
    throw new Error(`a packed lane's bit width admits no size or endianness beside it - ` +
                    `both speak of whole bytes`);

  if (isByteLane(item))
    return bitsPerByte * packedByteSize(item);

  const bits = itemBitSize(item.layout);
  if (item.bits === undefined)
    return bits;

  if (item.bits < bits)
    throw new Error(`packed bit width of ${item.bits} is too small, layout has ${bits} bits`);

  return item.bits;
}

export function packedByteSize(item: PackedWord): number {
  if (item.bits !== undefined)
    throw new Error(`packed items with a bit width are only legal inside packed layouts`);

  const bits = itemBitSize(item.layout);
  if (item.size !== undefined) {
    if (bitsPerByte * item.size < bits)
      throw new Error(`packed size of ${item.size} is too small, layout has ${bits} bits`);

    return item.size;
  }

  if (bits % bitsPerByte !== 0)
    throw new Error(`packed layout bit size ${bits} is not byte-aligned - a wire-facing word ` +
      `must declare an explicit size to admit bit-granular slack`);

  return bits / bitsPerByte;
}
