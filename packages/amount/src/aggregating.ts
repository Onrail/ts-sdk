import type { RoArray, RoTuple, HeadTail } from "@onrail-xyz/utils";
import { type Rationalish, Rational } from "./rational.js";
import type { Kind } from "./kind.js";
import { type Amount, isAmount } from "./amount.js";
import { type Rate, _Rate, isRate } from "./rate.js";

//An aggregate of amounts is an amount of the kind every operand has, or a kind mismatch at
//  runtime; the intersection says so exactly. Two distinct kinds intersect to never (their names
//  are disjoint literals), and an Amount of never is never: the type of a call that cannot return.
//only a fixed tuple's positions witness a kind: a plain array may be empty at runtime, which
//  returns the first operand unchanged, so it narrows nothing (nor, conservatively, does an
//  open-ended tuple)
//the tuple test is against the bare RoTuple: an element constraint in the extends type would
//  leave `[K] extends RoTuple<Kind>` undecided at an open K, since tsc settles a definitely-true
//  check with K's own constraint stripped, and the fold below would stay deferred
export type CommonKind<Ks extends RoArray<Kind>> =
  Ks extends RoTuple
  ? Ks extends HeadTail<Ks, infer H, infer T>
    ? H & CommonKind<T>
    : unknown
  : unknown;

//kinds are inferred through the mapped tuple, so the result is exact even at an open K, where
//  a kind extracted from an Amount<K> would stay a deferred conditional
type AmountsOf<Ks extends RoArray<Kind>> = { readonly [I in keyof Ks]: Amount<Ks[I]> };

//Rates carry two kinds and a pair tuple does not infer, so their kinds are read back from the
//  inferred rate tuple, one side at a time; assignable to Rate<NK, DK> at an open kind, exact at
//  a concrete one
type SideOf<R, S extends 0 | 1> = R extends _Rate<infer NK, infer DK> ? [NK, DK][S] : never;
type SidesOf<Rs extends RoArray, S extends 0 | 1> = { readonly [I in keyof Rs]: SideOf<Rs[I], S> };

type CommonRate<NK extends Kind, DK extends Kind, Rs extends RoArray> =
  Rate<NK & CommonKind<SidesOf<Rs, 0>>, DK & CommonKind<SidesOf<Rs, 1>>>;

export function min<K extends Kind, Ks extends RoArray<Kind>>(
  first:   Amount<K>,
  ...rest: AmountsOf<Ks>
): Amount<K & CommonKind<Ks>>;
export function min<NK extends Kind, DK extends Kind, Rs extends RoArray<Rate<Kind, Kind>>>(
  first:   Rate<NK, DK>,
  ...rest: Rs
): CommonRate<NK, DK, Rs>;
export function min(
  first:   Rationalish,
  ...rest: RoArray<Rationalish>
): Rational;
export function min(
  first:   Amount<Kind> | Rate<Kind, Kind> | Rationalish,
  ...rest: RoArray<Amount<Kind> | Rate<Kind, Kind> | Rationalish>
): Amount<Kind> | Rate<Kind, Kind> | Rational {
  if (isAmount(first) || isRate(first))
    return rest.reduce((acc, value) => (acc as any).le(value) ? acc : value, first) as any;

  return (rest as RoArray<Rationalish>).reduce<Rational>(
    (acc, value) => acc.le(value) ? acc : Rational.from(value), Rational.from(first));
}

