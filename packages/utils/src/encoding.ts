import type { RoUint8Array } from "./typing.js";

type MaybePrefixed<P extends boolean> = P extends true ? `0x${string}` : string;

//inputs rejected for their content can be arbitrarily large payloads
const preview = (input: string) =>
  input.length > 32 ? `${input.slice(0, 32)}… (${input.length} chars)` : input;

//hex and base64 ride the Uint8Array base16/base64 builtins, Baseline since 09/2025
//  (Chrome/Edge 140, Firefox 133, Safari 18.2, Node 25) - hence this package's engine floor
const isHexRegex = /^(?:0x)?(?:[0-9a-fA-F]{2})*$/;
export const hex = {
  isValid: (input: string): boolean =>
    isHexRegex.test(input),

  stripPrefix: (input: string): string =>
    input.startsWith("0x") ? input.slice(2) : input,

  decode: (input: string): Uint8Array =>
    Uint8Array.fromHex(hex.stripPrefix(input)),

  encode: <P extends boolean = false>(input: RoUint8Array, prefix?: P): MaybePrefixed<P> => {
    const result = input.toHex();
    return (prefix ? `0x${result}` : result) as MaybePrefixed<P>;
  },
};

//deliberately lenient (malformed input decodes lossily, as U+FFFD) - these are convenience
//  helpers where speed wins; the strict codec is binary-layout's utf8Conversion. Not lossy
//  otherwise, though: a leading U+FEFF is content here, which TextDecoder would strip by default
//  as the byte order mark of a document
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
export const utf8 = {
  decode: (input: RoUint8Array): string =>
    decoder.decode(input as Uint8Array),

  encode: (input: string): Uint8Array =>
    encoder.encode(input),
};

//the last char of a padded final quantum must have its unused low bits zeroed, just like decode
//  (which is strict about it) requires
const isB64Regex =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
export const base64 = {
  isValid: (input: string): boolean => isB64Regex.test(input),

  //fromBase64 skips ASCII whitespace anywhere in the input, payload interior included - that is
  //  the spec's intent, not a bug, so isValid stays the gate that keeps it out
  decode: (input: string): Uint8Array => {
    if (!base64.isValid(input))
      throw new Error(`Invalid base64: ${preview(input)}`);

    return Uint8Array.fromBase64(input, { lastChunkHandling: "strict" });
  },

  encode: (input: RoUint8Array): string =>
    input.toBase64(),
};

//BigInt() trims surrounding whitespace, so the digits are checked here rather than left to it
const isHexDigitsRegex = /^(?:0x)?[0-9a-fA-F]*$/;
export const bignum = {
  fromHex: (input: string, emptyIsZero: boolean = false): bigint => {
    if (!isHexDigitsRegex.test(input))
      throw new Error(`Invalid hex: ${preview(input)}`);

    const digits = hex.stripPrefix(input);
    if (digits === "") {
      if (emptyIsZero)
        return 0n;
      else
        throw new Error("Empty input");
    }
    //the 0x is (re)established because BigInt() would otherwise read the string as decimal
    return BigInt("0x" + digits);
  },

  toHex: <P extends boolean = false>(input: bigint, prefix?: P): MaybePrefixed<P> => {
    if (input < 0n)
      throw new Error(`Can't hex encode negative value: ${input}`);

    //byte aligned like hex.encode's output, which is also what toBytes' fromHex/setFromHex require
    let str = input.toString(16);
    if (str.length % 2 === 1)
      str = "0" + str;
    return (prefix ? `0x${str}` : str) as MaybePrefixed<P>;
  },

  //via hex rather than a shift loop: each shift copies the growing bigint, which is quadratic
  fromBytes: (input: RoUint8Array, emptyIsZero: boolean = false): bigint => {
    if (input.length === 0) {
      if (emptyIsZero)
        return 0n;
      else
        throw new Error("Empty input");
    }
    return BigInt("0x" + input.toHex());
  },

  toBytes: (input: bigint | number, length?: number): Uint8Array => {
    if (typeof input === "number")
      input = bignum.fromNumber(input);
    if (input < 0n)
      throw new Error(`Can't convert negative value to bytes: ${input}`);

    const digits = bignum.toHex(input);
    if (length === undefined)
      return Uint8Array.fromHex(digits);

    const size = digits.length / 2;
    if (length < size)
      throw new Error(`Can't fit ${input} into ${length} bytes.`);

    const result = new Uint8Array(length);
    result.subarray(length - size).setFromHex(digits);
    return result;
  },

  fromNumber: (input: number): bigint => {
    if (!Number.isSafeInteger(input))
      throw new Error(`Invalid cast: ${input} out of safe integer range`);

    return BigInt(input);
  },

  toNumber: (input: bigint): number => {
    if (input < BigInt(Number.MIN_SAFE_INTEGER) || BigInt(Number.MAX_SAFE_INTEGER) < input)
      throw new Error(`Invalid cast: ${input} out of safe integer range`);

    return Number(input);
  },
};
