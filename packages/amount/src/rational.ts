import { type Opts, range, mapTo } from "@onrail-xyz/utils";

type ubigint = bigint; //just an annotation that these bigints are always guaranteed to be unsigned

export type Rationalish = Rational | number | bigint;
export type ThousandsSep = "" | "," | "_";
export type ToFixedOptions = { thousandsSep: ThousandsSep; trimZeros: boolean };

const maxTabulatedOom = 30; //should comfortably span every unit scale in practice
const tenPows = mapTo(range(maxTabulatedOom + 1))(exp => 10n ** BigInt(exp));
export const tenToThe = (exp: number): bigint => tenPows[exp] ?? 10n ** BigInt(exp);

export class Rational {
  static powerOfTen(oom: number): Rational {
    return oom < 0
      ? new Rational(1n, tenToThe(-oom))
      : new Rational(tenToThe(oom), 1n);
  }

  private readonly n: bigint;
  private readonly d: ubigint;

  //class invariants: n and d are always coprime, d is always positive
  private constructor(n: bigint, d: ubigint) {
    this.n = n;
    this.d = d;
  }

  static from(value: Rationalish | string): Rational;
  static from(numerator: bigint, denominator?: bigint): Rational;
  static from(valueOrNumerator: Rationalish | string, denominator?: bigint): Rational {
    switch (typeof valueOrNumerator) {
      case "number": {
        const value = valueOrNumerator;
        if (Number.isSafeInteger(value))
          return new Rational(BigInt(value), 1n);

        if (!Number.isFinite(value))
          throw new Error("Invalid value");

        //A double only ever approximates the value that named it, and two readings compete: the
        //  decimal it prints as, and a compact fraction it might be the rounding of (1/3 out of
        //  0.3333...). A decimal short enough to round-trip through the double is certainly the
        //  spelling that produced it, so it wins outright - which guarantees that the number and
        //  string paths agree on every decimal literal of up to 15 significant digits.
        const dec = value.toString();
        if (dec.replace(/^-|\.|e[+-]?\d+$/gi, "").replace(/^0+/, "").length <= maxReliableDecimals)
          return Rational.from(dec);

        //Otherwise hunt for the compact fraction via continued fractions. A convergent is only
        //  credible as the intended value if it could hardly have landed within half an ulp of
        //  the double by accident: fractions with denominator <= D cover a random interval of
        //  width u with probability ~D²u, so capping D²·ulp(target) at 2^-16 bounds the odds of
        //  fitting noise at ~10^-5, while any deliberate fraction the double can faithfully carry
        //  clears the cap with a >= 2^8 margin in the denominator. With ulp ~ target·2^-52 the
        //  cap reads D = 2^18/√target - which also keeps every tried convergent exact in doubles
        //  (d <= 2^36, n ~ target·d <= 2^44). Whatever fails it defers to the exact decimal -
        //  toString hands it over by definition. Either way the value is never approximated.
        const sign = value < 0 ? -1n : 1n;
        const target = Math.abs(value);
        const maxCredibleDenom = 2 ** 18 / Math.sqrt(target);
        let cur = target;

        let n2 = 0, n1 = 1, d2 = 1, d1 = 0;
        while (true) {
          const a = Math.floor(cur);
          const n = a * n1 + n2;
          const d = a * d1 + d2;

          if (d > maxCredibleDenom)
            return Rational.from(dec);

          if (n / d === target)
            return new Rational(sign * BigInt(n), BigInt(d));

          const next = 1 / (cur - a);
          if (!Number.isFinite(next)) //the recurrence ran out of double precision
            return Rational.from(dec);

          n2 = n1; n1 = n; d2 = d1; d1 = d;
          cur = next;
        }
      }

      case "bigint": {
        if (denominator === undefined)
          return new Rational(valueOrNumerator, 1n);

        if (denominator === 0n)
          throw new Error("Denominator cannot be zero");

        let [num, den] = [valueOrNumerator, denominator];
        if (den < 0n)
          [num, den] = [-num, -den];

        return new Rational(...Rational.normalize(num, den));
      }

      case "string": {
        const mixedMatch = mixedRegex.exec(valueOrNumerator);
        if (mixedMatch) {
          const [, sign, intStr, numStr, denStr] = mixedMatch;
          const den = parseBigInt(denStr!);
          if (den === 0n)
            throw new Error("Denominator cannot be zero");
          const num = parseBigInt(intStr!) * den + parseBigInt(numStr!);
          return new Rational(...Rational.normalize(sign === "-" ? -num : num, den));
        }

        const ratioMatch = ratioRegex.exec(valueOrNumerator);
        if (ratioMatch) {
          const [, sign, numStr, denStr] = ratioMatch;
          const num = (sign === "-" ? -1n : 1n) * parseBigInt(numStr!);
          const den = parseBigInt(denStr!);
          if (den === 0n)
            throw new Error("Denominator cannot be zero");
          return new Rational(...Rational.normalize(num, den));
        }

        const decMatch = decimalRegex.exec(valueOrNumerator);
        if (!decMatch)
          throw new Error(`Invalid rational value: ${valueOrNumerator}`);

        const [, sign, intStr, frac, expStr] = decMatch;
        //apply the sign to the assembled absolute value, not the integer part: for values in
        //  (-1, 0) the integer part is 0, which would swallow the sign (0n is not < 0n)
        const neg = sign === "-";
        //appending the fraction to the integer digits scales by 10^frac.length, which the exponent
        //  then offsets - so both only ever move the decimal point
        const absValue = parseBigInt(intStr! + (frac ?? ""));
        const signed = neg ? -absValue : absValue;
        const oom = Number(expStr ?? 0) - (frac?.length ?? 0);

        return oom >= 0
          ? new Rational(signed * tenToThe(oom), 1n)
          : new Rational(...Rational.normalize(signed, tenToThe(-oom)));
      }

      default:
        return valueOrNumerator;
    }
  }