export function max<K extends Kind, Ks extends RoArray<Kind>>(
  first:   Amount<K>,
  ...rest: AmountsOf<Ks>
): Amount<K & CommonKind<Ks>>;
export function max<NK extends Kind, DK extends Kind, Rs extends RoArray<Rate<Kind, Kind>>>(
  first:   Rate<NK, DK>,
  ...rest: Rs
): CommonRate<NK, DK, Rs>;
export function max(
  first:   Rationalish,
  ...rest: RoArray<Rationalish>
): Rational;
export function max(
  first:   Amount<Kind> | Rate<Kind, Kind> | Rationalish,
  ...rest: RoArray<Amount<Kind> | Rate<Kind, Kind> | Rationalish>
): Amount<Kind> | Rate<Kind, Kind> | Rational {
  if (isAmount(first) || isRate(first))
    return rest.reduce((acc, value) => (acc as any).ge(value) ? acc : value, first) as any;

  return (rest as RoArray<Rationalish>).reduce<Rational>(
    (acc, value) => acc.ge(value) ? acc : Rational.from(value), Rational.from(first));
}

export function sum<K extends Kind, Ks extends RoArray<Kind>>(
  first:   Amount<K>,
  ...rest: AmountsOf<Ks>
): Amount<K & CommonKind<Ks>>;
export function sum<NK extends Kind, DK extends Kind, Rs extends RoArray<Rate<Kind, Kind>>>(
  first:   Rate<NK, DK>,
  ...rest: Rs
): CommonRate<NK, DK, Rs>;
export function sum(
  first:   Rationalish,
  ...rest: RoArray<Rationalish>
): Rational;
export function sum(
  first:   Amount<Kind> | Rate<Kind, Kind> | Rationalish,
  ...rest: RoArray<Amount<Kind> | Rate<Kind, Kind> | Rationalish>
): Amount<Kind> | Rate<Kind, Kind> | Rational {
  if (typeof first === "number" || typeof first === "bigint")
    first = Rational.from(first);

  return rest.reduce((acc, value) => (acc as any).add(value), first) as any;
}

//three-way comparison, usable directly as an Array.prototype.sort comparator. Its result
//  carries no kind, so nothing can express "the kind both share": the first operand's set of
//  kinds is authoritative and the second must fall within it
export function compare<K extends Kind>(
  a: Amount<K>,
  b: NoInfer<Amount<K>>,
): -1 | 0 | 1;
export function compare<NK extends Kind, DK extends Kind>(
  a: Rate<NK, DK>,
  b: NoInfer<Rate<NK, DK>>,
): -1 | 0 | 1;
export function compare(
  a: Rationalish,
  b: Rationalish,
): -1 | 0 | 1;
export function compare(
  a: Amount<Kind> | Rate<Kind, Kind> | Rationalish,
  b: Amount<Kind> | Rate<Kind, Kind> | Rationalish,
): -1 | 0 | 1 {
  if (typeof a === "number" || typeof a === "bigint")
    a = Rational.from(a);

  if (a instanceof Rational)
    return a.cmp(b as Rationalish);

  //no subtraction: a sort calls this n·log n times, and an amount's or rate's own gt/lt check
  //  the kinds
  const ordered = a as { gt(other: unknown): boolean, lt(other: unknown): boolean };
  return ordered.gt(b) ? 1 : ordered.lt(b) ? -1 : 0;
}

export function clamp<K extends Kind, KL extends Kind, KH extends Kind>(
  x:  Amount<K>,
  lo: Amount<KL>,
  hi: Amount<KH>,
): Amount<K & KL & KH>;
export function clamp<
  NK extends Kind, DK extends Kind,
  NL extends Kind, DL extends Kind,
  NH extends Kind, DH extends Kind,
>(
  x:  Rate<NK, DK>,
  lo: Rate<NL, DL>,
  hi: Rate<NH, DH>,
): Rate<NK & NL & NH, DK & DL & DH>;
export function clamp(
  x:  Rationalish,
  lo: Rationalish,
  hi: Rationalish,
): Rational;
export function clamp(
  x:  Amount<Kind> | Rate<Kind, Kind> | Rationalish,
  lo: Amount<Kind> | Rate<Kind, Kind> | Rationalish,
  hi: Amount<Kind> | Rate<Kind, Kind> | Rationalish,
): Amount<Kind> | Rate<Kind, Kind> | Rational {
  return min(max(x as any, lo as any), hi as any);
}
