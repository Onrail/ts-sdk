import type { RoTuple, RoPair, RoNeTuple } from "@onrail-xyz/utils";
import { otherCap } from "@onrail-xyz/utils";
import type { Rationalish } from "./rational.js";
import type { SymbolSpec } from "./kind.js";

export const withPluralS = <S extends string>(symbol: S) =>
  ({ symbol, plural: (symbol + "s") as `${S}s` } as const);

export const allowPluralS = <S extends string>(symbol: S) =>
  [{ symbol }, { symbol: (symbol + "s") as `${S}s` }] as const;

export const allowOtherCap = <S extends string>(symbol: S) =>
  [{ symbol }, { symbol: otherCap(symbol) }] as const;

export const withPluralSBothCaps = <S extends string>(symbol: S) =>
  [withPluralS(symbol), withPluralS(otherCap(symbol))] as const;

export const allowPluralSBothCaps = <S extends string>(symbol: S) =>
  [...allowPluralS(symbol), ...allowPluralS(otherCap(symbol))] as const;

type UnitRow<V> = RoPair<V, RoNeTuple<SymbolSpec>>;

type ToUnits<K extends "scale" | "oom", T extends RoTuple<UnitRow<unknown>>> =
  { [I in keyof T]: T[I] extends RoPair<infer V, infer Symbols>
      ? K extends "scale"
        ? { scale: V, symbols: Symbols }
        : { oom:   V, symbols: Symbols }
      : never
  };

export const toScaleUnits =
  <const T extends RoTuple<UnitRow<Rationalish>>>(spec: T): ToUnits<"scale", T> =>
    spec.map(([scale, symbols]) => ({ scale, symbols })) as any;

export const toDecimalUnits =
  <const T extends RoTuple<UnitRow<number>>>(spec: T): ToUnits<"oom", T> =>
    spec.map(([oom, symbols]) => ({ oom, symbols })) as any;
