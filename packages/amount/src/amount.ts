import type { Brand, NarrowTo, Opts, RoArray } from "@onrail-xyz/utils";
import { brand } from "@onrail-xyz/utils";
import type { Rationalish, ToFixedOptions } from "./rational.js";
import { Rational } from "./rational.js";
import type { Kind, KindWithHuman, SymbolsOf,
              DecimalSymbolsOf, KindUnitSymbols, CandidateKinds } from "./kind.js";
import { getUnit, identifyKind, sameKind } from "./kind.js";
import { Rate, isRate } from "./rate.js";
import { approximate, exact, inUnit, parse as parseFormat } from "./format.js";

export type AmountFromArgs<K extends Kind> = [kind: K, unitSymbol: SymbolsOf<K>];

export const scalar = brand<"scalar">();

//Free functions, not statics: a static is entered with a kind in hand (ofKind, from, parse, the
//  *OfKind guards) and produces or narrows towards an amount of it; these are entered with an
//  amount - or with nothing at all - and recover what the receiver's erased K cannot give back
//  (Amount.md, "Free functions get fresh generic parameters"). rate.ts follows the same split.
//exact kind reads at an open K, where the `kind` property erases
export const kindOf = <K extends Kind>(amount: Amount<K>): K => amount.kind as K;

//class check without touching the underscored class:
//  a union narrows to exactly its amount constituents
//  an open Amount<K> keeps its K
//  an unknown narrows to Amount<Kind>
export const isAmount = <T>(value: T): value is NarrowTo<T, Amount<Kind>> =>
  value instanceof _Amount;

//see end of file for the actual exports
//two Amount spellings:
//  * _Amount<K> is the implementation class that's only exported for type-reachability
//  * Amount<K> (see end of file) is the  distributive alias over it. It's the only spelling that
//      should be used by consumers
//
//Kind-preserving members return this so things match as intended, even when deferred at an open K
export class _Amount<K extends Kind> {
  private readonly value: Rational;
  readonly kind: K;

  private constructor(value: Rational, kind: K) {
    this.value = value;
    this.kind = kind;
  }

  static ofKind<const K extends KindWithHuman>(kind: K):
    (numericalValue: Rationalish | string, unitSymbol?: SymbolsOf<K>) => Amount<K>;
  static ofKind<const K extends Kind>(kind: K):
    (numericalValue: Rationalish | string, unitSymbol: SymbolsOf<K>) => Amount<K>;
  static ofKind(kind: Kind) {
    return (numericalValue: Rationalish | string, unitSymbol?: string) =>
      _Amount.fromInternal(numericalValue, kind, unitSymbol ?? kind.human) as Amount<Kind>;
  }

  static from<const K extends KindWithHuman>(
    numericalValue: Rationalish | string,
    ...args:        [kind: K, unitSymbol?: SymbolsOf<K>]
  ): Amount<K>;
  static from<const K extends Kind>(
    numericalValue: Rationalish | string,
    ...args:        AmountFromArgs<K>
  ): Amount<K>;
  static from<const K extends Kind>(
    numericalValue: Rationalish | string,
    ...args:        [kind: K, unitSymbol?: SymbolsOf<K>]
  ): Amount<K> {
    return _Amount.fromInternal(numericalValue, args[0], args[1]) as Amount<K>;
  }

  //the candidates are inferred as a tuple, not as one K: a single type param would bind to the
  //  first kind and reject every other, which is the whole point of passing several
  static parse<const KS extends RoArray<Kind>>(str: string, ...kinds: KS): Amount<KS[number]> {
    const kind = identifyKind(kinds, str);
    if (!kind)
      throw new Error("Could not identify kind from string");

    const value = parseFormat(kind, str);
    return _Amount.fromInternal(value, kind, kind.standard.unit) as Amount<KS[number]>;
  }

  static isOfKind<
    A extends Amount<Kind>,
    K extends CandidateKinds<A["kind"]>,
  >(amt: A, kind: K): amt is NarrowTo<A, Amount<K>> {
    return sameKind(amt.kind, kind);
  }

