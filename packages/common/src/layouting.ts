import type { Function, OptionalArg } from "@onrail-xyz/utils";
import { bignum } from "@onrail-xyz/utils";
import type { Item, Conversion, NumSizeToPrimitive } from "@onrail-xyz/binary-layout";
import { checkFitsInBits, numberMaxSize, withCustom } from "@onrail-xyz/binary-layout";
import type { Rationalish, Kind,
              KindWithHuman, KindWithAtomic, SymbolsOf } from "@onrail-xyz/amount";
import { Amount, Rate, Rational, getUnit, sameKind } from "@onrail-xyz/amount";

export const hashItem = {
  binary: "bytes", size: 32,
} as const satisfies Item;

// ---- Amount / Rate / Linear Transform ----

//`To` narrows what `to` returns: amountItem takes any Rationalish (Amount.from accepts it as is),
//  while linearTransform returns exactly a Rational, which makes its transforms valid Conversions
//  in their own right
export type TransformFunc<S extends number, To extends Rationalish = Rationalish> = {
  to:   Function<[NumSizeToPrimitive<S>], To            >;
  from: Function<[Rational],       NumSizeToPrimitive<S>>;
};

export type SizedTransformFunc<S extends number, R extends Rationalish = Rationalish> =
  Function<[S], TransformFunc<S, R>>;

export type TransformFuncUnion<S extends number> = TransformFunc<S> | SizedTransformFunc<S>;

//a number-sized field checks its width before narrowing, so that an overflow reads the same
//  whether or not the value would also leave the safe-integer range
function numericReturn<S extends number>(size: S): TransformFunc<S>["from"] {
  return size > numberMaxSize
    ? (val: Rational) => val.floor() as NumSizeToPrimitive<S>
    : (val: Rational) => {
      const floored = val.floor();
      checkFitsInBits(floored, 8 * size, false);
      return bignum.toNumber(floored) as NumSizeToPrimitive<S>;
    };
}

type PlainUintItem<S extends number> =
  ({ binary: "uint"; size: S; }) extends
    infer R extends Item ? R : never;

export type CustomUintItem<S extends number, To> =
  (PlainUintItem<S> & { custom: Conversion<NumSizeToPrimitive<S>, To> }) extends
    infer R extends Item ? R : never;

type NumTransformFuncUnion<S extends number, R> =
  Function<[S], Conversion<NumSizeToPrimitive<S>, R>> | Conversion<NumSizeToPrimitive<S>, R>

//the item a kind that may be absent yields; a transform-only item is a `CustomUintItem` of
//  whatever its conversion returns, which is not read as a kind however it looks
export type AmountItem<S extends number, K extends Kind | undefined = undefined> =
  K extends Kind ? CustomUintItem<S, Amount<K>> : PlainUintItem<S>;
//a present kind yields the CustomUintItem directly rather than through AmountItem: at an open K
//  the conditional stays deferred, and so does the DeriveType of every layout holding the item,
//  where the direct form derives Amount<K>
export function amountItem<S extends number, const K extends KindWithAtomic>(
  size: S,
  kind: K,
): CustomUintItem<S, Amount<K>>;
export function amountItem<
        S extends number,
  const K extends KindWithAtomic | undefined = undefined,
>(size:      S,
  ...[kind]: OptionalArg<K>
): AmountItem<S, K>;
export function amountItem<S extends number, R>(
  size:      S,
  transform: NumTransformFuncUnion<S, R>,
): CustomUintItem<S, R>;
export function amountItem<S extends number, const K extends KindWithAtomic>(
  size:                   S,
  kind:                   K, //uses "atomic" by default
  unitSymbolOrTransform?: SymbolsOf<K> | TransformFuncUnion<S>,
): CustomUintItem<S, Amount<K>>;
export function amountItem<S extends number, const K extends Kind>(
  size:       S,
  kind:       K,
  unitSymbol: SymbolsOf<K>,
  transform?: TransformFuncUnion<S>,
): CustomUintItem<S, Amount<K>>;
export function amountItem<S extends number, const K extends Kind>(
  size:                   S,
  kind?:                  K | NumTransformFuncUnion<S, unknown>,
  unitSymbolOrTransform?: SymbolsOf<K> | TransformFuncUnion<S>,
  transform?:             TransformFuncUnion<S>,
): any {
  if (!kind || typeof kind === "function" || "to" in kind) {
    const tf = kind as NumTransformFuncUnion<S, unknown> | undefined;
    return {
      binary: "uint", size,
      ...(tf ? { custom: typeof tf === "function" ? tf(size) : tf } : {})
    };
  }

  let symbol: SymbolsOf<K> | undefined;
  if (transform)
    symbol = unitSymbolOrTransform as SymbolsOf<K>;
  else if (typeof unitSymbolOrTransform === "string")
    symbol = unitSymbolOrTransform;
  else if (unitSymbolOrTransform)
    transform = unitSymbolOrTransform;

  //resolved against the item's kind once, here: a meta symbol left for `in` to resolve would
  //  resolve against whatever kind the amount has, and an unknown one would only surface on use
  const unitSymbol = getUnit(kind, (symbol ?? "atomic") as SymbolsOf<K>).symbol as SymbolsOf<K>;

  if (typeof transform === "function")
    transform = transform(size);

  transform ??= { to: (val: Rationalish) => val, from: numericReturn(size) };

  //the type establishes the kind unless K is a union: then the item accepts an amount of any of
  //  its members, and `in` looks the symbol up on the amount's kind, not the item's, so a
  //  sibling kind sharing the symbol would encode silently - the same backstop `add` and its
  //  siblings rely on (a rateItem's numerator passes through here too)
  const custom = {
    to:   (val:    NumSizeToPrimitive<S>): Amount<K> =>
            Amount.from(transform.to(val), kind, unitSymbol),
    from: (amount: Amount<K>): NumSizeToPrimitive<S> => {
      if (!sameKind(amount.kind, kind))
        throw new Error(`Kind mismatch: item holds ${kind.name}, got ${amount.kind.name}`);
      return transform.from(amount.in(unitSymbol) as Rational);
    },
  };

  return { binary: "uint", size, custom } as any;
}

