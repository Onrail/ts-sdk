import type { Opts, RoArray } from "@onrail-xyz/utils";
import { type ToFixedOptions, Rational } from "./rational.js";
import type { Kind, Unit, KindUnitSymbols } from "./kind.js";
import { type SegmentPair, findUnit, segment } from "./segmenting.js";

const approxDigits = 3;

export function inUnit<K extends Kind>(
  kind:      K,
  stdVal:    Rational,
  symbol:    KindUnitSymbols<K>,
  precision: number | KindUnitSymbols<K> = 0,
  opts?:     Opts<ToFixedOptions>,
): string {
  const unit = kind.units[symbol]!;
  const value = stdVal.div(unit.scale);
  const decimals = typeof precision === "number"
    ? precision
    : unit.oom! - kind.units[precision]!.oom!;

  if (decimals < 0)
    throw new Error("Precision must be non-negative");

  return formatWithSymbol(value, decimals, unit, opts);
}

export function inUnitApprox<K extends Kind>(
  kind:   K,
  stdVal: Rational,
  symbol: KindUnitSymbols<K>,
  opts?:  Opts<ToFixedOptions>,
): string {
  const unit  = kind.units[symbol]!;
  const value = stdVal.div(unit.scale);

  return formatWithSymbol(value, sigDigitPrec(value), unit, opts);
}

export function approximate(
  kind:   Kind,
  stdVal: Rational,
  opts?:  Opts<ToFixedOptions & { system: string }>,
): string {
  const sortedByScale = getSystemUnits(kind, opts?.system);
  if (!isDecimal(kind, opts?.system))
    return compound(kind, sortedByScale, stdVal, true, opts);

  if (stdVal.eq(0))
    return formatZero(kind, sortedByScale, opts);

  const reading = approxReading(stdVal, sortedByScale);
  //a reading that rounds up into the next unit's range renders there instead: $0.9996 reads $1,
  //  not 100c
  const rounded = roundTo(reading.value, reading.precision).mul(reading.unit.scale);
  const next = sortedByScale[reading.index - 1];
  const final = reading.index > 0 && next !== undefined && rounded.abs().ge(next.scale)
    ? approxReading(rounded, sortedByScale)
    : reading;
  return formatWithSymbol(final.value, final.precision, final.unit, opts);
}

const approxReading = (stdVal: Rational, sortedByScale: RoArray<Unit>) => {
  const { index, unit, value, promoted } = displayUnitInfo(stdVal, sortedByScale);
  const precision = promoted ? approxDigits : getApproxPrec(index, value);
  return { index, unit, value, precision };
};

//the value as a given number of decimals renders it (half away from zero, as toFixed does)
const roundTo = (value: Rational, decimals: number): Rational => {
  const scale = Rational.powerOfTen(decimals);
  return Rational.from(value.mul(scale).round()).div(scale);
};

export function exact(
  kind:   Kind,
  stdVal: Rational,
  opts?:  Opts<ToFixedOptions & { system: string }>,
): string {
  const sortedByScale = getSystemUnits(kind, opts?.system);
  if (!isDecimal(kind, opts?.system))
    return compound(kind, sortedByScale, stdVal, false, opts);

  if (stdVal.eq(0))
    return formatZero(kind, sortedByScale, opts);

  const { unit, value } = displayUnitInfo(stdVal, sortedByScale);
  return renderExact(value, unit, opts);
}

export function parse(kind: Kind, str: string): Rational {
  const processPair = (pair: SegmentPair) => {
    const value  = Rational.from(str.substring(pair.value[0], pair.value[1]));
    const symbol = str.substring(pair.symbol[0], pair.symbol[1]);
    const unit   = findUnit(kind.units, symbol);
    if (!unit)
      throw new Error(`Unknown unit: ${symbol}`);

    return { value, unit };
  };

  const { negative, pairs } = segment(str);

  if (pairs.length === 1) {
    const { value, unit } = processPair(pairs[0]!);
    const absVal = value.mul(unit.scale);
    return negative ? absVal.neg() : absVal;
  }

  let total = Rational.from(0n);
  let lastScale: Rational | undefined = undefined;
  for (let i = 0; i < pairs.length; ++i) {
    const { value, unit } = processPair(pairs[i]!);

    if (i !== pairs.length - 1 && !value.isInteger())
      throw new Error("Decimal only allowed in final unit");

    if (lastScale && lastScale.le(unit.scale))
      throw new Error("Units must be in descending order");

    total = total.add(value.mul(unit.scale));
    lastScale = unit.scale;
  }

  return negative ? total.neg() : total;
}

