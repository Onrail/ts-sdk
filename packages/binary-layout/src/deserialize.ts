import type { RoUint8Array, RoArray, RoPair, If } from "@onrail-xyz/utils";
import type { Layout, Struct, Item, DeriveType, NumType,
              BitOrder, PrefixItem, CodecItem, SwitchItem } from "./layout.js";
import { bitsPerByte, numberMaxBits, defaultBitOrder } from "./layout.js";
import type { BytesChunk } from "./numbers.js";
import { deserializeNum, updateOffset, byteSwap } from "./numbers.js";
import { calcStaticSize, itemBitSize,
         packedByteSize, laneBitSize, isBitGroup, type PackedWord } from "./size.js";
import { getCachedFixedBytes, laneFixedWord, packedFixedBits } from "./serialize.js";
import { isItem, structKeys, hasFixed, customOf, fixedOf,
         surfaceFixed, endiannessOf, isOmitted, itemHasLayout,
         checkSize, checkLength, checkNumEquals, checkBytesEqual,
         findVariantByRawId, variantTagValue, fieldError, numBitWidth } from "./utils.js";

export type DeserializeReturn<L extends Layout, B extends boolean> =
  If<B, DeriveType<L>, RoPair<DeriveType<L>, number>>;

//overloads rather than `B extends boolean = true`: a contextual return type is an inference site,
//  and the candidate it produces displaces the default - so under an annotation whose branches are
//  themselves unresolved (a generic caller's `DeriveType<L>`), the conditional stays unreduced and
//  both arms survive. The two-argument form naming no B at all leaves nothing to infer.
export function deserialize<const L extends Layout>(
  layout: L,
  bytes:  RoUint8Array,
): DeriveType<L>;
export function deserialize<const L extends Layout, B extends boolean>(
  layout:     L,
  bytes:      RoUint8Array,
  consumeAll: B,
): DeserializeReturn<L, B>;
export function deserialize<const L extends Layout, B extends boolean = true>(
  layout:      L,
  bytes:       RoUint8Array,
  consumeAll?: B,
): DeserializeReturn<L, B> {
  const boolConsumeAll = consumeAll ?? true;
  const encoded = {
    bytes,
    offset: 0,
    end: bytes.length,
  };
  const decoded = internalDeserialize(layout, encoded, 0);

  if (boolConsumeAll && encoded.offset !== encoded.end)
    throw new Error(`encoded data is longer than expected: ${encoded.end} > ${encoded.offset}`);

  return (boolConsumeAll ? decoded : [decoded, encoded.offset]) as DeserializeReturn<L, B>;
}

// --- implementation ---

// ---- tail reservation ----

//bytes spoken for behind the current position, up to the end of the enclosing boundary - what a
//  flex item must leave unconsumed. The sentinels mark positions where a flex has no knowable
//  extent; they throw only when an actual flex reads them, so flex-free layouts never pay
type TailReservation = number | "dynamicTail" | "arrayElement";

const addReservation = (reserved: TailReservation, suffix: number | null): TailReservation =>
  typeof reserved !== "number" ? reserved : suffix === null ? "dynamicTail" : reserved + suffix;

//suffixes[i] = the static byte size of everything after field i within the struct - null once
//  that span contains anything dynamically sized. Cached on the struct's identity like the
//  engine's other per-layout work
const suffixSizesCache = new WeakMap<Struct, RoArray<number | null>>();

function suffixSizesOf(struct: Struct, keys: RoArray<string>): RoArray<number | null> {
  let suffixes = suffixSizesCache.get(struct);
  if (suffixes === undefined) {
    const computed = new Array<number | null>(keys.length);
    let tail: number | null = 0;
    for (let i = keys.length - 1; i >= 0; --i) {
      computed[i] = tail;
      if (tail !== null) {
        const fieldSize = calcStaticSize(struct[keys[i]!]!);
        tail = fieldSize === null ? null : tail + fieldSize;
      }
    }
    suffixes = computed;
    suffixSizesCache.set(struct, suffixes);
  }
  return suffixes;
}

//the end of the region a flex item may consume: its boundary's end minus the reserved tail
function flexContentEnd(encoded: BytesChunk, reserved: TailReservation): number {
  if (typeof reserved !== "number")
    throw new Error(reserved === "dynamicTail"
      ? `flex item's extent is unknowable: the data following it within its boundary is not ` +
        `statically sized`
      : `flex items cannot appear inside array element layouts`);

  const contentEnd = encoded.end - reserved;
  if (contentEnd < encoded.offset)
    throw new Error(`chunk has too few bytes for the ${reserved} byte tail reserved past the ` +
      `flex item: ${encoded.end - encoded.offset} < ${reserved}`);

  return contentEnd;
}

