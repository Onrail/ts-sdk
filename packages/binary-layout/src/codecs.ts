import type { RoUint8Array, RoPair, Opts } from "@onrail-xyz/utils";
import { bignum } from "@onrail-xyz/utils";
import type { CodecItem, Conversion, NumBitsToPrimitive } from "./layout.js";
import { numberMaxSize } from "./layout.js";
import { numBitsToPrimitive, byteMulShift, isNumberSize } from "./utils.js";
import { codecItem } from "./items.js";
import { checkFitsInBits, readNum, writeNum } from "./numbers.js";

const readByte = (bytes: RoUint8Array, offset: number): number => {
  const byte = bytes[offset];
  if (byte === undefined)
    throw new Error(`unexpected end of data at offset ${offset}`);

  return byte;
};

// ---- base-128 varints ----
//7 value bits per byte, least significant group first; a set msb means "more bytes follow".
//Deserialization is strict on both axes: values must fit maxBits, and encodings must be
//  minimal (no trailing zero group), keeping decode injective - Solana's validator rejects
//  such "aliased" compact-u16s just the same. `permissive` waives minimality alone - WASM
//  allows trailing zeros within the same ⌈maxBits/7⌉ byte cap - at the price of injectivity;
//  the value bound always holds, and serialization always emits minimally.

const bitsPerGroup = 7;
const groupShift = BigInt(bitsPerGroup);

export const leb128Codec = <B extends number>(
  maxBits: B,
  opts?:   Opts<{ permissive: boolean }>,
): CodecItem<NumBitsToPrimitive<B>> => {
  const maxSize = Math.ceil(maxBits / bitsPerGroup);
  const asT = (value: bigint) => numBitsToPrimitive(value, maxBits);

  return codecItem({
    read: (bytes, offset) => {
      let value = 0n;
      for (let i = 0; ; ++i) {
        if (i >= maxSize)
          throw new Error(`varint exceeds ${maxSize} bytes`);

        const byte = readByte(bytes, offset + i);
        value |= BigInt(byte & 0x7f) << BigInt(bitsPerGroup * i);
        if ((byte & 0x80) === 0) {
          if (byte === 0 && i > 0 && !opts?.permissive)
            throw new Error(`non-minimal varint: trailing zero group`);

          checkFitsInBits(value, maxBits, false, "varint value");

          return [asT(value), offset + i + 1];
        }
      }
    },
    write: (raw, bytes, offset) => {
      let rem = BigInt(raw);
      checkFitsInBits(rem, maxBits, false, "varint value");

      do {
        const byte = Number(rem & 0x7fn);
        rem >>= groupShift;
        bytes[offset++] = rem > 0n ? byte | 0x80 : byte;
      } while (rem > 0n);
      return offset;
    },
    sizeOf: raw => {
      let size = 1;
      for (let rem = BigInt(raw) >> groupShift; rem > 0n; rem >>= groupShift)
        ++size;

      return size;
    },
  }, { minSize: 1, maxSize });
};

//unsigned LEB128, up to u64 (zigzag for signed values is a conversion on top)
export const leb128 = leb128Codec(64);
//Solana's compact-u16
export const compactU16 = leb128Codec(16);

// ---- RLP ----
//One length-header scheme covers strings (base 0x80) and lists (base 0xc0): tags
//  base .. base+55 encode the length directly ("short form"); tag base+55+w announces
//  the length as w minimal big-endian bytes ("long form" - canonical only for
//  lengths > 55).

const rlpStringBase = 0x80;
const rlpListBase = 0xc0;
const shortFormMax = 55;

//RLP allows long-form widths up to 8, but a length that needs more than numberMaxSize bytes
//  is beyond any sane payload - and beyond Number precision, which is what caps it here
const rlpMaxWidth = numberMaxSize;

//byte width of a length's minimal big-endian encoding
const beWidth = (value: number): number => {
  let width = 0;
  for (let rem = value; rem > 0; rem = Math.floor(rem / byteMulShift))
    ++width;

  return width;
};