export function exactRate(
  num:   Kind,
  den:   Kind,
  ratio: Rational,
  opts?: Opts<ToFixedOptions>,
): string {
  const denUnit = bestDenUnit(num, den, ratio);
  return `${exact(num, ratio.mul(denUnit.scale), opts)}/${denUnit.symbol}`;
}

export const bestDenUnit = (num: Kind, den: Kind, ratio: Rational): Unit => {
  if (den.human !== undefined || ratio.eq(0))
    return den.units[den.human ?? den.standard.unit]!;

  let best: { mixed: boolean; size: number; unit: Unit } | undefined;
  for (const unit of getSystemUnits(den)) {
    const rendered = exact(num, ratio.mul(unit.scale), { thousandsSep: "" });
    //symbols cannot contain "/", so its presence marks the mixed-number form
    const mixed = rendered.includes("/");
    const size  = rendered.length + unit.symbol.length;
    if (!best || (mixed === best.mixed ? size < best.size : best.mixed))
      best = { mixed, size, unit };
  }
  return best!.unit;
};

const renderExact = (value: Rational, unit: Unit, opts?: Opts<ToFixedOptions>): string => {
  const valStr = value.toString({ thousandsSep: opts?.thousandsSep ?? "," });
  return attachSymbol(valStr, unit, valStr === "1" || valStr === "-1");
};

const compound = (
  kind:          Kind,
  sortedByScale: Unit[],
  stdVal:        Rational,
  approx:        boolean,
  opts?:         Opts<ToFixedOptions>,
): string => {
  if (stdVal.eq(0))
    return formatZero(kind, sortedByScale, opts);

  const sign = stdVal.lt(0) ? "-" : "";
  const smallest = sortedByScale.length - 1;
  let absStdVal = stdVal.abs();

  if (approx) {
    //a value the smallest unit carries on its own renders in it, to significant digits - unless
    //  those round up to the next unit, in which case it spans units after all
    const { lbIndex, lbUnit, lbValue } = lowerBoundInfo(absStdVal, sortedByScale);
    if (lbIndex === -1 || lbIndex === smallest) {
      const precision = getApproxPrec(lbIndex, lbValue);
      const rounded = roundTo(lbValue, precision).mul(lbUnit.scale);
      if (smallest === 0 || lbIndex === -1 || rounded.lt(sortedByScale[smallest - 1]!.scale))
        return sign + formatWithSymbol(lbValue, precision, lbUnit, opts);

      absStdVal = rounded;
    }
    //rounded to whole smallest units first and decomposed exactly after, so no part can round
    //  up into the next unit's range (no "1 minute 60 seconds")
    const smallestScale = sortedByScale[smallest]!.scale;
    absStdVal = Rational.from(absStdVal.div(smallestScale).round()).mul(smallestScale);
  }

  const parts: string[] = [];
  const tolerance = approx ? absStdVal.div(Rational.powerOfTen(approxDigits)) : null;
  let remainder = absStdVal;
  let startFrom = 0;

  while (remainder.ne(0)) {
    const { lbIndex, lbUnit, lbValue } = lowerBoundInfo(remainder, sortedByScale, startFrom);
    const atSmallest = lbIndex === -1 || lbIndex === smallest;

    if (atSmallest && !approx)
      parts.push(renderExact(lbValue, lbUnit, opts));
    else
      parts.push(formatWithSymbol(Rational.from(lbValue.floor()), 0, lbUnit, opts));

    if (atSmallest)
      break;

    const nextRemainder = remainder.mod(lbUnit.scale);
    if (tolerance !== null && nextRemainder.lt(tolerance))
      break;

    remainder = nextRemainder;
    startFrom = lbIndex + 1;
  }

  return sign + parts.join(" ");
};

const formatZero = (
  kind:          Kind,
  sortedByScale: RoArray<Unit>,
  opts?:         Opts<ToFixedOptions>,
): string => {
  const preferred = kind.units[kind.human ?? kind.standard.unit]!;
  const unit = sortedByScale.find(u => u.scale.eq(preferred.scale)) ?? sortedByScale.at(-1)!;
  return formatWithSymbol(Rational.from(0n), 0, unit, opts);
};

