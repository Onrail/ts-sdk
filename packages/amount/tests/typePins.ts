//Compile-time pins for the polymorphic-`this` member typing of _Amount.
//
//The pins were first established against a mock during the design probe; this file re-measures
//  them against the shipped class. CFA hazard baked into the structure: assignments to a
//  let-variable narrow it and contaminate every measurement downstream (the probe's first pass
//  fell for this), so union-typed receivers here are consts.
import type { Identity } from "@onrail-xyz/utils";
import type { Kind, KindWithAtomic, KindWithHumanAndAtomic, SymbolsOf } from "../src/kind.js";
import { kind } from "../src/kind.js";
import type { Rational, Rationalish } from "../src/rational.js";
import { type Rate, invert, numKindOf, denKindOf, Rate as RateClass } from "../src/rate.js";
import { Amount, _Amount, kindOf, scalar } from "../src/amount.js";
import { max, min, sum, clamp, compare } from "../src/aggregating.js";
import { toDecimalUnits, toScaleUnits } from "../src/unitSpecs.js";
import { pinEq } from "./typeAssert.js";

type KWHA = KindWithHumanAndAtomic;

//kinds shaped exactly like downstream token kinds (kind() + Identity interface wrap)
const _eth = kind(
  "Ether",
  [{ symbols: [{ symbol: "ETH" }] }, { symbols: [{ symbol: "wei" }], oom: -18 }],
  { human: "ETH", atomic: "wei" },
);
interface EthKind extends Identity<typeof _eth> {}

const _btc = kind(
  "Bitcoin",
  [{ symbols: [{ symbol: "BTC" }] }, { symbols: [{ symbol: "sat" }], oom: -8 }],
  { human: "BTC", atomic: "sat" },
);
interface BtcKind extends Identity<typeof _btc> {}

const _us = kind(
  "Usdc",
  [{ symbols: [{ symbol: "USDC" }] }, { symbols: [{ symbol: "µUSDC" }], oom: -6 }],
  { human: "USDC", atomic: "µUSDC" },
);
interface UsdcKind extends Identity<typeof _us> {}

const Pct = scalar(kind(
  "Percentage",
  [{ symbols: [{ symbol: "x" }] }, { symbols: [{ symbol: "%" }], oom: -2 }],
  { human: "%" },
));

declare const eAmt: Amount<EthKind>;
declare const bAmt: Amount<BtcKind>;
declare const uAmt: Amount<UsdcKind>;
declare const pAmt: Amount<typeof Pct>;
declare const rat:  Rational;
declare const un:   Amount<EthKind | BtcKind>;
declare const usdcPerEth: Rate<UsdcKind, EthKind>;

//---- P0: concrete kinds ----
{
  const a = eAmt.add(eAmt);
  pinEq<typeof a, Amount<EthKind>>(true);
  const d = eAmt.ratio(eAmt);
  pinEq<typeof d, Rational>(true);
  // @ts-expect-error div takes scalars only: a same-kind quotient is ratio
  eAmt.div(eAmt);
  const f = eAmt.floorTo("atomic");
  pinEq<typeof f, Amount<EthKind>>(true);
  const i = eAmt.in("atomic");
  pinEq<typeof i, bigint>(true);

  // @ts-expect-error kind mixing rejected at concrete kinds
  eAmt.add(bAmt);
  // @ts-expect-error bogus unit symbol rejected at concrete kinds
  eAmt.floorTo("bogus");
}

//---- P1: open K — `this` binds to the deferred conditional, so K survives ----
const p1 = <K extends KWHA>(x: Amount<K>) => {
  const m: Amount<K> = x.mul(rat);           //scalar mul: this-return, no cast
  const f: Amount<K> = m.floorTo("atomic");  //unit literal accepted (see P7), K kept
  const z: Amount<K> = x.zero();             //instance factory preserves K
  const o: Amount<K> = x.ofSame(1, "atomic");
  //property access has no `this` to bind in `kind: K` — it erases to the constraint
  // @ts-expect-error KWHA is not assignable to K
  const k: K = x.kind;
  return { m, f, z, o };
};
{
  type P1 = ReturnType<typeof p1<EthKind>>;
  pinEq<P1["m"], Amount<EthKind>>(true);  //externally: K, not the constraint
}