  static allOfKind<
    A extends Amount<Kind>,
    K extends CandidateKinds<A["kind"]>,
  >(amts: RoArray<A>, kind: K): amts is RoArray<NarrowTo<A, Amount<K>>> {
    return amts.every(amt => sameKind(amt.kind, kind));
  }

  //instance factories — "an amount of my own kind". The kind-generic replacement for reading
  //  `kind` back and feeding it to ofKind: `kind` erases at an open K, `this` does not.
  zero(): this {
    return new _Amount(Rational.from(0n), this.kind) as this;
  }

  ofSame<S extends SymbolsOf<K>>(numericalValue: Rationalish | string, unitSymbol: S): this {
    return _Amount.fromInternal(numericalValue, this.kind, unitSymbol) as this;
  }

  toString(): string;
  toString(
    system: Extract<keyof K["systems"], string>,
    opts?:  Opts<ToFixedOptions>,
  ): string;
  toString(
    mode:  "approximate" | "exact",
    opts?: Opts<ToFixedOptions & { system: Extract<keyof K["systems"], string> }>,
  ): string;
  toString<S extends SymbolsOf<K>>(
    mode:   "inUnit",
    symbol: S,
    opts?:  Opts<ToFixedOptions & {
      precision: number | (S extends DecimalSymbolsOf<K> ? DecimalSymbolsOf<K> : never);
    }>,
  ): string;
  toString(
    modeOrSys?:    string,
    symbolOrOpts?: SymbolsOf<K> | Opts<ToFixedOptions & { system?: string }>,
    opts?:         Opts<ToFixedOptions & { precision?: number | DecimalSymbolsOf<K> }>,
  ): string {
    if (modeOrSys === "inUnit") {
      const symbol = getUnit(this.kind, symbolOrOpts as SymbolsOf<K>).symbol as KindUnitSymbols<K>;
      const prec = typeof opts?.precision === "string"
        ? getUnit(this.kind, opts.precision as SymbolsOf<K>).symbol as KindUnitSymbols<K>
        : opts?.precision;

      return inUnit(this.kind, this.value, symbol, prec, opts);
    }

    const isMode = !modeOrSys || modeOrSys === "approximate" || modeOrSys === "exact";
    const o = (
      isMode ? symbolOrOpts : { system: modeOrSys, ...(symbolOrOpts as object) }
    ) as Opts<ToFixedOptions & { system?: string }> | undefined;

    return modeOrSys === "exact"
      ? exact      (this.kind, this.value, o)
      : approximate(this.kind, this.value, o);
  }

  toJSON(): string {
    return this.toString("exact");
  }

  in<S extends SymbolsOf<K>>(unitSymbol: S): S extends "atomic" ? bigint : Rational;
  in(unitSymbol: K extends { human: string } ? "human" : never): Rational;
  in(unitSymbol: K extends { atomic: string } ? "atomic" : never): bigint;
  in<S extends SymbolsOf<K>>(unitSymbol: S): S extends "atomic" ? bigint : Rational {
    const rat = this.getIn(unitSymbol);
    return (unitSymbol === "atomic" ? rat.floor() : rat) as S extends "atomic" ? bigint : Rational;
  }

  //the S on the unit-symbol methods might seem pointless, but it's in fact crucial:
  //  a bare SymbolsOf<K> breaks overload/implementation compatibility of the this-returning methods
  //  (the compatibility check relates _Amount<K> to _Amount<Kind>, where only same-shape generic
  //  signatures unify across the deferred SymbolsOf<K> / string constraint divide)
  ceilTo<S extends SymbolsOf<K>>(unitSymbol: S): this {
    return _Amount.fromInternal(this.getIn(unitSymbol).ceil(), this.kind, unitSymbol) as this;
  }

  roundTo<S extends SymbolsOf<K>>(unitSymbol: S): this {
    return _Amount.fromInternal(this.getIn(unitSymbol).round(), this.kind, unitSymbol) as this;
  }

  floorTo<S extends SymbolsOf<K>>(unitSymbol: S): this {
    return _Amount.fromInternal(this.getIn(unitSymbol).floor(), this.kind, unitSymbol) as this;
  }

  isZero(): boolean {
    return this.value.eq(0n);
  }

