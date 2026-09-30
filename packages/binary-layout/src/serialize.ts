import type { RoUint8Array, RoArray, OptionalArg } from "@onrail-xyz/utils";
import { bignum } from "@onrail-xyz/utils";
import type { Layout, Item, PackedItem, DeriveType,
              Endianness, BitOrder, PrefixItem, Count } from "./layout.js";
import { bitsPerByte, defaultBitOrder } from "./layout.js";
import type { SerializationQueue } from "./size.js";
import { calcSizeForSerialization, internalCalcSize, itemBitSize,
         packedByteSize, laneBitSize, isByteLane, isBitGroup, type PackedWord } from "./size.js";
import type { Cursor } from "./numbers.js";
import { checkFitsInBits, serializeNum, byteSwap } from "./numbers.js";
import { isItem, structKeys, hasFixed, customOf, fixedOf,
         endiannessOf, fieldDataOf, isOmitted, itemHasLayout,
         checkItemSize, checkItemLength, fixedContentLayout,
         findVariantByTagValue, rawIdOf, fieldError, numBitWidth } from "./utils.js";

const queuePop = (queue: SerializationQueue): any => queue.entries[queue.position++];

const cursorWrite = (cursor: Cursor, content: RoUint8Array) => {
  cursor.bytes.set(content, cursor.offset);
  cursor.offset += content.length;
};

export type SerializeReturn<E extends Uint8Array | undefined> =
  E extends undefined ? Uint8Array : number;

export function serialize<
  const L extends Layout,
        E extends Uint8Array | undefined = undefined,
>(layout: L, data: DeriveType<L>, ...[encoded]: OptionalArg<E>): SerializeReturn<E> {
  const [size, queue] = calcSizeForSerialization(layout, data);
  if (encoded !== undefined && encoded.length < size)
    throw new Error(`provided buffer is too small: ${encoded.length} < required ${size}`);

  const cursor = { bytes: encoded ?? new Uint8Array(size), offset: 0 };
  internalSerialize(layout, data, cursor, queue);
  return (encoded ? cursor.offset : cursor.bytes) as SerializeReturn<E>;
}

// ---- fixed bytes cache ----

//caches the wire bytes of an item's `fixed` value so (de)serialization and discrimination
//  don't re-derive them on every call. The cache holds the item's *content*: a size/length
//  prefix stays with the generic prefix path around it. Held in a WeakMap keyed by the item
//  rather than written onto it: the layout spec is a user-owned, possibly-frozen object and
//  mutating it would be a surprising side effect; the weak keys let entries be collected along
//  with the layout.
const fixedBytesCache = new WeakMap<object, RoUint8Array>();

//callers must only invoke this for items with `fixed`
export function getCachedFixedBytes(item: Item): RoUint8Array {
  let cached = fixedBytesCache.get(item);
  if (cached === undefined) {
    const fixed = fixedOf(item);
    switch (item.binary) {
      case "int":
      case "uint": {
        const { size, endianness } = item as { size: number, endianness?: Endianness };
        const cursor = { bytes: new Uint8Array(size), offset: 0 };
        serializeNum(fixed, size, cursor, endianness, item.binary === "int");
        cached = cursor.bytes;
        break;
      }
      case "bytes": {
        cached = itemHasLayout(item)
          ? serialize(item.layout, fixed)
          : fixed as RoUint8Array;
        checkItemSize(item, cached.length);
        break;
      }
      case "packed": {
        const size = packedByteSize(item);
        const cursor = { bytes: new Uint8Array(size), offset: 0 };
        serializeNum(packWord(item, fixed, bitsPerByte * size), size, cursor, endiannessOf(item));
        cached = cursor.bytes;
        break;
      }
      case "codec": {
        const bytes = new Uint8Array(item.sizeOf(fixed));
        cached = bytes.subarray(0, item.write(fixed, bytes, 0));
        break;
      }
      case "array":
        checkItemLength(item, (fixed as RoArray<unknown>).length);
        //fallthrough - the content renders under the item's own rules minus the pinning
      case "switch":
        cached = serialize(fixedContentLayout(item), fixed);
        break;
    }
    fixedBytesCache.set(item, cached);
  }
  return cached;
}

