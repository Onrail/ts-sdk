import type { StrRecord } from "@onrail-xyz/utils";

type Span = [number, number];

export type SegmentPair = {
  value:  Span;
  symbol: Span;
};

type SegmentResult = {
  negative: boolean;
  pairs:    SegmentPair[];
};

//unit symbols are identifiers, so they compare as Unicode prescribes for those (UAX #31): by NFKC
//  form, under which "m3" finds "m³", "℃" finds "°C", and the lookalikes Greek mu (U+03BC) and
//  micro sign (U+00B5) find each other
export const symbolKey = (symbol: string) => symbol.normalize("NFKC");

const keyedUnits = new WeakMap<object, Map<string, unknown>>();

export function findUnit<U>(units: Readonly<StrRecord<U>>, symbol: string): U | undefined {
  if (Object.hasOwn(units, symbol))
    return units[symbol];

  let keyed = keyedUnits.get(units) as Map<string, U> | undefined;
  if (keyed === undefined) {
    keyed = new Map(Object.entries(units).map(([s, unit]) => [symbolKey(s), unit]));
    keyedUnits.set(units, keyed);
  }
  return keyed.get(symbolKey(symbol));
}

type StartResult = {
  pos:      number;
  negative: boolean;
};

type PairResult = {
  pair: SegmentPair;
  end:  number;
};

const asciiSpace      = 32;
const asciiZero       = 48;
const asciiNine       = 57;
const asciiComma      = 44;
const asciiUnderscore = 95;
const asciiDot        = 46;
const asciiSlash      = 47;

const charIsDigit = (c: number) =>
  asciiZero <= c && c <= asciiNine;

const charIsNumPart = (c: number) =>
  charIsDigit(c)        ||
  c === asciiComma      ||
  c === asciiUnderscore ||
  c === asciiDot        ||
  c === asciiSlash;

const isValChar = charIsNumPart;
const isSymChar = (c: number) => c !== asciiSpace && !charIsNumPart(c);
//a symbol that follows its value is delimited by the next space, so digits may continue it
const isPostfixSymChar = (c: number) => c !== asciiSpace && (charIsDigit(c) || !charIsNumPart(c));

const parseSpan = (
  str:      string,
  pos:      number,
  isValid:  (c: number) => boolean,
  expected: string
): Span => {
  const start = pos;
  while (pos < str.length && isValid(str.charCodeAt(pos)))
    ++pos;

  if (pos === start)
    throw new Error(`Expected ${expected} at position ${start}`);

  return [start, pos];
};

const parseSign = (str: string): StartResult => {
  let pos = 0;
  if (str.length === 0)
    throw new Error("Empty input");

  const negative = str[0] === "-";
  if (negative && ++pos === str.length)
    throw new Error("Sign only input");

  return { pos, negative };
};

const startsFraction = (str: string, at: number) =>
  str.charCodeAt(at) === asciiSpace && charIsDigit(str.charCodeAt(at + 1));

//a value is either a plain number or a mixed number ("1,763 3/7") whose interior space is
//  folded into one span — the digit after the space is what disambiguates a fraction from a
//  symbol, which can never start with one. Rational.from owns the value grammar either way.
const parseValue = (str: string, pos: number): Span => {
  const first = parseSpan(str, pos, isValChar, "value");
  if (!startsFraction(str, first[1]))
    return first;

  const frac = parseSpan(str, first[1] + 1, isValChar, "fraction");
  return [first[0], frac[1]];
};

const parsePair = (str: string, pos: number): PairResult => {
  //the only leniency while parsing: we accept a space, even if the symbol is compact
  const skipSpace = (p: number, expected: string) => {
    if (str.charCodeAt(p) !== asciiSpace)
      return p;
    if (++p >= str.length)
      throw new Error(`Unexpected end of input: expected ${expected} next`);
    return p;
  };

  if (charIsDigit(str.charCodeAt(pos))) {
    const value  = parseValue(str, pos);
    const symbol = parseSpan(str, skipSpace(value[1], "symbol"), isPostfixSymChar, "symbol");
    return { pair: { value, symbol }, end: symbol[1] };
  }

  const symbol = parseSpan(str, pos, isSymChar, "symbol");
  const value  = parseValue(str, skipSpace(symbol[1], "value"));
  return { pair: { value, symbol }, end: value[1] };
};

export const segment = (str: string): SegmentResult => {
  const start = parseSign(str);
  let   { pos      } = start;
  const { negative } = start;
  const pairs: SegmentPair[] = [];

  while (true) {
    const { pair, end } = parsePair(str, pos);
    pairs.push(pair);
    pos = end;

    if (pos === str.length)
      break;

    if (str.charCodeAt(pos) !== asciiSpace)
      throw new Error("Expected space after value/symbol pair");

    ++pos;
    if (pos === str.length)
      throw new Error("Unexpected end of input: Expected another value/symbol pair");
  }

  return { negative, pairs };
};
