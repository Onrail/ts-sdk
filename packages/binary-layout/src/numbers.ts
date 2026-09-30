import type { RoUint8Array, RoPair } from "@onrail-xyz/utils";
import { range } from "@onrail-xyz/utils";
import type { Endianness, NumType, NumberBits, NumSizeToPrimitive } from "./layout.js";
import { defaultEndianness, numberMaxSize, numberMaxBits, bitsPerByte } from "./layout.js";
import { byteMulShift } from "./utils.js";

//engine-internal write position (codecs get the functional (raw, bytes, offset) => offset
//  contract instead, keeping this type off the public surface)
export type Cursor = {
  bytes:  Uint8Array,
  offset: number,
};

//emits the low count bytes of val in ascending significance, starting at base and walking by step
const uintToBytes = (
  bytes: Uint8Array,
  base:  number,
  step:  number,
  count: number,
  val:   number,
) => {
  for (let i = 0; i < count; ++i) {
    bytes[base + i * step] = val % byteMulShift;
    val = Math.floor(val / byteMulShift);
  }
};

//number-path exponents are bounded by NumberBits, the bigint path never exponentiates. `2 ** exp`
//  with a runtime exponent is a libm call, so the widths are tabulated
const pow2 = range(numberMaxBits + 1).map(exp => 2 ** exp);
const twoTo = (exp: number): number => pow2[exp]!;

//a number is checked only against widths that derive number (NumBitsToPrimitive's rule): past
//  numberMaxBits it cannot hold every integer of the range, so `isInteger` would pass values the
//  caller never meant - the signature refuses the question. A bigint is checked against any width
const _fitsInBits = (val: NumType, bits: number, signed: boolean): boolean => {
  if (typeof val === "bigint")
    return (signed ? BigInt.asIntN : BigInt.asUintN)(bits, val) === val;

  const bound = twoTo(bits - (signed ? 1 : 0));
  return Number.isInteger(val) && (signed ? -bound : 0) <= val && val < bound;
};

//overloads as a call-signature type over one implementation rather than `function` overloads:
//  an overloaded function's implementation signature is invisible even to itself, so
//  checkFitsInBits could only reach the untyped path through a cast
export const fitsInBits: {
  (val: number, bits: NumberBits, signed: boolean): boolean,
  (val: bigint, bits: number,     signed: boolean): boolean,
} = _fitsInBits;

//the guard form, naming the width the way an integer type is named
export const checkFitsInBits: {
  (val: number, bits: NumberBits, signed: boolean, subject?: string): void,
  (val: bigint, bits: number,     signed: boolean, subject?: string): void,
} = (val: NumType, bits: number, signed: boolean, subject: string = "Value"): void => {
  if (!_fitsInBits(val, bits, signed))
    throw new Error(`${subject} ${val} does not fit in ${signed ? "i" : "u"}${bits}`);
};

export function serializeNum(
  val:        NumType,
  size:       number,
  cursor:     Cursor,
  endianness: Endianness = defaultEndianness,
  signed:     boolean = false,
): void {
  const bits = bitsPerByte * size;

  //bytes are emitted in ascending significance, so big endian walks the cursor backwards
  const bigEndian = endianness === "big";
  const base = cursor.offset + (bigEndian ? size - 1 : 0);
  const step = bigEndian ? -1 : 1;

  if (typeof val === "number") {
    //NumSizeToPrimitive's rule, which the layout surface derives and readNum returns: past
    //  numberMaxSize a field's domain is bigint, because number stops representing every integer
    if (size > numberMaxSize)
      throw new Error(`a ${size}-byte field holds a bigint, got the number ${val}`);

    checkFitsInBits(val, bits as NumberBits, signed); //size <= numberMaxSize bounds bits
    uintToBytes(cursor.bytes, base, step, size, val < 0 ? val + twoTo(bits) : val);
  }
  else {
    checkFitsInBits(val, bits, signed);
    //two's complement, then emit numberMaxSize bytes worth of chunks at a time
    let rem = BigInt.asUintN(bits, val);
    for (let i = 0; i < size;) {
      const chunkSize = Math.min(numberMaxSize, size - i);
      const chunk = Number(BigInt.asUintN(bitsPerByte * chunkSize, rem));
      uintToBytes(cursor.bytes, base + i * step, step, chunkSize, chunk);
      rem >>= BigInt(bitsPerByte * chunkSize);
      i += chunkSize;
    }
  }

  cursor.offset += size;
}