// ---- bit packing ----

const resolveRaw = (item: Item, data: any): any => {
  if (hasFixed(item))
    return fixedOf(item);

  const custom = customOf(item);
  return custom !== undefined ? custom.from(data) : data;
};

function packWord(item: PackedWord, raw: any, totalBits: number): bigint {
  const bitOrder = item.bitOrder ?? defaultBitOrder;
  const [word] = packFields(item.layout, raw, bitOrder);
  const slack = totalBits - itemBitSize(item.layout);
  return bitOrder === "lsbFirst" ? word : word << BigInt(slack);
}

//the wire bits a fixed lane occupies: a byte lane renders through its own byte order, a bit
//  range has none and is its word
export const laneFixedWord = (item: PackedItem): bigint =>
  isByteLane(item)
  ? bignum.fromBytes(getCachedFixedBytes(item), true)
  : packWord(item, fixedOf(item), laneBitSize(item));

//the wire bits an item's `fixed` value occupies inside a word, packed exactly as
//  serialization packs it
export const packedFixedBits = (item: Item, bitOrder: BitOrder): bigint =>
  packFields(item, undefined, bitOrder)[0];

function packFields(layout: Layout, data: any, bitOrder: BitOrder): [bigint, number] {
  if (!isItem(layout)) {
    let acc = 0n;
    let bits = 0;
    for (const key of structKeys(layout)) {
      const field = layout[key]!;
      const [fieldAcc, fieldBits] = packFields(field, fieldDataOf(field, data, key), bitOrder);
      acc = bitOrder === "lsbFirst"
        ? acc | (fieldAcc << BigInt(bits))
        : (acc << BigInt(fieldBits)) | fieldAcc;
      bits += fieldBits;
    }
    return [acc, bits];
  }

  const item = layout as Item;
  switch (item.binary) {
    case "int":
    case "uint": {
      const bits = numBitWidth(item);
      const raw = BigInt(resolveRaw(item, data));
      checkFitsInBits(raw, bits, item.binary === "int");
      return [BigInt.asUintN(bits, raw), bits]; //two's complement
    }
    case "array": {
      const raw = resolveRaw(item, data);
      //the length is a plain number here - itemBitSize rejects prefixed lengths inside packed
      checkItemLength(item, raw.length);

      let acc = 0n;
      let bits = 0;
      for (let i = 0; i < raw.length; ++i) {
        const [elemAcc, elemBits] = packFields(item.layout, raw[i], bitOrder);
        acc = bitOrder === "lsbFirst"
          ? acc | (elemAcc << BigInt(bits))
          : (acc << BigInt(elemBits)) | elemAcc;
        bits += elemBits;
      }
      return [acc, bits];
    }
    case "packed": {
      const bits = laneBitSize(item);
      if (hasFixed(item))
        return [laneFixedWord(item), bits];

      const word = packWord(item, resolveRaw(item, data), bits);
      //laneBitSize has already rejected an endianness on a bit range
      return [endiannessOf(item) === "little" ? byteSwap(word, bits / bitsPerByte) : word, bits];
    }
    case "bytes": {
      if (isBitGroup(item))
        return packFields(item.layout, resolveRaw(item, data), bitOrder);

      const bits = itemBitSize(item);
      const cursor = { bytes: new Uint8Array(bits / bitsPerByte), offset: 0 };
      serializeItem(item, data, cursor, undefined);
      return [bignum.fromBytes(cursor.bytes, true), bits];
    }
    case "switch":
    case "codec":
      throw new Error(`${item.binary} items cannot appear inside packed layouts`);
  }
}

// ---- serialization ----

function writePrefix(prefix: PrefixItem, count: number, cursor: Cursor) {
  serializeItem(prefix as Item, count, cursor, undefined);
}

