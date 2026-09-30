import { hex, bignum } from "../src/encoding.js";

const arr = new Uint8Array([0xde, 0xad]);
const unknownFlag = arr.length > 1;

const prefixedHex:   `0x${string}` = hex.encode(arr, true);
const bareHex:       string        = hex.encode(arr);
const explicitBare:  string        = hex.encode(arr, false);
const unknownIsBare: string        = hex.encode(arr, unknownFlag);

const prefixedNum:   `0x${string}` = bignum.toHex(1n, true);
const bareNum:       string        = bignum.toHex(1n);

//@ts-expect-error the unprefixed spellings are not 0x strings
const notPrefixed: `0x${string}` = hex.encode(arr);
//@ts-expect-error nor is an unknown flag enough to promise one
const norUnknown: `0x${string}` = bignum.toHex(1n, unknownFlag);

export type _Pins = [
  typeof prefixedHex, typeof bareHex, typeof explicitBare, typeof unknownIsBare,
  typeof prefixedNum, typeof bareNum, typeof notPrefixed, typeof norUnknown,
];
