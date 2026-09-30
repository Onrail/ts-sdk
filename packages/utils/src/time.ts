export const msPerSecond = 1000;
//ECMA-262 pins Date's range at ±100,000,000 days around the epoch but exports no constant for it
export const dateRangeMs = 8_640_000_000_000_000;

export const checkedDate = (value: number | string): Date => {
  const date = new Date(value);
  if (isNaN(date.getTime()))
    throw new Error(`Invalid date: ${value}`);

  return date;
};

export const unixTime = {
  toDate: (seconds: number | bigint): Date => {
    const date = new Date(Number(seconds) * msPerSecond);
    if (isNaN(date.getTime()))
      throw new Error(`Timestamp out of Date range: ${seconds}`);

    return date;
  },

  fromDate: (date: Date): number => {
    const ms = date.getTime();
    if (isNaN(ms))
      throw new Error("Invalid date");

    return Math.floor(ms / msPerSecond);
  },
};
