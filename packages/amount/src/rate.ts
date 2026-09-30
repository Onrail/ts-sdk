import type { Opts, MaybeArray, Brand, NarrowTo, RoArray } from "@onrail-xyz/utils";
import { isArray } from "@onrail-xyz/utils";
import type { Rationalish, ToFixedOptions } from "./rational.js";
import { Rational } from "./rational.js";
import type { Kind, KindWithHuman, CandidateKinds,
              SymbolsOf, DecimalSymbolsOf, KindUnitSymbols } from "./kind.js";
import { getUnit, sameKind } from "./kind.js";
import { Amount, isAmount } from "./amount.js";
import { bestDenUnit, exactRate, inUnit, inUnitApprox } from "./format.js";
import { findUnit } from "./segmenting.js";

//most things in here rhyme with Amount and so the rationales transfer

export const numKindOf = <NK extends Kind, DK extends Kind>(rate: Rate<NK, DK>): NK =>
  rate.num as NK;
export const denKindOf = <NK extends Kind, DK extends Kind>(rate: Rate<NK, DK>): DK =>
  rate.den as DK;

export const invert = <NK extends Kind, DK extends Kind>(rate: Rate<NK, DK>): Rate<DK, NK> =>
  rate.inv() as Rate<DK, NK>;

export const isRate = <T>(value: T): value is NarrowTo<T, Rate<Kind, Kind>> =>
  value instanceof _Rate;

export class _Rate<NK extends Kind, DK extends Kind> {
  readonly ratio: Rational;
  readonly num: NK;
  readonly den: DK;

  private constructor(ratio: Rational, num: NK, den: DK) {
    this.ratio = ratio;
    this.num   = num;
    this.den   = den;
  }

  static from<const NK extends Kind, const DK extends Kind>(
    ratio: Rationalish,
    num:   KindWithHuman & NK,
    den:   KindWithHuman & DK,
  ): Rate<NK, DK>;
  static from<const NK extends Kind, const DK extends Kind>(
    num: Amount<NK>,
    den: KindWithHuman & DK | Amount<DK>,
  ): Rate<NK, DK>;
  static from(
    ratioOrNum: Rationalish | Amount<Kind>,
    numOrDen:   KindWithHuman | Amount<Kind>,
    maybeDen?:  KindWithHuman,
  ): any {
    const [amtNum, den] = isAmount(ratioOrNum)
      ? [ratioOrNum, numOrDen]
      : [Amount.from(ratioOrNum, numOrDen as KindWithHuman, "human") as Amount<Kind>, maybeDen];
    const amtDen = isAmount(den)
      ? den
      : Amount.from(1, den as KindWithHuman, "human") as Amount<Kind>;

    return _Rate.checkedNew(
      amtNum.in("standard").div(amtDen.in("standard")),
      amtNum.kind,
      amtDen.kind,
    );
  }

  static parse<const NK extends Kind, const DK extends Kind>(
    str:      string,
    numKinds: MaybeArray<NK>,
    denKinds: MaybeArray<DK>
  ): Rate<NK, DK> {
    const lastSlash = str.lastIndexOf("/");
    if (lastSlash === -1)
      throw new Error("Expected string in format 'numerator/denominator'");

    const numKindsArray = isArray(numKinds) ? numKinds : [numKinds];
    const denKindsArray = isArray(denKinds) ? denKinds : [denKinds];
    const numAmount     = Amount.parse(str.substring(0, lastSlash), ...numKindsArray);
    const denStr        = str.substring(lastSlash + 1);
    const denKindRes    = denKindsArray.filter(k => findUnit(k.units, denStr) !== undefined);
    if (denKindRes.length !== 1)
      throw new Error("Could not identify denominator kind from string");

    const denKind = denKindRes[0]!;
    const denUnit = findUnit(denKind.units, denStr)!;
    const ratio   = numAmount.in("standard").div(denUnit.scale);

    return _Rate.checkedNew(ratio, numAmount.kind as NK, denKind);
  }

  static hasNum<R extends Rate<Kind, Kind>, K extends CandidateKinds<R["num"]>>(
    rate:    R,
    numKind: K,
  ): rate is NarrowTo<R, Rate<K, Kind>> {
    return sameKind(rate.num, numKind);
  }