// ---- traversal ----

function internalDeserialize(layout: Layout, encoded: BytesChunk, reserved: TailReservation): any {
  return isItem(layout)
    ? deserializeItem(layout, encoded, reserved)
    : deserializeFields(layout, encoded, reserved, {});
}

//decodes a struct's fields into `decoded`: a fresh object, or the one a switch has already
//  written its tag into
function deserializeFields(
  struct:   Struct,
  encoded:  BytesChunk,
  reserved: TailReservation,
  decoded:  any,
): any {
  const keys = structKeys(struct);
  const suffixes = suffixSizesOf(struct, keys);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i]!;
    try {
      const field = struct[key]!;
      const value = internalDeserialize(field, encoded, addReservation(reserved, suffixes[i]!));
      if (!(isItem(field) && isOmitted(field)))
        decoded[key] = value;
    }
    catch (e) {
      throw fieldError(e, "deserializing", key);
    }
  }

  return decoded;
}

const checkCount = (count: unknown): number => {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new Error(`prefix items must derive a non-negative integer, got: ${count}`);

  return count;
};

//a prefix is an ordinary item deserialized standalone; its derived value is the count
//  (a prefix is never flex, so its reservation is moot)
function readPrefix(prefix: PrefixItem, encoded: BytesChunk): number {
  return checkCount(deserializeItem(prefix as Item, encoded, 0));
}

function readCodec<Raw>(
  item:    Pick<CodecItem<Raw>, "read">,
  encoded: BytesChunk,
): Raw {
  const [raw, newOffset] = item.read(encoded.bytes, encoded.offset);
  if (newOffset < encoded.offset)
    throw new Error(`codec read moved backwards: ${newOffset} < ${encoded.offset}`);

  updateOffset(encoded, newOffset - encoded.offset);
  return raw;
}

//checks the upcoming region against the item's fixed wire bytes and consumes it
function consumeFixed(item: Item, encoded: BytesChunk, expectedSize?: number): void {
  const cached = getCachedFixedBytes(item);
  if (expectedSize !== undefined)
    checkSize(cached.length, expectedSize);

  const start = encoded.offset;
  updateOffset(encoded, cached.length);
  checkBytesEqual(cached, encoded.bytes, start);
}

// ---- packed bit extraction ----

//a field's bits within a word - `offset` counts from where the first field sits: the MSB
//  end under "msbFirst", the LSB end under "lsbFirst"
const takeBits = (
  word:      bigint,
  offset:    number,
  bits:      number,
  totalBits: number,
  bitOrder:  BitOrder
) => BigInt.asUintN(
  bits,
  word >> BigInt(bitOrder === "lsbFirst" ? offset : totalBits - offset - bits)
);

//splits a packed item's logical word (byte order already resolved) into its fields, checking
//  that the slack bits of an explicit oversized width are zero
function unpackWord(item: PackedWord, word: bigint, totalBits: number): any {
  const layoutBits = itemBitSize(item.layout);
  const bitOrder = item.bitOrder ?? defaultBitOrder;
  const slack = totalBits - layoutBits;
  if (slack > 0) {
    const slackBits = bitOrder === "lsbFirst"
      ? word >> BigInt(layoutBits)
      : BigInt.asUintN(slack, word);
    if (slackBits !== 0n)
      throw new Error(`packed slack bits are not zero: 0b${slackBits.toString(2)}`);

    word = bitOrder === "lsbFirst" ? BigInt.asUintN(layoutBits, word) : word >> BigInt(slack);
  }

  const [raw] = unpackFields(item.layout, word, 0, layoutBits, bitOrder);
  return raw;
}