function formatWithSymbol(
  value:    Rational,
  decimals: number,
  unit:     Unit,
  opts?:    Opts<ToFixedOptions>,
): string {
  const thousandsSep = opts?.thousandsSep ?? ",";
  const trimZeros    = opts?.trimZeros    ?? true;

  const valStr = value.toFixed(decimals, { thousandsSep, trimZeros });
  //the plural follows the displayed magnitude, not the exact one (0.9999 at 2 decimals shows as 1)
  const oneStr = Rational.from(1n).toFixed(decimals, { thousandsSep, trimZeros });
  return attachSymbol(valStr, unit, valStr === oneStr || valStr === `-${oneStr}`);
}

const attachSymbol = (valStr: string, unit: Unit, singular: boolean): string => {
  const sym   = unit.plural && !singular ? unit.plural : unit.symbol;
  const space = (unit.spacing ?? "spaced") === "spaced" ? " " : "";

  if ((unit.position ?? "postfix") === "postfix")
    return valStr + space + sym;

  //the sign stays outside the symbol: parsing only takes a "-" that leads the whole pair, so an
  //  interior one ("$-100") would be read as part of the symbol
  const [sign, digits] = valStr.startsWith("-") ? ["-", valStr.slice(1)] : ["", valStr];
  return sign + sym + space + digits;
};

const getSystem = (kind: Kind, system?: string) => {
  const name = system ?? kind.standard.system;
  const sys = kind.systems[name];
  if (!sys)
    throw new Error(`Unknown system: ${name}`);

  return sys;
};

const getSystemUnits = (kind: Kind, system?: string): Unit[] => {
  const units: Unit[] = [];
  for (const symbol of getSystem(kind, system).symbols) {
    const unit = kind.units[symbol]!;
    if (!units.some(u => u.scale.eq(unit.scale)))
      units.push(unit);
  }
  return units;
};

const isDecimal = (kind: Kind, system?: string): boolean =>
  getSystem(kind, system).decimal;

//number of decimals that yields approxDigits significant digits (0 for values >= 10^approxDigits)
const sigDigitPrec = (value: Rational): number => {
  const absVal = value.abs();
  let precision = approxDigits;
  while (precision > 0 && absVal.ge(Rational.powerOfTen(approxDigits - precision)))
    --precision;

  while (absVal.ne(0) && absVal.lt(Rational.powerOfTen(approxDigits - precision - 1)))
    ++precision;

  return precision;
};

//below the smallest unit of the kind the precision is capped instead of following the value
const getApproxPrec = (lbIndex: number, lbValue: Rational): number =>
  lbIndex === -1 ? approxDigits : sigDigitPrec(lbValue);

//the unit both display modes render in: the largest unit the value reaches, promoted to the next
//  one up when the ladder gap is wide enough for the reading to run long (six orders — ¢/$ never
//  promotes) and the promoted reading has at least a thousandth of it: 15,000 Gwei stays put,
//  0.5 ETH is not 500,000,000 Gwei
const displayUnitInfo = (stdVal: Rational, sortedByScale: RoArray<Unit>) => {
  const { lbIndex, lbUnit, lbValue } = lowerBoundInfo(stdVal, sortedByScale);
  const lb = { index: lbIndex, unit: lbUnit, value: lbValue, promoted: false } as const;
  if (lbIndex <= 0)
    return lb;

  const unit  = sortedByScale[lbIndex - 1]!;
  const value = stdVal.div(unit.scale);
  return unit.oom! - lbUnit.oom! >= 2 * approxDigits
      && value.abs().ge(Rational.powerOfTen(-approxDigits))
    ? { index: lbIndex - 1, unit, value, promoted: true } as const
    : lb;
};

const lowerBoundInfo = (
  stdVal:        Rational,
  sortedByScale: RoArray<Unit>,
  startIndex:    number = 0,
) => {
  const absStdVal = stdVal.abs();
  let lbIndex = startIndex;
  for (; lbIndex < sortedByScale.length; ++lbIndex)
    if (absStdVal.ge(sortedByScale[lbIndex]!.scale))
      break;

  if (lbIndex === sortedByScale.length)
    lbIndex = -1;

  const lbUnit  = sortedByScale.at(lbIndex)!;
  const lbValue = stdVal.div(lbUnit.scale);
  return { lbIndex, lbUnit, lbValue } as const;
};