  sign(): -1 | 0 | 1 {
    return this.value.sign();
  }

  eq(other: this): boolean {
    this.checkKind(other.kind);
    return this.value.eq(other.value);
  }

  ne(other: this): boolean {
    this.checkKind(other.kind);
    return this.value.ne(other.value);
  }

  lt(other: this): boolean {
    this.checkKind(other.kind);
    return this.value.lt(other.value);
  }

  le(other: this): boolean {
    this.checkKind(other.kind);
    return this.value.le(other.value);
  }

  gt(other: this): boolean {
    this.checkKind(other.kind);
    return this.value.gt(other.value);
  }

  ge(other: this): boolean {
    this.checkKind(other.kind);
    return this.value.ge(other.value);
  }

  abs(): this {
    return new _Amount(this.value.abs(), this.kind) as this;
  }

  neg(): this {
    return new _Amount(this.value.neg(), this.kind) as this;
  }

  add(other: this): this {
    this.checkKind(other.kind);
    return new _Amount(this.value.add(other.value), this.kind) as this;
  }

  sub(other: this): this {
    this.checkKind(other.kind);
    return new _Amount(this.value.sub(other.value), this.kind) as this;
  }

  mul(other: Rationalish | Amount<Brand<Kind, "scalar">>): this;
  mul<NK extends Kind>(other: Rate<NK, K>): Amount<NK>;
  mul(other: Rationalish | Amount<Brand<Kind, "scalar">> | Rate<Kind, K>): Amount<Kind> {
    if (isRate(other)) {
      this.checkKind(other.den);
      return new _Amount(this.value.mul(other.ratio), other.num) as Amount<Kind>;
    }
    const rhs = isAmount(other) ? other.value : other;
    return new _Amount(this.value.mul(rhs), this.kind) as Amount<Kind>;
  }

  div(other: Rationalish | Amount<Brand<Kind, "scalar">>): this;
  div<DK extends Kind>(other: Rate<K, DK>): Amount<DK>;
  div(other: Rationalish | Amount<Brand<Kind, "scalar">> | Rate<K, Kind>): Amount<Kind> {
    if (isRate(other)) {
      this.checkKind(other.num);
      return new _Amount(this.value.div(other.ratio), other.den) as Amount<Kind>;
    }
    const rhs = isAmount(other) ? other.value : other;
    return new _Amount(this.value.div(rhs), this.kind) as Amount<Kind>;
  }

  //the quotient of two amounts of one kind, which is a plain number. It is not a `div` overload
  //  because an open K may be instantiated as a union (a tranche kind known only at runtime):
  //  at K1 | K2 an overload for `this` accepts an operand of the other kind - a scalar one
  //  included, which `div` scales by - and no runtime check can tell which of the two readings
  //  the types chose. `div` takes scalars only, and this checks the kind like add and sub do
  ratio(other: this): Rational {
    this.checkKind(other.kind);
    return this.value.div(other.value);
  }

  mod(other: this): this {
    this.checkKind(other.kind);
    return new _Amount(this.value.mod(other.value), this.kind) as this;
  }

  per<const DK extends Kind>(den: KindWithHuman & DK | Amount<DK>): Rate<K, DK> {
    return Rate.from(this as any, den as any);
  }

  private static fromInternal<const K extends Kind>(
    numericalValue: Rationalish | string,
    kind:           K,
    unitSymbol?:    string,
  ): _Amount<K> {
    const unit = getUnit(kind, (unitSymbol ?? "human") as SymbolsOf<K>);
    return new _Amount(Rational.from(numericalValue).mul(unit.scale), kind);
  }

  private getIn(unitSymbol: SymbolsOf<K>): Rational {
    return this.value.div(getUnit(this.kind, unitSymbol).scale);
  }

  private checkKind(otherKind: Kind): void {
    if (!sameKind(this.kind, otherKind))
      throw new Error(`Kind mismatch: ${this.kind.name} vs ${otherKind.name}`);
  }
}

//always distribute because _Amount<KindUnion> is useless
type Amount<K extends Kind> = K extends Kind ? _Amount<K> : never;
const Amount = _Amount;
export { Amount };