export type BytesChunk = {
  bytes:  RoUint8Array,
  offset: number,
  end:    number,
};

export function updateOffset(encoded: BytesChunk, size: number): void {
  const newOffset = encoded.offset + size;
  if (newOffset > encoded.end)
    throw new Error(`chunk is shorter than expected: ${encoded.end} < ${newOffset}`);

  encoded.offset = newOffset;
}

//accumulates count bytes in descending significance, starting at base and walking by step.
//  count must not exceed numberMaxSize so that the result stays a safe integer
const uintFromBytes = (bytes: RoUint8Array, base: number, step: number, count: number) => {
  let val = 0;
  for (let i = 0; i < count; ++i)
    val = val * byteMulShift + bytes[base + i * step]!;

  return val;
};

export function deserializeNum<S extends number>(
  encoded:    BytesChunk,
  size:       S,
  endianness: Endianness = defaultEndianness,
  signed:     boolean    = false,
): NumSizeToPrimitive<S> {
  const offset = encoded.offset; //store offset and advance early for correct error
  updateOffset(encoded, size);

  const { bytes } = encoded;
  const bigEndian = endianness === "big";
  const bits = bitsPerByte * size;
  //bytes are consumed in descending significance, so little endian walks the field backwards
  const base = offset + (bigEndian ? 0 : size - 1);
  const step = bigEndian ? 1 : -1;

  if (size <= numberMaxSize) {
    const val = uintFromBytes(bytes, base, step, size);
    //the bytes are read as unsigned, so a set sign bit shows up as the upper half of the range
    return (signed && val >= twoTo(bits - 1) ? val - twoTo(bits) : val) as NumSizeToPrimitive<S>;
  }

  //accumulate numberMaxSize bytes at a time so the bigint ops are amortized over whole chunks
  let val = 0n;
  for (let i = 0; i < size;) {
    const chunkSize = Math.min(numberMaxSize, size - i);
    const chunk = BigInt(uintFromBytes(bytes, base + i * step, step, chunkSize));
    val = (val << BigInt(bitsPerByte * chunkSize)) | chunk;
    i += chunkSize;
  }

  return (signed ? BigInt.asIntN(bits, val) : val) as NumSizeToPrimitive<S>;
}

//a typed array drops out-of-range writes and reads them back as undefined, so the position a
//  codec hands in is checked before the engine touches the buffer
const checkWithinBuffer = (bytes: RoUint8Array, offset: number, size: number): void => {
  if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length)
    throw new Error(
      `bytes [${offset}, ${offset + size}) lie outside the buffer of length ${bytes.length}`
    );
};

//the engine's integer handling in the shape a codec's read/write use, so a hand-written
//  codec gets bounds checks and chunked bigint accumulation instead of re-deriving them
//  (checkFitsInBits is the range check on its own) - the cursor types stay internal
export const readNum = <S extends number>(
  bytes:      RoUint8Array,
  offset:     number,
  size:       S,
  endianness: Endianness = defaultEndianness,
  signed:     boolean    = false,
): RoPair<NumSizeToPrimitive<S>, number> => {
  checkWithinBuffer(bytes, offset, size);
  const encoded = { bytes, offset, end: bytes.length };
  const value = deserializeNum(encoded, size, endianness, signed);
  return [value, encoded.offset];
};

export const writeNum = <S extends number>(
  val:        NumSizeToPrimitive<S>,
  bytes:      Uint8Array,
  offset:     number,
  size:       S,
  endianness: Endianness = defaultEndianness,
  signed:     boolean    = false,
): number => {
  checkWithinBuffer(bytes, offset, size);
  const cursor = { bytes, offset };
  serializeNum(val, size, cursor, endianness, signed);
  return cursor.offset;
};

//reverses the byte order of a size-byte word - a little-endian word read as big-endian
export const byteSwap = (word: bigint, size: number): bigint => {
  let swapped = 0n;
  for (let i = 0; i < size; ++i) {
    swapped = (swapped << 8n) | (word & 0xffn);
    word >>= 8n;
  }
  return swapped;
};
