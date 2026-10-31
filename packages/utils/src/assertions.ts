import { isUint8Array } from "./array.js";
import { bytes } from "./bytes.js";

export const valueEquals = (lhs: unknown, rhs: unknown): boolean =>
  isUint8Array(lhs) && isUint8Array(rhs) ? bytes.equals(lhs, rhs) : [lhs].includes(rhs);

export const assertDistinct = <T>(...values: T[]) => {
  if (values.some((value, i) => values.findIndex(prior => valueEquals(prior, value)) !== i))
    throw new Error(`Values are not distinct: ${values.map(String).join(", ")}`);
};

export const assertEqual = <T>(a: T, b: T, message?: string) => {
  if (a !== b)
    throw new Error(message ?? `Expected ${String(a)} to equal ${String(b)}`);
};