const readRlpLength = (
  bytes:  RoUint8Array,
  offset: number, //of the tag byte, which the caller has checked to be >= base
  base:   number,
): [length: number, next: number] => {
  const tag = readByte(bytes, offset) - base;
  if (tag <= shortFormMax)
    return [tag, offset + 1];

  const width = tag - shortFormMax;
  if (!isNumberSize(width))
    throw new Error(`RLP length of length ${width} exceeds sane bounds`);

  const start = offset + 1;
  const [length, next] = readNum(bytes, start, width, "big");
  if (bytes[start] === 0)
    throw new Error(`RLP length has leading zero bytes`);

  if (length <= shortFormMax)
    throw new Error(`non-canonical RLP: long form for length ${length}`);

  return [length, next];
};

const writeRlpLength = (
  length: number,
  base:   number,
  bytes:  Uint8Array,
  offset: number
): number => {
  if (length <= shortFormMax) {
    bytes[offset] = base + length;
    return offset + 1;
  }

  const width = beWidth(length);
  if (!isNumberSize(width))
    throw new Error(`RLP length ${length} exceeds sane bounds`);

  bytes[offset] = base + shortFormMax + width;
  return writeNum(length, bytes, offset + 1, width, "big");
};

const rlpLengthSize = (length: number): number =>
  length <= shortFormMax ? 1 : 1 + beWidth(length);

//RLP list header: a pure size prefix - unlike RLP strings, list headers never fuse with
//  their payload
export const rlpListHeader = codecItem({
  read: (bytes, offset) => {
    const first = readByte(bytes, offset);
    if (first < rlpListBase)
      throw new Error(`not an RLP list header: 0x${first.toString(16)}`);

    return readRlpLength(bytes, offset, rlpListBase);
  },
  write: (raw, bytes, offset) => writeRlpLength(raw, rlpListBase, bytes, offset),
  sizeOf: rlpLengthSize,
}, { minSize: 1, maxSize: 1 + rlpMaxWidth });

//RLP string (byte string) item. RLP's one wart lives entirely in here: single bytes below
//  0x80 self-encode, fusing header and payload, which is why this is a whole-item codec
//  rather than a size prefix.
export const rlpBytes = codecItem({
  read: (bytes, offset): RoPair<RoUint8Array, number> => {
    const first = readByte(bytes, offset);
    if (first < rlpStringBase)
      return [new Uint8Array([first]), offset + 1];

    if (first >= rlpListBase)
      throw new Error(`not an RLP string: 0x${first.toString(16)}`);

    const [length, payloadStart] = readRlpLength(bytes, offset, rlpStringBase);
    const payload = bytes.subarray(payloadStart, payloadStart + length);
    if (payload.length !== length)
      throw new Error(`unexpected end of data in RLP string`);

    if (length === 1 && payload[0]! < rlpStringBase)
      throw new Error(`non-canonical RLP string: single byte 0x${payload[0]!.toString(16)} ` +
        `must self-encode`);

    return [payload, payloadStart + length];
  },
  write: (raw, bytes, offset) => {
    if (raw.length === 1 && raw[0]! < rlpStringBase) {
      bytes[offset] = raw[0]!;
      return offset + 1;
    }

    offset = writeRlpLength(raw.length, rlpStringBase, bytes, offset);
    bytes.set(raw, offset);
    return offset + raw.length;
  },
  sizeOf: raw =>
    raw.length === 1 && raw[0]! < rlpStringBase
    ? 1
    : rlpLengthSize(raw.length) + raw.length,
}, { minSize: 1 });

//RLP integer: an RLP string holding the minimal big-endian representation
const rlpUintConversion: Conversion<RoUint8Array, bigint> = {
  to: (raw: RoUint8Array): bigint => {
    //also rejects the lone 0x00: a valid RLP string, but zero is the empty string as an integer
    if (raw[0] === 0)
      throw new Error(`non-canonical RLP integer: leading zero bytes`);

    return bignum.fromBytes(raw, true);
  },
  from: (value: bigint): RoUint8Array => {
    if (value < 0n)
      throw new Error(`RLP integers are unsigned, got: ${value}`);

    return value === 0n ? new Uint8Array([]) : bignum.toBytes(value);
  },
};

export const rlpUint = { ...rlpBytes, custom: rlpUintConversion } as const;
