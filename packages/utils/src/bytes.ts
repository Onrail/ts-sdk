import type { RoUint8Array } from "./typing.js";

export const bytes = {
  equals: (lhs: RoUint8Array, rhs: RoUint8Array): boolean => {
    if (lhs.length !== rhs.length)
      return false;

    for (let i = 0; i < lhs.length; ++i)
      if (lhs[i] !== rhs[i])
        return false;

    return true;
  },

  zpad: (arr: RoUint8Array, length: number, padStart: boolean = true): Uint8Array => {
    if (length === arr.length)
      return new Uint8Array(arr);

    if (length < arr.length)
      throw new Error(`Padded length must be >= input length`);

    const result = new Uint8Array(length);
    result.set(arr, padStart ? length - arr.length : 0);
    return result;
  },

  concat: (...args: RoUint8Array[]): Uint8Array => {
    const length = args.reduce((acc, curr) => acc + curr.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const arg of args) {
      result.set(arg, offset);
      offset += arg.length;
    }
    return result;
  },
};