  unwrap(): [bigint, bigint] {
    return [this.n, this.d];
  }

  //the only lossy operation on Rationals: the result is the nearest double/+-inf, ties to even
  toNumber(): number {
    if (this.n === 0n)
      return 0;

    if (-maxExactInt <= this.n && this.n <= maxExactInt && this.d <= maxExactInt)
      return Number(this.n) / Number(this.d);

    const negative = this.n < 0n;
    const num = negative ? -this.n : this.n;

    //floor(log2(num/d)) - the difference in bit lengths is right to within one, and a single
    //  comparison settles which
    const bitDiff = bitLength(num) - bitLength(this.d);
    const exponent = (
      bitDiff >= 0 ? num >= this.d << BigInt(bitDiff) : num << BigInt(-bitDiff) >= this.d
    ) ? bitDiff : bitDiff - 1;

    //the exponent of the mantissa's last bit, clamped because a subnormal has fewer bits to spend
    //  and so has to be rounded further left. Fixing it up front is what reduces the whole
    //  conversion to a single division and a single rounding step.
    const lastBitExp = Math.max(exponent - (mantissaBits - 1), minSubnormalExp);
    const [scaledNum, scaledDen] = lastBitExp <= 0
      ? [num << BigInt(-lastBitExp), this.d]
      : [num, this.d << BigInt(lastBitExp)];

    let mantissa = scaledNum / scaledDen;
    const twiceRest = (scaledNum % scaledDen) * 2n;
    if (twiceRest > scaledDen || (twiceRest === scaledDen && (mantissa & 1n) === 1n))
      ++mantissa; //carrying into an extra bit is fine: the scaling below absorbs it

    //mantissa fits a double exactly, and so does the power of two, so the product is exact - or
    //  Infinity, which is the right answer when the value overflows
    const absValue = Number(mantissa) * 2 ** lastBitExp;
    return negative ? -absValue : absValue;
  }

  //exact: the terminating decimal expansion when there is one, the mixed-number form
  //  otherwise ("333 1/3", "-1/3") — either way `from` parses it back to the same value
  toString(opts?: Opts<{ thousandsSep: ThousandsSep }>): string {
    const decimals = this.decimalPlaces();
    if (decimals !== undefined)
      return this.toFixed(decimals, opts);

    const thousandsSep = opts?.thousandsSep ?? "";
    const nAbs   = Rational.stripSign(this.n);
    const int    = nAbs / this.d;
    const intStr = int === 0n ? "" : Rational.addSep(int.toString(), thousandsSep) + " ";
    const frac   = Rational.addSep((nAbs % this.d).toString(), thousandsSep) +
                   "/" + Rational.addSep(this.d.toString(), thousandsSep);
    return (this.n < 0n ? "-" : "") + intStr + frac;
  }

  //same exact form — the method only exists because JSON.stringify never consults toString and
  //  would otherwise trip over the private bigint fields
  toJSON(): string {
    return this.toString();
  }