function unpackFields(
  layout:    Layout,
  word:      bigint,
  offset:    number,
  totalBits: number,
  bitOrder:  BitOrder,
): [any, number] {
  if (!isItem(layout)) {
    const decoded: any = {};
    let bits = 0;
    for (const key of structKeys(layout)) {
      const field = layout[key]!;
      const [value, fieldBits] =
        unpackFields(field, word, offset + bits, totalBits, bitOrder);
      if (!(isItem(field) && isOmitted(field)))
        decoded[key] = value;

      bits += fieldBits;
    }
    return [decoded, bits];
  }

  const item = layout;
  switch (item.binary) {
    case "int":
    case "uint": {
      const bits = numBitWidth(item);
      let raw: NumType = takeBits(word, offset, bits, totalBits, bitOrder);
      if (item.binary === "int")
        raw = BigInt.asIntN(bits, raw);

      //match the derived primitive: number up to numberMaxBits, bigint beyond
      if (bits <= numberMaxBits)
        raw = Number(raw);

      return [finishRaw(item, raw), bits];
    }
    case "array": {
      if (hasFixed(item))
        return unpackFixed(item, "array", word, offset, totalBits, bitOrder);

      const length = item.length as number;
      const decoded: any[] = [];
      let bits = 0;
      for (let i = 0; i < length; ++i) {
        const [value, elemBits] =
          unpackFields(item.layout, word, offset + bits, totalBits, bitOrder);
        decoded.push(value);
        bits += elemBits;
      }
      const custom = customOf(item);
      return [custom !== undefined ? custom.to(decoded) : decoded, bits];
    }
    case "packed": {
      const bits = laneBitSize(item);
      const wireBits = takeBits(word, offset, bits, totalBits, bitOrder);
      if (hasFixed(item)) {
        //object-shaped raws can't use the numeric equality shortcut - compare wire bits
        if (wireBits !== laneFixedWord(item))
          throw new Error(`value mismatch: packed lane does not match its fixed value`);

        return [surfaceFixed(item), bits];
      }

      const custom = customOf(item);

      //laneBitSize has already rejected an endianness on a bit range
      const lane =
        endiannessOf(item) === "little" ? byteSwap(wireBits, bits / bitsPerByte) : wireBits;
      const raw = unpackWord(item, lane, bits);
      return [custom !== undefined ? custom.to(raw) : raw, bits];
    }
    case "bytes": {
      if (isBitGroup(item)) {
        if (hasFixed(item))
          return unpackFixed(item, "group", word, offset, totalBits, bitOrder);

        const [raw, bits] = unpackFields(item.layout, word, offset, totalBits, bitOrder);
        const custom = customOf(item);
        return [custom !== undefined ? custom.to(raw) : raw, bits];
      }

      //byte lanes: extract the lane in wire byte order and deserialize standalone
      const bits = itemBitSize(item);
      const size = bits / bitsPerByte;
      const lane = takeBits(word, offset, bits, totalBits, bitOrder);
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; ++i)
        bytes[i] = Number(BigInt.asUintN(
          bitsPerByte,
          lane >> BigInt(bits - bitsPerByte * (i + 1))
        ));

      const chunk = { bytes, offset: 0, end: size };
      const value = deserializeItem(item, chunk, 0);
      if (chunk.offset !== size)
        throw new Error(`packed lane consumed ${chunk.offset} of ${size} bytes`);

      return [value, bits];
    }
    case "switch":
    case "codec":
      throw new Error(`${item.binary} items cannot appear inside packed layouts`);
  }
}

//a fixed aggregate's raw value is no scalar to compare, so its wire bits are compared instead
function unpackFixed(
  item:      Item,
  kind:      string,
  word:      bigint,
  offset:    number,
  totalBits: number,
  bitOrder:  BitOrder,
): [any, number] {
  const bits = itemBitSize(item);
  if (takeBits(word, offset, bits, totalBits, bitOrder) !== packedFixedBits(item, bitOrder))
    throw new Error(`value mismatch: packed ${kind} does not match its fixed value`);

  return [surfaceFixed(item), bits];
}

//applies a num item's fixed check and conversion to its raw value
function finishRaw(item: Item, raw: NumType): any {
  if (hasFixed(item)) {
    checkNumEquals(fixedOf(item), raw);
    return surfaceFixed(item);
  }
  const custom = customOf(item);
  return custom !== undefined ? custom.to(raw) : raw;
}

// ---- deserialization ----

//the variant body lands in the object carrying the tag: a struct body's fields go beside it, a
//  switch body (conversion-free by construction) adds its own tag and body in turn
function deserializeSwitch(
  item:     SwitchItem,
  encoded:  BytesChunk,
  reserved: TailReservation,
  decoded:  any,
): any {
  const rawId: NumType = item.id.binary !== "codec"
    ? deserializeNum(encoded, item.id.size, item.id.endianness, item.id.binary === "int")
    : readCodec(item.id, encoded);

  const variant = findVariantByRawId(item, rawId);
  decoded[item.tag] = variantTagValue(variant, rawId);
  //the tail behind the switch is already reserved by the enclosing struct, and only the taken
  //  branch's own suffixes exist at all - reservation accumulates at runtime
  const body = variant.layout;
  return isItem(body)
    ? deserializeSwitch(body, encoded, reserved, decoded)
    : deserializeFields(body, encoded, reserved, decoded);
}

