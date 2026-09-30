export const assertDistinct = <T>(...values: T[]) => {
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length)
    throw new Error(`Values are not distinct: ${values.map(String).join(", ")}`);
};

export const assertEqual = <T>(
  a: T,
  b: T,
  message?: string,
) => {
  if (a !== b)
    throw new Error(message ?? `Expected ${String(a)} to equal ${String(b)}`);
};