  toFixed(precision: number = 0, opts?: Opts<ToFixedOptions>): string {
    const thousandsSep = opts?.thousandsSep ?? "";
    const trimZeros    = opts?.trimZeros    ?? false;

    const multiplier = tenToThe(precision);
    const nAbs = Rational.stripSign(this.n);
    //half away from zero, as in round(); d truncating on halving is harmless because a tie
    //  requires an even denominator, where the halving is exact
    const val = (nAbs * multiplier + this.d / 2n) / this.d;
    const sign = this.n < 0n && val !== 0n ? "-" : "";

    if (precision === 0)
      return sign + Rational.addSep(val.toString(), thousandsSep);

    const valStr = val.toString().padStart(precision + 1, "0");
    const intPartStr = Rational.addSep(valStr.slice(0, -precision), thousandsSep);
    let fracPartStr = valStr.slice(-precision);

    if (trimZeros) {
      fracPartStr = fracPartStr.replace(/0+$/, "");
      if (fracPartStr === "")
        return sign + intPartStr;
    }

    return sign + intPartStr + "." + fracPartStr;
  }

  isInteger(): boolean {
    return this.d === 1n;
  }

  //decimal places of the exact expansion, or undefined when it does not terminate (i.e. the
  //  denominator has prime factors other than 2 and 5)
  decimalPlaces(): number | undefined {
    let [d, twos, fives] = [this.d, 0, 0];
    for (; (d & 1n) === 0n; d >>= 1n) ++twos;
    for (; d % 5n === 0n; d /= 5n) ++fives;
    return d === 1n ? Math.max(twos, fives) : undefined;
  }

  sign(): -1 | 0 | 1 {
    return this.n < 0n ? -1 : this.n > 0n ? 1 : 0;
  }

  ceil(): bigint {
    const intPart = this.n / this.d;
    return this.n > 0n && this.n % this.d !== 0n ? intPart + 1n : intPart;
  }

  //round half away from zero, so round(-x) === -round(x) (unlike Math.round's half-to-+inf)
  round(): bigint {
    const nAbs = Rational.stripSign(this.n);
    const q = (nAbs * 2n + this.d) / (this.d * 2n);
    return this.n < 0n ? -q : q;
  }

  floor(): bigint {
    const intPart = this.n / this.d;
    return this.n < 0n && this.n % this.d !== 0n ? intPart - 1n : intPart;
  }

  abs(): Rational {
    return this.n < 0n ? this.neg() : this;
  }

  neg(): Rational {
    return this.n === 0n ? this : new Rational(-this.n, this.d);
  }

  inv(): Rational {
    if (this.n === 0n)
      throw new Error("Cannot invert zero");

    return (this.n < 0n)
      ? new Rational(-this.d, -this.n)
      : new Rational(this.d, this.n);
  }

  eq(other: Rationalish): boolean {
    switch (typeof other) {
      case "number":
        return this.eq(Rational.from(other));

      case "bigint":
        return this.n === other && this.d === 1n;

      default:
        return this.n === other.n && this.d === other.d;
    }
  }

  ne(other: Rationalish): boolean {
    return !this.eq(other);
  }

  gt(other: Rationalish): boolean {
    switch (typeof other) {
      case "number":
        return this.gt(Rational.from(other));

      case "bigint":
        return this.n > other * this.d;

      default:
        return this.n * other.d > other.n * this.d;
    }
  }

  ge(other: Rationalish): boolean {
    switch (typeof other) {
      case "number":
        return this.ge(Rational.from(other));

      case "bigint":
        return this.n >= other * this.d;

      default:
        return this.n * other.d >= other.n * this.d;
    }
  }

  lt(other: Rationalish): boolean {
    return !this.ge(other);
  }

  //a comparator's answer from one cross-multiplication - `sub(other).sign()` would normalize a
  //  whole difference just to read its sign
  cmp(other: Rationalish): -1 | 0 | 1 {
    switch (typeof other) {
      case "number":
        return this.cmp(Rational.from(other));

      case "bigint": {
        const rhs = other * this.d;
        return this.n < rhs ? -1 : this.n > rhs ? 1 : 0;
      }
      default: {
        const lhs = this.n * other.d;
        const rhs = other.n * this.d;
        return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
      }
    }
  }

  le(other: Rationalish): boolean {
    return !this.gt(other);
  }