//---- P2: open K — binary ops stay tight across distinct type params ----
const p2 = <K extends KWHA, K2 extends KWHA>(x: Amount<K>, y: Amount<K>, w: Amount<K2>) => {
  const s: Amount<K> = x.add(y);  //same-K operand accepted, result keeps K
  x.eq(y);
  // @ts-expect-error cross-K operand rejected (the param is literally Amount<K>)
  x.add(w);
  const dv: Rational = x.ratio(y);
  // @ts-expect-error at open K the operand is no scalar, so div rejects it rather than guessing
  x.div(y);
  const mn: Amount<K> = min(x, y);
  const mx: Amount<K> = max(x, y);
  const ab: Amount<K> = x.abs();
  const sm: Amount<K> = sum(x, y);
  const ng: Amount<K> = x.neg();
  //an aggregate is of the kind every operand has: at open params that is their intersection
  const cross = min(x, w);
  pinEq<typeof cross, Amount<K & K2>>(true);
  //the Rational overload of the same family
  const rm: Rational = min(rat, 2n, 0.5);
  void [mn, mx, ab, sm, ng, rm];
  return s;
};

//---- P3: closed union — alias semantics preserved ----
{
  let sink: Amount<EthKind | BtcKind>;
  sink = eAmt;  //distribution: single-kind values flow into the union
  sink = bAmt;
  void sink;

  // @ts-expect-error forced narrowing: union operand rejected (params intersect)
  un.eq(un);
  // @ts-expect-error forced narrowing: single-kind operand rejected pre-narrow
  un.eq(eAmt);

  if (Amount.isOfKind(un, _eth)) {
    un.eq(eAmt);                             //direct call on the narrowed reference
    const nf: Amount<EthKind> = un.floorTo("atomic");
    void nf;
  }

  const uz = un.zero();                      //un-narrowed union receiver: distributes
  pinEq<typeof uz, Amount<EthKind | BtcKind>>(true);
  pinEq<typeof un.kind, EthKind | BtcKind>(true);

  //the generic S on unit-symbol methods makes them uncallable on a union receiver — a union of
  //  generic signatures does not synthesize a call signature; narrowing first is required
  // @ts-expect-error union of generic signatures is not callable
  un.floorTo("atomic");
}

//---- P4: kind-generic free functions infer from concrete AND union arguments ----
declare const implK: <K extends KWHA>(supply: Amount<K>, scale: Rational) => Amount<K>;
{
  pinEq<ReturnType<typeof implK<EthKind>>, Amount<EthKind>>(true);
  const rKU = implK(un, rat);   //union arg, no explicit instantiation
  pinEq<typeof rKU, Amount<EthKind | BtcKind>>(true);
}

//---- P5: kind-changing Rate overloads ----
{
  const u2 = eAmt.mul(usdcPerEth);
  pinEq<typeof u2, Amount<UsdcKind>>(true);
  const s2 = uAmt.div(usdcPerEth);
  pinEq<typeof s2, Amount<EthKind>>(true);
}

//---- P6: consumer shapes that previously required casts, now cast-free ----
const toTokens = <K extends KWHA>(
  assets: Amount<UsdcKind>,
  supply: Amount<K>,
  claim:  Amount<UsdcKind>
): Amount<K> => {
  if (claim.eq(claim.zero()))
    return supply.zero();
  return supply.mul(assets.ratio(claim)).floorTo("atomic");
};
{
  const t = toTokens(uAmt, eAmt, uAmt);
  pinEq<typeof t, Amount<EthKind>>(true);
  const tu = toTokens(uAmt, un, uAmt);  //union supply infers K = EthKind | BtcKind
  pinEq<typeof tu, Amount<EthKind | BtcKind>>(true);
}
const accumulate = <K extends KWHA>(items: readonly { owner: string; amount: Amount<K> }[]) => {
  const totals = new Map<string, Amount<K>>();
  for (const { owner, amount } of items) {
    const running = totals.get(owner);
    totals.set(owner, running ? running.add(amount) : amount);
  }
  return totals;
};
void accumulate;

