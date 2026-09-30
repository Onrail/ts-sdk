import type { RoPair, Opts, OptionalArg, OmitUndefined } from "@onrail-xyz/utils";
import { msPerSecond, dateRangeMs, omitUndefined } from "@onrail-xyz/utils";
import type { Conversion, Endianness, NumSizeToPrimitive } from "./layout.js";
import { numberMaxSize, bitsPerByte } from "./layout.js";
import { numSizeToPrimitive } from "./utils.js";

export type TimeUnit = "s" | "ms";

const defaultSize = 4;

//origin: the instant the encoded count is measured from - unix epoch by default
//saturateAs: sentinel in place of out-of-range throws - too-late times encode to the field's
//  max, while max itself and counts beyond Date's range decode to the sentinel - on the wire,
//  max and the sentinel are synonyms. It is unconstrained; even a Date works (sentinels match
//  by value, so its instant is reserved) and keeps the decoded type union-free.
//the options take the Opts convention (an explicit undefined reads as unset) except saturateAs,
//  for which undefined is a legitimate sentinel: its mere presence is what declares one
export type TimestampConversionOpts =
  Opts<{ unit: TimeUnit, size: number, origin: Date }> &
  Partial<{ saturateAs: unknown }> &
  { readonly endianness?: never }; //a conversion has no byte order

export type TimestampOpts =
  Omit<TimestampConversionOpts, "endianness"> & Opts<{ endianness: Endianness }>;

//the types the options select are read off the whole record, each by its own rule, so that an
//  option that may be undefined - or absent, when the record's own type declares it optional -
//  types as either outcome. The record is const, so a string sentinel stays the literal it names
//  (`Date | "never"`, where a widened `Date | string` would admit every string as a timestamp)
type OptOf<O, K extends PropertyKey> = K extends keyof O ? O[K] : undefined;
type SizeOf<O> =
  | Exclude<OptOf<O, "size">, undefined>
  | (undefined extends OptOf<O, "size"> ? typeof defaultSize : never);
type SentinelOf<O> = "saturateAs" extends keyof O ? O["saturateAs" & keyof O] : never;

type Timestamp<M> = Date | M;

export type TimestampConversion<O extends TimestampConversionOpts> =
  Conversion<NumSizeToPrimitive<SizeOf<O>>, Timestamp<SentinelOf<O>>>;

export const timestampConversion = <const O extends TimestampConversionOpts = {}>(
  ...[opts]: OptionalArg<O>
): TimestampConversion<O> => {
  type Raw   = NumSizeToPrimitive<SizeOf<O>>;
  type Value = Timestamp<SentinelOf<O>>;

  const unit        = opts?.unit ?? "s";
  const size        = (opts?.size ?? defaultSize) as SizeOf<O>;
  //a sentinel declared as undefined has to stay distinguishable from no sentinel at all
  const hasSentinel = opts !== undefined && "saturateAs" in opts;
  const sentinel    = opts?.saturateAs as Value;

  //derived in bigint once so that the domain the conversion itself runs in stays a free choice
  const originMs = BigInt(opts?.origin?.getTime() ?? 0);
  const unitMs   = unit === "s" ? BigInt(msPerSecond) : 1n;
  const max      = (1n << BigInt(size * bitsPerByte)) - 1n;
  //for counts before the origin we have to floor rather than truncate
  const floorDiv = (a: bigint, b: bigint) => {
    const quotient = a / b;
    return a % b !== 0n && (a < 0n) !== (b < 0n) ? quotient - 1n : quotient;
  };
  const dateRange = BigInt(dateRangeMs);
  //the count past which the resulting instant leaves what Date can represent (no counterpart
  //  below: counts are unsigned, so no instant can predate the origin - itself a valid Date)
  const dateHi = floorDiv(dateRange - originMs, unitMs);

  //by value: a Date by its instant, all else by SameValueZero -> Invalid Dates match nothing
  const isSentinel = (time: unknown, sentinel: unknown) =>
    time instanceof Date && sentinel instanceof Date
    ? time.getTime() === sentinel.getTime()
    : time === sentinel || (time !== time && sentinel !== sentinel);

  const conversion = <D extends number | bigint>(
    countOf:   (ms:    number) => D,    //floor((ms - origin) / unit)
    instantOf: (count: D     ) => Date, //origin + count * unit
    asCount:   (value: Raw   ) => D,    //casts between the wire type and the
    asValue:   (count: D     ) => Raw,  //arithmetic domain
    [max, dateHi]: RoPair<D, D>,
  ) => {
    //counts that don't fit the wire - negative, NaN, oversized - are serializeNum's to reject
    const saturatedCountOf = (time: Value): D => {
      //the sentinel precedes the Date branch because a sentinel Date is indistinguishable from
      //  an instant, and where the field outranges Date the clamp below would not reach the bound
      if (hasSentinel && isSentinel(time, sentinel))
        return max;

      const count = countOf((time as Date).getTime());
      return hasSentinel && count > max ? max : count;
    };

    return {
      to: (value: Raw) => {
        const count = asCount(value);
        const beyondDate = count > dateHi;
        if (hasSentinel && (count === max || beyondDate))
          return sentinel;

        if (beyondDate)
          throw new Error(
            `uint${size * bitsPerByte} ${unit} timestamp count ${count} ` +
            `lands outside the range Date can represent`
          );

        return instantOf(count) as Value;
      },
      from: (time: Value) => asValue(saturatedCountOf(time)),
    };
  };

  const maxSafeOriginMs = BigInt(Number.MAX_SAFE_INTEGER) - dateRange;
  if (size <= numberMaxSize && (originMs < 0n ? -originMs : originMs) <= maxSafeOriginMs) {
    const org = Number(originMs), unt = Number(unitMs);
    return conversion(
      ms    => Math.floor((ms - org) / unt),
      count => new Date(org + count * unt),
      value => value as number,
      count => count as Raw,
      [Number(max), Number(dateHi)],
    );
  }

  return conversion(
    ms    => floorDiv(BigInt(ms) - originMs, unitMs),
    count => new Date(Number(originMs + count * unitMs)),
    value => BigInt(value),
    count => numSizeToPrimitive(count, size),
    [max, dateHi],
  );
};

//endianness is spread in only when given, matching every other item factory: a materialized
//  default is a claim the caller never made, and inside a packed word - where a byte-sized item
//  is a bit range with no byte order of its own - the engine rejects that claim
export type TimestampItem<O extends TimestampOpts> = {
  readonly binary: "uint",
  readonly size:   SizeOf<O>,
  readonly custom: TimestampConversion<Omit<O, "endianness">>,
} & OmitUndefined<{ readonly endianness: OptOf<O, "endianness"> }>;

export const timestampItem = <const O extends TimestampOpts = {}>(
  ...[opts]: OptionalArg<O>
): TimestampItem<O> => {
  const { endianness, ...convOpts } = opts ?? {};
  return {
    binary: "uint",
    size:   opts?.size ?? defaultSize,
    custom: timestampConversion(convOpts),
    ...omitUndefined({ endianness }),
  } as any;
};