  add(other: Rationalish): Rational {
    switch (typeof other) {
      case "number":
        return this.add(Number.isSafeInteger(other) ? BigInt(other) : Rational.from(other));

      case "bigint":
        //gcd(n + k·d, d) = gcd(n, d) = 1, so the sum is already in lowest terms
        return new Rational(this.n + other * this.d, this.d);

      default: {
        //Knuth's reduction: over the lcm, only a factor of gcd(d1, d2) can still cancel, so the
        //  sum is normalized against that instead of against the whole lcm
        const g = Rational.gcd(this.d, other.d);
        const thisCofactor = this.d / g;
        const otherCofactor = other.d / g;
        const num = this.n * otherCofactor + other.n * thisCofactor;
        if (num === 0n)
          return new Rational(0n, 1n);

        const g2 = Rational.gcd(Rational.stripSign(num), g);
        return new Rational(num / g2, thisCofactor * (other.d / g2));
      }
    }
  }

  sub(other: Rationalish): Rational {
    return this.add(typeof other === "bigint" || typeof other === "number" ? -other : other.neg());
  }

  mul(other: Rationalish): Rational {
    switch (typeof other) {
      case "number":
        return this.mul(Number.isSafeInteger(other) ? BigInt(other) : Rational.from(other));

      case "bigint": {
        const gcd = Rational.gcd(Rational.stripSign(other), this.d);
        return new Rational(this.n * (other / gcd), this.d / gcd);
      }

      default: {
        const gcd1 = Rational.gcd(Rational.stripSign(this.n), other.d);
        const gcd2 = Rational.gcd(Rational.stripSign(other.n), this.d);
        const num = (this.n / gcd1) * (other.n / gcd2);
        const den = (this.d / gcd2) * (other.d / gcd1);
        return new Rational(num, den);
      }
    }
  }

  div(other: Rationalish): Rational {
    switch (typeof other) {
      case "number":
        return this.div(Number.isSafeInteger(other) ? BigInt(other) : Rational.from(other));

      case "bigint": {
        if (other === 0n)
          throw new Error("Cannot divide by zero");

        //keep the sign on the numerator to maintain the class invariant
        const [num, den] = Rational.normalize(this.n, Rational.stripSign(other));
        return new Rational(other < 0n ? -num : num, den * this.d);
      }

      default:
        if (other.n === 0n)
          throw new Error("Cannot divide by zero");

        return this.mul(other.inv());
    }
  }

  //floored modulo, i.e. the result carries the sign of the divisor (unlike bigint's %)
  mod(other: Rationalish): Rational {
    const divisor = Rational.from(other);
    return this.sub(divisor.mul(this.div(divisor).floor()));
  }

  private static addSep(intStr: string, thousandsSep: ThousandsSep): string {
    return thousandsSep ? intStr.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep) : intStr;
  }

  private static gcd(a: ubigint, b: ubigint): ubigint {
    while (b !== 0n)
      [a, b] = [b, a % b];

    return a;
  }

  private static stripSign(n: bigint): ubigint {
    return n < 0n ? -n : n;
  }

  private static normalize(n: bigint, d: ubigint): [bigint, ubigint] {
    const gcd = Rational.gcd(Rational.stripSign(n), d);
    return [n / gcd, d / gcd];
  }
}

// ---- IEEE double facts ----

//an IEEE double carries 53 significand bits, and 2^-1074 is its least representable step
const mantissaBits    = 53;
const minSubnormalExp = -1074;
const maxExactInt     = 2n ** BigInt(mantissaBits);
const bitLength       = (value: bigint) => value.toString(2).length;

//the mantissa can reliably represent log10(2^53) ~= 15 decimal places
const maxReliableDecimals = 15;

// ---- Conversion/Parsing impl ----

//separate alternatives per separator flavor, so "," and "_" cannot mix within one integer
const intPat       = "\\d+|\\d{1,3}(?:,\\d{3})+|\\d{1,3}(?:_\\d{3})+";
const parseBigInt  = (s: string) => BigInt(s.replace(/[,_]/g, ""));
const mixedRegex   = new RegExp(`^(-?)(${intPat}) (${intPat})/(${intPat})$`);
const ratioRegex   = new RegExp(`^(-?)(${intPat})/(${intPat})$`);
const decimalRegex = new RegExp(`^(-?)(${intPat})(?:\\.(\\d+))?(?:[eE]([+-]?\\d+))?$`);