//---- P7: unit-symbol params are exact at an open K — only what the constraint promises ----
//Calls at an open K check against the apparent type, i.e. the constraint; SymbolsOf of a
//  promising constraint exposes just its meta symbols (kind.ts's three regimes). The obvious
//  Extract<keyof K["units"], string> degrades to string there, so a bogus symbol compiles and
//  throws at runtime.
const p7 = <K extends KWHA>(x: Amount<K>) => {
  x.floorTo("atomic");
  x.floorTo("human");
  x.floorTo("standard");
  const b: bigint = x.in("atomic");
  void b;
  // @ts-expect-error bogus unit symbols are rejected at an open K
  x.floorTo("bogus");
  // @ts-expect-error kind-specific unit symbols are not guaranteed by the constraint
  x.floorTo("ETH");
};
void p7;
const p7a = <K extends KindWithAtomic>(x: Amount<K>) => {
  x.floorTo("atomic");
  // @ts-expect-error human is not promised by a KindWithAtomic constraint
  x.floorTo("human");
};
void p7a;

//---- P8: a scalar amount divided by its own kind stays scalar; ratio is the quotient ----
{
  const r = pAmt.ratio(pAmt);
  pinEq<typeof r, Rational>(true);
  const q = pAmt.div(pAmt);
  pinEq<typeof q, Amount<typeof Pct>>(true);
  const p = pAmt.div(2n);
  pinEq<typeof p, Amount<typeof Pct>>(true);
  const s = eAmt.div(pAmt);   //scalar operand on a non-scalar receiver: stays in kind
  pinEq<typeof s, Amount<EthKind>>(true);
}

//---- P9: _Rate gets the same treatment ----
const combineOpenDen = <K extends Kind>(other: Rate<EthKind, K>): Rate<UsdcKind, K> =>
  usdcPerEth.combine(other);
const combineOpenKinds = <N extends Kind, M extends Kind, D extends Kind>(
  rate: Rate<N, M>, other: Rate<M, D>,
): Rate<Kind, D> => rate.combine(other);
const cancelOpenKinds = <N extends Kind, D extends Kind>(
  rate: Rate<N, D>, other: Rate<D, N>,
): Rational => rate.cancel(other);
{
  const result = usdcPerEth.cancel(usdcPerEth.inv());
  pinEq<typeof result, Rational>(true);
  // @ts-expect-error cancellation requires reciprocal kinds
  usdcPerEth.cancel(usdcPerEth);
}

const p9 = <NK extends KWHA, DK extends KWHA>(c: Rate<NK, DK>, r: Rational) => {
  const m: Rate<NK, DK> = c.mul(r);  //this-return survives the deferred receiver
  c.eq(m);
  // @ts-expect-error kind-swapping results have no this-spelling and erase at an open kind
  const i: Rate<DK, NK> = c.inv();
  return m;
};
void p9;
{
  const m = usdcPerEth.mul(rat);           //concrete kinds: exact, including the swap
  pinEq<typeof m, Rate<UsdcKind, EthKind>>(true);
  const i = usdcPerEth.inv();
  pinEq<typeof i, Rate<EthKind, UsdcKind>>(true);
}