type WidenedAmountItem = {
  binary: "uint";
  size:   number;
  custom: Conversion<any, Amount<any>>;
};

export type RateItem<S extends number, NK extends Kind, DK extends Kind> =
  CustomUintItem<S, Rate<NK, DK>>;

//spelled out rather than as CustomUintItem<number, Amount<Kind>>, which evaluates to never at an
//  open size; and a Conversion takes its value type as `from`'s parameter, so no item of a
//  concrete kind satisfies Amount<Kind> there - hence Amount<any>, with the numerator kind read
//  off the item's conversion
type NumeratorKind<AI extends WidenedAmountItem> =
  AI extends { custom: Conversion<any, Amount<infer NK extends Kind>> } ? NK : never;

export function rateItem<const AI extends WidenedAmountItem, const DK extends KindWithHuman>(
  amntItem: AI,
  denKind:  DK, //uses "human" unit by default
): RateItem<AI["size"], NumeratorKind<AI>, DK>;
export function rateItem<const AI extends WidenedAmountItem, const DK extends Kind>(
  amntItem: AI,
  denKind:  DK,
  denUnit:  SymbolsOf<DK>,
): RateItem<AI["size"], NumeratorKind<AI>, DK>;
export function rateItem<
  S extends number,
  const NK extends Kind,
  const DK extends KindWithHuman,
>(size:       S,
  numKind:    NK,
  numUnit:    SymbolsOf<NK>,
  denKind:    DK, //uses "human" unit by default
  transform?: TransformFuncUnion<S>,
): RateItem<S, NK, DK>;
export function rateItem<S extends number, const NK extends Kind, const DK extends Kind>(
  size:       S,
  numKind:    NK,
  numUnit:    SymbolsOf<NK>,
  denKind:    DK,
  denUnit:    SymbolsOf<DK>,
  transform?: TransformFuncUnion<S>,
): RateItem<S, NK, DK>;
export function rateItem(
  amntItemOrSize: WidenedAmountItem | number,
  denKindOrNumKind: Kind,
  denUnitOrNumUnit?: string,
  denKind?: Kind,
  transformOrDenUnit?: TransformFuncUnion<number> | string,
  transform?: TransformFuncUnion<number>,
): any {
  if (typeof amntItemOrSize === "number") {
    const size = amntItemOrSize;
    const numKind = denKindOrNumKind;
    const numUnit = denUnitOrNumUnit!;
    let denUnit: any;
    if (typeof transformOrDenUnit === "string")
      denUnit = transformOrDenUnit;
    else
      transform = transformOrDenUnit;

    const amntItem = amountItem(size, numKind, numUnit, transform);
    return rateItem(amntItem, denKind!, denUnit);
  }

  const amntItem = amntItemOrSize;
  denKind = denKindOrNumKind;
  const denAmnt = Amount.from(1, denKind, denUnitOrNumUnit ?? "human");
  return withCustom(amntItem, {
    to:   (amount: Amount<Kind>): Rate<Kind, Kind> => Rate.from(amount, denAmnt),
    from: (rate: Rate<Kind, Kind>) => denAmnt.mul(rate),
  });
}

export type TransformX = "stored" | "converted";
//y = mx + b convention
export function linearTransform<S extends number>(
  x:  TransformX,
  m:  Rationalish,
  b?: Rationalish,
): SizedTransformFunc<S, Rational>;
export function linearTransform<S extends number>(
  size: S,
  x:  TransformX,
  m:  Rationalish,
  b?: Rationalish,
): TransformFunc<S, Rational>;
export function linearTransform<S extends number>(
  sizeOrX: S | TransformX,
  xOrM:    Rationalish | TransformX,
  mOrB?:   Rationalish,
  maybeB?: Rationalish,
): any {
  if (typeof sizeOrX === "number")
    return linearTransform<S>(xOrM as TransformX, mOrB!, maybeB)(sizeOrX);

  const x = sizeOrX;
  const m = Rational.from(xOrM);
  const b = Rational.from(mOrB ?? 0);
  return (size: S) => {
    const numRet = numericReturn(size);
    return x === "stored"
      ? {
        to:   (val: NumSizeToPrimitive<S>) => Rational.from(val).mul(m).add(b),
        from: (val: Rational)              => numRet(val.sub(b).div(m)),
      }
      : {
        to:   (val: NumSizeToPrimitive<S>) => Rational.from(val).sub(b).div(m),
        from: (val: Rational)              => numRet(val.mul(m).add(b)),
      };
  };
}