export function internalSerialize(
  layout: Layout,
  data:   any,
  cursor: Cursor,
  queue:  SerializationQueue | undefined,
): void {
  if (isItem(layout))
    return serializeItem(layout, data, cursor, queue);

  for (const key of structKeys(layout))
    try {
      const field = layout[key]!;
      //no fieldDataOf: the size pass already verified presence on this same data
      const fieldData = isItem(field) && isOmitted(field) ? undefined : data[key];
      internalSerialize(field, fieldData, cursor, queue);
    }
    catch (e) {
      throw fieldError(e, "serializing", key);
    }
}

function serializeItem(
  item:   Item,
  data:   any,
  cursor: Cursor,
  queue:  SerializationQueue | undefined,
) {
  switch (item.binary) {
    case "int":
    case "uint": {
      if (!("size" in item) || item.size === undefined)
        throw new Error(`num items with bit width are only legal inside packed layouts`);

      const raw = resolveRaw(item, data);
      serializeNum(raw, item.size, cursor, item.endianness, item.binary === "int");
      break;
    }
    case "bytes": {
      const size = (item as { size?: Count }).size;
      const prefix = typeof size === "object" ? size : undefined;
      const custom = customOf(item);

      if (hasFixed(item)) {
        const content = getCachedFixedBytes(item);
        if (prefix !== undefined)
          writePrefix(prefix, content.length, cursor);

        cursorWrite(cursor, content);
        break;
      }

      const raw = custom !== undefined
        ? (queue !== undefined ? queuePop(queue) : custom.from(data))
        : data;

      if (prefix !== undefined) {
        const payloadSize = queue !== undefined
          ? queuePop(queue)
          : itemHasLayout(item) ? internalCalcSize(item.layout, raw) : raw.length;
        writePrefix(prefix, payloadSize, cursor);
      }

      const start = cursor.offset;
      if (itemHasLayout(item))
        internalSerialize(item.layout, raw, cursor, queue);
      else
        cursorWrite(cursor, raw);

      checkItemSize(item, cursor.offset - start);
      break;
    }
    case "array": {
      const { length } = item;
      if (hasFixed(item)) {
        if (typeof length === "object")
          writePrefix(length, (fixedOf(item) as RoArray<unknown>).length, cursor);

        cursorWrite(cursor, getCachedFixedBytes(item));
        break;
      }

      const custom = customOf(item);
      const raw = custom !== undefined
        ? (queue !== undefined ? queuePop(queue) : custom.from(data))
        : data;

      checkItemLength(item, raw.length);
      if (typeof length === "object")
        writePrefix(length, raw.length, cursor);

      for (let i = 0; i < raw.length; ++i)
        internalSerialize(item.layout, raw[i], cursor, queue);

      break;
    }
    case "switch": {
      if (hasFixed(item)) {
        cursorWrite(cursor, getCachedFixedBytes(item));
        break;
      }

      const custom = customOf(item);
      const raw = custom !== undefined
        ? (queue !== undefined ? queuePop(queue) : custom.from(data))
        : data;

      const tagValue = raw[item.tag];
      const variant = findVariantByTagValue(item, tagValue);
      const rawId = rawIdOf(variant, tagValue);
      if (item.id.binary !== "codec")
        serializeNum(rawId, item.id.size, cursor, item.id.endianness, item.id.binary === "int");
      else
        cursor.offset = item.id.write(rawId as number, cursor.bytes, cursor.offset);

      internalSerialize(variant.layout, raw, cursor, queue);
      break;
    }
    case "packed": {
      if (hasFixed(item)) {
        cursorWrite(cursor, getCachedFixedBytes(item));
        break;
      }

      const raw = resolveRaw(item, data);
      const size = packedByteSize(item);
      serializeNum(packWord(item, raw, bitsPerByte * size), size, cursor, endiannessOf(item));
      break;
    }
    case "codec": {
      if (hasFixed(item)) {
        cursorWrite(cursor, getCachedFixedBytes(item));
        break;
      }

      const custom = customOf(item);
      const raw = custom !== undefined
        ? (queue !== undefined ? queuePop(queue) : custom.from(data))
        : data;

      cursor.offset = item.write(raw, cursor.bytes, cursor.offset);
      break;
    }
  }
}