//---- P9b: kind surgery through same-alias inference ----
//`this` binds exactly but is atomic — no Swap<this>. The transparent channel for swaps,
//  projections, and recombinations is a free function whose parameter is the same alias as the
//  argument: inference proceeds pairwise through the deferred conditionals. Measured against
//  the shipped surgery functions themselves.
const p9b = <NK extends KWHA, DK extends KWHA>(c: Rate<NK, DK>, a: Amount<NK>) => {
  const i:  Rate<DK, NK> = invert(c);         //transparent at an open kind pair
  const rt: Rate<NK, DK> = invert(invert(c)); //round trip
  const n:  NK = numKindOf(c);                      //projection
  const d:  DK = denKindOf(c);
  const nd: DK = numKindOf(invert(c));              //surgery composes
  const k:  NK = kindOf(a);
  return { i, rt, n, d, nd, k };
};
void p9b;
declare const unC: Rate<UsdcKind, EthKind | BtcKind>;
{
  const i = invert(usdcPerEth);
  pinEq<typeof i, Rate<EthKind, UsdcKind>>(true);
  pinEq<ReturnType<typeof kindOf<EthKind>>, EthKind>(true);

  //the caveat: multi-parameter surgery does not infer from union-typed arguments (inference
  //  lands on a single constituent) — instantiate explicitly there
  // @ts-expect-error union argument infers a single constituent, not the union
  invert(unC);
  invert<UsdcKind, EthKind | BtcKind>(unC);   //explicit instantiation works
}

//---- P10: the union CLASS stays reachable by explicit widening ----
//(its binary ops then accept either kind, backstopped by checkKind at runtime; the alias being
//  the only signature spelling is what keeps this from occurring naturally)
{
  const w: _Amount<EthKind | BtcKind> = eAmt;
  void w;
}

//---- P11: from's parameter list is a plain tuple ----
//The distributive `K extends any ? [kind: K, unitSymbol?: SymbolsOf<K>] : never` fails both
//  non-trivial regimes: at an open K a deferred conditional target whose branches mention K
//  relates to nothing (isDistributionDependent — canary below), and at a closed union a tuple of
//  a union is no union of tuples. SymbolsOf already narrows a union to its common symbols, so
//  the plain tuple keeps the unit/kind correlation the distribution was meant to buy.
const p11 = <K extends Kind>(v: Rationalish, k: K, u: SymbolsOf<K>): Amount<K> =>
  Amount.from(v, k, u);
void p11;
declare const eitherKind: EthKind | BtcKind;
{
  const a = Amount.from(1, eitherKind, "atomic");
  pinEq<typeof a, Amount<EthKind | BtcKind>>(true);
  // @ts-expect-error "wei" is not a symbol of every constituent
  Amount.from(1, eitherKind, "wei");

  //canary for the compiler rule the section rests on
  type Dep<K> = K extends any ? [x: K] : never;
  const dep = <K>(x: [K]): Dep<K> =>
    // @ts-expect-error a deferred conditional target whose branches mention K relates to nothing
    x;
  void dep;
}

//---- P12: a shared K unites only what already is a union ----
//Inference takes K from the first candidate and rejects a later distinct kind; it widens only
//  for a later candidate that contains the first (a union-typed argument), which is what the
//  aggregators' NoInfer shuts. An explicit instantiation admits one amount of each kind and
//  leaves the mismatch to checkKind.
const sameK = <K extends Kind>(x: Amount<K>, y: Amount<K>) => x.add(y);
const firstK = <K extends Kind>(x: Amount<K>, y: Amount<NoInfer<K>>) => x.add(y);
{
  // @ts-expect-error two distinct kinds do not unite: K is EthKind, the BTC amount is rejected
  sameK(eAmt, bAmt);
  const widened = sameK(eAmt, un);
  pinEq<typeof widened, Amount<EthKind | BtcKind>>(true);
  // @ts-expect-error NoInfer keeps K at the first argument's kind
  firstK(eAmt, un);
  const explicit = sameK<EthKind | BtcKind>(eAmt, bAmt);
  pinEq<typeof explicit, Amount<EthKind | BtcKind>>(true);
}