  static hasDen<R extends Rate<Kind, Kind>, K extends CandidateKinds<R["den"]>>(
    rate:    R,
    denKind: K,
  ): rate is NarrowTo<R, Rate<Kind, K>> {
    return sameKind(rate.den, denKind);
  }

  static allHaveNum<R extends Rate<Kind, Kind>, K extends CandidateKinds<R["num"]>>(
    rates:   RoArray<R>,
    numKind: K,
  ): rates is RoArray<NarrowTo<R, Rate<K, Kind>>> {
    return rates.every(rate => sameKind(rate.num, numKind));
  }

  static allHaveDen<R extends Rate<Kind, Kind>, K extends CandidateKinds<R["den"]>>(
    rates:   RoArray<R>,
    denKind: K,
  ): rates is RoArray<NarrowTo<R, Rate<Kind, K>>> {
    return rates.every(rate => sameKind(rate.den, denKind));
  }

  zero(): this {
    return new _Rate(Rational.from(0n), this.num, this.den) as this;
  }

  ofSame<NS extends SymbolsOf<NK>, DS extends SymbolsOf<DK>>(
    numericalValue: Rationalish | string,
    numUnit:        NS,
    denUnit:        DS,
  ): this {
    const num = getUnit(this.num, numUnit);
    const den = getUnit(this.den, denUnit);
    return new _Rate(
      Rational.from(numericalValue).mul(num.scale).div(den.scale),
      this.num,
      this.den,
    ) as this;
  }

  toString<
    NS extends SymbolsOf<NK> = SymbolsOf<NK>,
    DS extends SymbolsOf<DK> = SymbolsOf<DK>,
  >(opts?: Opts<ToFixedOptions & {
    numSymbol: NS;
    denSymbol: DS;
    precision: number | (NS extends DecimalSymbolsOf<NK> ? DecimalSymbolsOf<NK> : never);
  }>): string;
  toString(mode: "exact", opts?: Opts<ToFixedOptions>): string;
  toString(
    modeOrOpts?: "exact" | Opts<ToFixedOptions & {
      numSymbol: SymbolsOf<NK>;
      denSymbol: SymbolsOf<DK>;
      precision: number | DecimalSymbolsOf<NK>;
    }>,
    exactOpts?:  Opts<ToFixedOptions>,
  ): string {
    if (modeOrOpts === "exact")
      return exactRate(this.num, this.den, this.ratio, exactOpts);

    const opts = modeOrOpts;
    const numSym  = (opts?.numSymbol ?? this.num.human ?? this.num.standard.unit) as SymbolsOf<NK>;
    const numUnit = getUnit(this.num, numSym);
    const denUnit = opts?.denSymbol !== undefined
      ? getUnit(this.den, opts.denSymbol)
      : bestDenUnit(this.num, this.den, this.ratio);
    const stdVal  = this.ratio.mul(denUnit.scale);
    const prec    = typeof opts?.precision === "string"
      ? getUnit(this.num, opts.precision as SymbolsOf<NK>).symbol as KindUnitSymbols<NK>
      : opts?.precision;

    const numSymbol = numUnit.symbol as KindUnitSymbols<NK>;
    const num = prec === undefined
      ? inUnitApprox(this.num, stdVal, numSymbol, opts)
      : inUnit(this.num, stdVal, numSymbol, prec, opts);
    return `${num}/${denUnit.symbol}`;
  }

  toJSON(): string {
    return this.toString("exact");
  }

  in<NS extends SymbolsOf<NK>, DS extends SymbolsOf<DK>>(numUnit: NS, denUnit: DS): Rational {
    const num = getUnit(this.num, numUnit);
    const den = getUnit(this.den, denUnit);
    return this.ratio.mul(den.scale).div(num.scale);
  }

  ceilTo<NS extends SymbolsOf<NK>, DS extends SymbolsOf<DK>>(numUnit: NS, denUnit: DS): this {
    return this.ofSame(this.in(numUnit, denUnit).ceil(), numUnit, denUnit);
  }

  roundTo<NS extends SymbolsOf<NK>, DS extends SymbolsOf<DK>>(numUnit: NS, denUnit: DS): this {
    return this.ofSame(this.in(numUnit, denUnit).round(), numUnit, denUnit);
  }