function deserializeItem(item: Item, encoded: BytesChunk, reserved: TailReservation): any {
  switch (item.binary) {
    case "int":
    case "uint": {
      if (!("size" in item) || item.size === undefined)
        throw new Error(`num items with bit width are only legal inside packed layouts`);

      const value = deserializeNum(encoded, item.size, item.endianness, item.binary === "int");
      return finishRaw(item, value);
    }
    case "bytes": {
      const size = item.size;
      const expectedSize =
        typeof size === "number"
        ? size
        : typeof size === "object"
        ? readPrefix(size, encoded)
        : undefined;

      if (hasFixed(item)) {
        consumeFixed(item, encoded, expectedSize);
        return surfaceFixed(item);
      }

      const custom = customOf(item);
      if (itemHasLayout(item)) {
        let raw;
        if (expectedSize === undefined)
          //a size-less bytes item is no boundary: an inner flex measures against the enclosing
          //  one, so the reservation passes through
          raw = internalDeserialize(item.layout, encoded, reserved);
        else {
          const offset = encoded.offset;
          const subChunk = { ...encoded, end: encoded.offset + expectedSize };
          updateOffset(encoded, expectedSize);
          //a sized bytes item is a boundary: entering one resets the reservation
          raw = internalDeserialize(item.layout, subChunk, 0);
          if (subChunk.offset !== subChunk.end)
            throw new Error(
              `read less data than expected: ${subChunk.offset - offset} < ${expectedSize}`
            );
        }

        return custom !== undefined ? custom.to(raw) : raw;
      }

      const start = encoded.offset;
      const end = expectedSize !== undefined
        ? encoded.offset + expectedSize
        : flexContentEnd(encoded, reserved);
      updateOffset(encoded, end - start);

      const value = encoded.bytes.subarray(start, end);
      return custom !== undefined ? custom.to(value) : value;
    }
    case "array": {
      const { layout, length } = item;
      if (hasFixed(item)) {
        if (typeof length === "object")
          checkLength((fixedOf(item) as RoArray<unknown>).length, readPrefix(length, encoded));

        consumeFixed(item, encoded);
        return surfaceFixed(item);
      }

      const custom = customOf(item);
      const decoded: any[] = [];

      let count: number | null = null;
      let countFromData = false;
      if (typeof length === "number")
        count = length;
      else if (typeof length === "object") {
        count = readPrefix(length, encoded);
        countFromData = true;
      }

      //forward-progress guard: a 0-byte element would hang a boundless array and let a count
      //  prefix drive unbounded allocation. Fixed-length arrays are layout-bounded and exempt
      const guardProgress = countFromData || count === null;
      const deserializeElement = () => {
        const before = encoded.offset;
        //the remaining elements are part of a tail yet not statically sized, so a flex can
        //  never know its extent inside an element layout - poison the reservation
        const element = internalDeserialize(layout, encoded, "arrayElement");
        if (guardProgress && encoded.offset === before)
          throw new Error(`array element consumed 0 bytes; ${
            count === null
            ? "boundless array would not terminate"
            : "refusing an unbounded count-prefixed array"
          }`);

        decoded.push(element);
      };

      if (count !== null)
        for (let i = 0; i < count; ++i)
          deserializeElement();
      else {
        const contentEnd = flexContentEnd(encoded, reserved);
        while (encoded.offset < contentEnd)
          deserializeElement();

        //the reservation moves the bound off the chunk end, so an element crossing it no
        //  longer trips updateOffset - restore that strictness explicitly
        if (encoded.offset > contentEnd)
          throw new Error(`array element overran into the ${encoded.end - contentEnd} byte ` +
            `tail reserved past the flex array`);
      }

      return custom !== undefined ? custom.to(decoded) : decoded;
    }
    case "switch": {
      if (hasFixed(item)) {
        consumeFixed(item, encoded);
        return surfaceFixed(item);
      }

      const decoded = deserializeSwitch(item, encoded, reserved, {});
      const custom = customOf(item);
      return custom !== undefined ? custom.to(decoded) : decoded;
    }
    case "packed": {
      const byteSize = packedByteSize(item);
      if (hasFixed(item)) {
        consumeFixed(item, encoded);
        return surfaceFixed(item);
      }

      const word = BigInt(deserializeNum(encoded, byteSize, endiannessOf(item)));
      const raw = unpackWord(item, word, bitsPerByte * byteSize);
      const custom = customOf(item);
      return custom !== undefined ? custom.to(raw) : raw;
    }
    case "codec": {
      if (hasFixed(item)) {
        consumeFixed(item, encoded);
        return surfaceFixed(item);
      }

      const raw = readCodec(item, encoded);
      const custom = customOf(item);
      return custom !== undefined ? custom.to(raw) : raw;
    }
  }
}