//---- P13: aggregators return the common kind ----
//The result is an amount of the kind every operand has, or a kind mismatch at runtime, so its
//  type is the intersection of the operands' kinds: a union operand narrows to what the others
//  admit, two distinct kinds give never (the type of a call that cannot return), and generic
//  code keeps K. compare has no result to carry that, so it keeps the first operand's set of
//  kinds as authoritative.
declare const usdcPerBtc: Rate<UsdcKind, BtcKind>;
declare const usdcPerEither: Rate<UsdcKind, EthKind | BtcKind>;
declare const ethPerUsdc: Rate<EthKind, UsdcKind>;
declare const ethList: Amount<EthKind>[];
declare const usdcPerBtcList: Rate<UsdcKind, BtcKind>[];
{
  const a1 = sum(un, eAmt);        pinEq<typeof a1, Amount<EthKind>>(true);
  const a2 = sum(eAmt, un);        pinEq<typeof a2, Amount<EthKind>>(true);
  const a3 = sum(eAmt, bAmt);      pinEq<typeof a3, never>(true);
  const a4 = sum(un, un);          pinEq<typeof a4, Amount<EthKind | BtcKind>>(true);
  const a5 = sum(un, ...ethList);  pinEq<typeof a5, Amount<EthKind | BtcKind>>(true);
  const a6 = min(un, eAmt, un);    pinEq<typeof a6, Amount<EthKind>>(true);
  const a7 = clamp(un, eAmt, un);  pinEq<typeof a7, Amount<EthKind>>(true);
  //a spread array may be empty, returning the first operand as is
  const a8 = sum(bAmt, ...ethList); pinEq<typeof a8, Amount<BtcKind>>(true);
  const r1 = sum(usdcPerEth, usdcPerEth);
  pinEq<typeof r1, Rate<UsdcKind, EthKind>>(true);
  const r2 = sum(usdcPerEth, usdcPerBtc);
  pinEq<typeof r2, never>(true);
  const r3 = sum(usdcPerEth, ethPerUsdc);
  pinEq<typeof r3, never>(true);
  const r4 = max(usdcPerEth, usdcPerEither);
  pinEq<typeof r4, Rate<UsdcKind, EthKind>>(true);
  const r5 = clamp(usdcPerEth, usdcPerEth, usdcPerBtc);
  pinEq<typeof r5, never>(true);
  const r6 = sum(usdcPerEth, ...usdcPerBtcList);
  pinEq<typeof r6, Rate<UsdcKind, EthKind>>(true);
  compare(un, eAmt);
  // @ts-expect-error the second operand must fall within the first's kinds
  compare(eAmt, un);
  void [a1, a2, a3, a4, a5, a6, a7, a8, r1, r2, r3, r4, r5, r6];
}
const p13 = <N extends Kind, D extends Kind>(x: Rate<N, D>, ys: Rate<N, D>[]): Rate<N, D> =>
  sum(x, ...ys).mul(2);
const p13c = <N extends Kind, D extends Kind>(x: Rate<N, D>, lo: Rate<N, D>, hi: Rate<N, D>) => {
  const c = clamp(x, lo, hi);
  pinEq<typeof c, Rate<N, D>>(true);
  return c;
};
void p13c;
void p13;
//the Rate alias collapses an intersection of distinct kinds on either side: the numerator through
//  the outer conditional's own reduction, the denominator through the explicit never guard
//  (tail recursion into the inner conditional skips the reduction - see rate.ts)
pinEq<Rate<EthKind & BtcKind, UsdcKind>, never>(true);
pinEq<Rate<UsdcKind, EthKind & BtcKind>, never>(true);
void RateClass;

//---- P14: unit-definition helpers stay inside the unit-spec domain ----
//regression: the rows once accepted any Rationalish and any tuple, so a bigint exponent or an
//  empty symbol list only failed at the kind() call the result fed
{
  const rows = toDecimalUnits([[0, [{ symbol: "FOO" }]], [-6, [{ symbol: "µFOO" }]]]);
  pinEq<(typeof rows)[1]["symbols"][0]["symbol"], "µFOO">(true);
  const scaled = toScaleUnits([[1n, [{ symbol: "s" }]], [1 / 8, [{ symbol: "bit" }]]]);
  pinEq<(typeof scaled)[1]["scale"], number>(true);
  // @ts-expect-error a decimal exponent is a number
  toDecimalUnits([[1n, [{ symbol: "z" }]]]);
  // @ts-expect-error a row needs at least one symbol
  toDecimalUnits([[0, []]]);
  // @ts-expect-error a symbol entry is a SymbolSpec
  toScaleUnits([[60, ["minute"]]]);
  void rows; void scaled;
}