  floorTo<NS extends SymbolsOf<NK>, DS extends SymbolsOf<DK>>(numUnit: NS, denUnit: DS): this {
    return this.ofSame(this.in(numUnit, denUnit).floor(), numUnit, denUnit);
  }

  isZero(): boolean {
    return this.ratio.eq(0n);
  }

  sign(): -1 | 0 | 1 {
    return this.ratio.sign();
  }

  eq(other: this): boolean {
    this.checkKinds(other);
    return this.ratio.eq(other.ratio);
  }

  ne(other: this): boolean {
    this.checkKinds(other);
    return this.ratio.ne(other.ratio);
  }

  lt(other: this): boolean {
    this.checkKinds(other);
    return this.ratio.lt(other.ratio);
  }

  le(other: this): boolean {
    this.checkKinds(other);
    return this.ratio.le(other.ratio);
  }

  gt(other: this): boolean {
    this.checkKinds(other);
    return this.ratio.gt(other.ratio);
  }

  ge(other: this): boolean {
    this.checkKinds(other);
    return this.ratio.ge(other.ratio);
  }

  abs(): this {
    return new _Rate(this.ratio.abs(), this.num, this.den) as this;
  }

  neg(): this {
    return new _Rate(this.ratio.neg(), this.num, this.den) as this;
  }

  add(other: this): this {
    this.checkKinds(other);
    return new _Rate(this.ratio.add(other.ratio), this.num, this.den) as this;
  }

  sub(other: this): this {
    this.checkKinds(other);
    return new _Rate(this.ratio.sub(other.ratio), this.num, this.den) as this;
  }

  mul(scalar: Rationalish | Amount<Brand<Kind, "scalar">>): this {
    scalar = isAmount(scalar) ? scalar.in("standard") : scalar as Rationalish;
    return new _Rate(this.ratio.mul(scalar), this.num, this.den) as this;
  }

  div(scalar: Rationalish | Amount<Brand<Kind, "scalar">>): this {
    scalar = isAmount(scalar) ? scalar.in("standard") : scalar as Rationalish;
    return new _Rate(this.ratio.div(scalar), this.num, this.den) as this;
  }

  inv(): Rate<DK, NK> {
    return new _Rate(this.ratio.inv(), this.den, this.num) as Rate<DK, NK>;
  }

  combine<
    NKO extends DK,
    DKO extends Kind,
  >(other: Rate<NKO, DKO>): Rate<NK, DKO> {
    if (!sameKind(this.den, other.num))
      throw new Error(`Kind mismatch: ${this.den.name} vs ${other.num.name}`);

    return _Rate.checkedNew(this.ratio.mul(other.ratio), this.num, other.den);
  }

  cancel(other: Rate<DK, NK>): Rational {
    if (!sameKind(this.den, other.num) || !sameKind(this.num, other.den))
      throw new Error(
        `Kind mismatch: ${this.den.name}/${this.num.name} vs ${other.num.name}/${other.den.name}`
      );

    return this.ratio.mul(other.ratio);
  }

  private checkKinds(other: _Rate<NK, DK>): void {
    if (!sameKind(this.num, other.num) || !sameKind(this.den, other.den))
      throw new Error(
        `Kind mismatch: ${this.num.name}/${this.den.name} vs ${other.num.name}/${other.den.name}`
      );
  }

  private static checkedNew<
    NK extends Kind,
    DK extends Kind,
  >(ratio: Rational, num: NK, den: DK): Rate<NK, DK> {
    if (sameKind(num, den))
      throw new Error(`Must be distinct kinds: ${num.name} vs ${den.name}`);

    return new _Rate(ratio, num, den) as Rate<NK, DK>;
  }
}

//always distribute, like Amount. The `[DK] extends [never]` guard is for an intersection of
//  distinct kinds handed in as the denominator (what an aggregate over mismatched rates yields):
//  tsc reduces such an intersection to never only on the way into the outermost conditional -
//  the inner one is reached by tail recursion (canTailRecurse in checker.ts), which passes the
//  check type through unreduced, so the intersection would land in _Rate instead of collapsing
//  the rate. The tuple check relates by assignability, which does reduce.
type Rate<NK extends Kind, DK extends Kind> =
  NK extends Kind
    ? [DK] extends [never]
      ? never
      : DK extends Kind
      ? _Rate<NK, DK>
      : never
    : never;
const Rate = _Rate;
export { Rate };
