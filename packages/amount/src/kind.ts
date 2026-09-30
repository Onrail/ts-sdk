import type { Opts, RoArray, RoNeTuple, RoPair, Brand,
              If, IsAny, IsNever, Extends, OptionalArg } from "@onrail-xyz/utils";
import { omit, fromEntries, pick, isArray } from "@onrail-xyz/utils";
import { type Rationalish, Rational } from "./rational.js";
import { findUnit, segment, symbolKey } from "./segmenting.js";

// ---- Public API types ----

export type SymbolSpec = Readonly<{
  symbol:    string;
  plural?:   string;
  position?: "postfix" | "prefix";
  spacing?:  "spaced" | "compact";
}>;

export type DecimalSpec<N extends number = number> =
  { readonly oom: N;      readonly scale?: never };

export type ScaleSpec<N extends Rationalish = Rationalish> =
  { readonly oom?: never; readonly scale: N  };

export type Unit = SymbolSpec & { readonly scale: Rational; readonly oom?: number };

export type SystemInfo<
  N extends string  = string,
  U extends string  = string,
  D extends boolean = boolean,
> = { name: N; symbols: U; decimal: D };

export type StandardInfo<
  SY extends string = string,
  SU extends string = string,
> = { system: SY; unit: SU };

export type ValidStandardInfo<Y extends SystemInfo> =
  Y extends SystemInfo<infer N, infer U, boolean> ? StandardInfo<N, U> : never;

export type Kind<
  U extends string               = string,
  N extends string               = string,
  Y extends SystemInfo           = SystemInfo,
  S extends ValidStandardInfo<Y> = ValidStandardInfo<Y>,
  H extends U | undefined        = U | undefined,
  A extends U | undefined        = U | undefined,
> = {
    readonly name:     N;
    readonly units:    KindUnits<U>; //guaranteed to be in descending order by scale
    readonly standard: S;
    readonly systems:  KindSystems<Y>;
  } & (
    [U | undefined] extends [H]
    ? { readonly human?: U }
    : [H] extends [U]
    ? { readonly human: H }
    : [H] extends [undefined]
    ? unknown
    : { readonly human?: Exclude<H, undefined> }
  ) & (
    [U | undefined] extends [A]
    ? { readonly atomic?: U }
    : [A] extends [U]
    ? { readonly atomic: A }
    : [A] extends [undefined]
    ? unknown
    : { readonly atomic?: Exclude<A, undefined> }
  );

export type KindWithHuman<
  U extends string               = string,
  N extends string               = string,
  Y extends SystemInfo           = SystemInfo,
  S extends ValidStandardInfo<Y> = ValidStandardInfo<Y>,
  H extends U                    = U,
  A extends U | undefined        = U | undefined,
> = Kind<U, N, Y, S, H, A>;

export type KindWithAtomic<
  U extends string               = string,
  N extends string               = string,
  Y extends SystemInfo           = SystemInfo,
  S extends ValidStandardInfo<Y> = ValidStandardInfo<Y>,
  H extends U | undefined        = U | undefined,
  A extends U                    = U,
> = Kind<U, N, Y, S, H, A>;

export type KindWithHumanAndAtomic<
  U extends string               = string,
  N extends string               = string,
  Y extends SystemInfo           = SystemInfo,
  S extends ValidStandardInfo<Y> = ValidStandardInfo<Y>,
  H extends U                    = U,
  A extends U                    = U,
> = Kind<U, N, Y, S, H, A>;

export type KindWithDecimalHumanAndAtomic<
  U extends string               = string,
  N extends string               = string,
  Y extends SystemInfo           = SystemInfo,
  S extends ValidStandardInfo<Y> = ValidStandardInfo<Y>,
  H extends U                    = U,
  A extends U                    = U,
> = Brand<Kind<U, N, Y, S, H, A>, "decimalHuman" | "decimalAtomic">;

export type KindUnitSymbols<K extends Kind> = Extract<keyof K["units"], string>;

type MetaSymbolsOf<K extends Kind> =
  "standard" |
  (K["human"]  extends string ? "human"  : never) |
  (K["atomic"] extends string ? "atomic" : never);

export type SymbolsOf<K extends Kind> =
  If<IsAny<K>,
    string,
    If<Extends<string, KindUnitSymbols<K>>,
      If<IsNever<("human" | "atomic") & MetaSymbolsOf<K>>,
        string,
        never
      >,
      KindUnitSymbols<K>
    >
  > | MetaSymbolsOf<K>;

export type DecimalSymbolsOf<K extends Kind> = DecimalUnitSymbols<K> | DecimalMetaSymbolOf<K>;

export type ResolvedSymbolOf<K extends Kind, M extends SymbolsOf<K>> =
  M extends "standard" ? K["standard"]["unit"] :
  M extends "human"    ? K["human"]            :
  M extends "atomic"   ? K["atomic"]           :
  M;

export type IsBareKind<K extends Kind> = Extends<string, K["name"]>;

export type CandidateKinds<K extends Kind> = If<IsBareKind<K>, Kind, K>;

export function sameKind(a: Kind, b: Kind): boolean {
  return a === b || a.name === b.name;
}

export function getUnit<
  const K extends Kind,
  S extends SymbolsOf<K>,
>(kind: K, unitSymbol: S): Unit {
  const resolved =
    unitSymbol === "standard" ? kind.standard.unit :
    unitSymbol === "human"    ? kind.human         :
    unitSymbol === "atomic"   ? kind.atomic        :
    unitSymbol;

  const unit = resolved === undefined ? undefined : kind.units[resolved];
  if (!unit)
    throw new Error(`Kind ${kind.name} has no unit ${unitSymbol}`);

  return unit;
}

export function getDecimals<const K extends KindWithDecimalHumanAndAtomic>(
  kind:  K,
  opts?: GetDecimalsOpts<K>,
): number;
export function getDecimals<const K extends Kind>(
  kind: K,
  opts: GetDecimalsOpts<K>,
): number;
export function getDecimals(
  kind:  Kind,
  opts?: Opts<{ of: string; in: string }>,
): number {
  const { of: ofSymbol = "human", in: inSymbol = "atomic" } = opts ?? {};
  const oomOf = (symbol: string) => {
    const { oom } = getUnit(kind, symbol);
    if (oom === undefined)
      throw new Error(`Unit ${symbol} of kind ${kind.name} is not decimal`);

    return oom;
  };

  return oomOf(ofSymbol) - oomOf(inSymbol);
}

type MetaBrandTags<H, A, S, I extends KindUnitsInput> =
  [H, "human"] | [A, "atomic"] | [S, "standard"] extends infer M
  ? M extends [DecimalSymbolsOfSystem<SystemInfoOf<I>>, MetaSymbols]
    ? `decimal${Capitalize<M[1]>}`
    : ""
  : never;

type KindOpts<I extends KindUnitsInput> = Opts<{
  human:  UnitSymbolsOf<UnitsSpecOf<I>>;
  atomic: UnitSymbolsOf<UnitsSpecOf<I>>;
}>;
//a meta symbol read off the whole record: one that may be undefined - or absent, where the
//  record's own type declares it optional - may be unset on the kind
type MetaOf<O, K extends "human" | "atomic"> = K extends keyof O ? O[K] : undefined;

export function kind<
        N extends string,
  const I extends KindUnitsInput,
  const O extends KindOpts<I> = {},
>(name:       N,
  unitsInput: I,
  ...[opts]:  OptionalArg<O>
): Brand<
  Kind<
    UnitSymbolsOf<UnitsSpecOf<I>>,
    N,
    SystemInfoOf<I>,
    StandardInfoOf<I>,
    MetaOf<O, "human">,
    MetaOf<O, "atomic">
  >,
  MetaBrandTags<MetaOf<O, "human">, MetaOf<O, "atomic">, StandardInfoOf<I>["unit"], I>
> {
  const isSystemsSpec = isArray(unitsInput) && isArray(unitsInput[0]);
  const systemEntries = (
    isSystemsSpec ? unitsInput : [["default", unitsInput]]
  ) as RoArray<SystemEntry>;

  const firstSpec = systemEntries[0]![1];
  const standard = {
    system: systemEntries[0]![0],
    unit:   firstSpec[0]!.symbols[0]!.symbol,
  } as const;
  const meta = pick<KindOpts<I>, ["human", "atomic"]>(opts ?? {}, ["human", "atomic"]);

  const allUnits: [string, Unit][] = [];
  const systems: Record<string, { symbols: string[]; decimal: boolean }> = {};

  for (let i = 0; i < systemEntries.length; ++i) {
    const [sysName, unitsSpec] = systemEntries[i]!;
    if (displayModes.some(mode => mode === sysName))
      throw new Error(`"${sysName}" is a display mode and cannot name a system`);

    //mirrors IsSystemDecimal: an explicit oom/scale on the first unit decides; a bare first
    //  unit defers to the second, and a lone bare unit counts as decimal
    const sysDecimal = i === 0
      ? "oom" in firstSpec[0]!
        ? true
        : "scale" in firstSpec[0]!
        ? false
        : firstSpec.length === 1 || "oom" in firstSpec[1]!
      : unitsSpec.every(u => "oom" in u);

    if (Object.hasOwn(systems, sysName))
      throw new Error(`Duplicate system "${sysName}"`);

    systems[sysName] = { symbols: [], decimal: sysDecimal };

    const processed = unitsSpec
      .map(u => ({ ...u, ...ensureScale(sysDecimal, u) }) as UnitBaseSpec & { scale: Rational })
      .sort((a, b) => b.scale.gt(a.scale) ? 1 : b.scale.lt(a.scale) ? -1 : 0);

    for (const unit of processed) {
      if (unit.scale.sign() !== 1)
        throw new Error(`Unit scales must be positive, got ${unit.scale.toString()}`);

      const magScale = omit(unit, "symbols");
      for (const symbolSpec of unit.symbols) {
        const unitData = { ...symbolSpec, ...magScale };
        const symbols = [
          symbolSpec.symbol,
          ...(symbolSpec.plural !== undefined ? [symbolSpec.plural] : []),
        ];
        for (const symbol of symbols) {
          if (metaSymbols.some(meta => meta === symbol))
            throw new Error(`"${symbol}" is a reserved symbol and cannot name a unit`);

          //parsing tokenizes on these characters (and takes a leading "-" for the sign), so a
          //  symbol containing them could never round-trip through its own kind. Digits end a
          //  value, so no symbol may start with one, and a prefix symbol (which the value follows,
          //  as in "$100") may hold none; a postfix one ends at the next space regardless
          const prefix = (symbolSpec.position ?? "postfix") === "prefix";
          if (symbol === "" || /[\s,_./]/u.test(symbol) || symbol.startsWith("-") ||
              /^[0-9]/.test(symbol) || (prefix && /[0-9]/.test(symbol)))
            throw new Error(
              `Invalid unit symbol "${symbol}": symbols must be non-empty and must not ` +
              `contain whitespace, ",", "_", ".", "/", a leading "-" or a leading digit ` +
              `(nor any digit when prefixed)`
            );

          if (systems[sysName]!.symbols.includes(symbol))
            throw new Error(`Duplicate symbol "${symbol}" in system ${sysName}`);

          const existing = allUnits.find(([s]) => symbolKey(s) === symbolKey(symbol));
          if (existing && existing[0] !== symbol)
            throw new Error(`Symbol "${symbol}" is equivalent to "${existing[0]}" (NFKC)`);

          systems[sysName]!.symbols.push(symbol);
          if (!existing)
            allUnits.push([symbol, unitData as Unit]);
          else if (!existing[1].scale.eq(unitData.scale))
            throw new Error(`Symbol "${symbol}" has conflicting scales across systems`);
          else
            existing[1] = { ...unitData, ...existing[1] } as Unit;
        }
      }
    }
  }

  //descending by scale: a promise to consumers walking `units`, which the type states too
  allUnits.sort((a, b) => b[1].scale.gt(a[1].scale) ? 1 : b[1].scale.lt(a[1].scale) ? -1 : 0);
  const units = fromEntries(allUnits);

  return { name, units, standard, systems, ...meta } as any;
}

export function identifyKind<const K extends Kind, A extends boolean = false>(
  kinds:           RoArray<K>,
  str:             string,
  allowAmbiguous?: A
): A extends true ? K[] : K | undefined {
  const { pairs } = segment(str);
  const symbols = pairs.map(p => str.substring(p.symbol[0], p.symbol[1]));

  const matches = kinds.filter(k => symbols.every(s => findUnit(k.units, s) !== undefined));

  return (allowAmbiguous ? matches : matches.length === 1 ? matches[0] : undefined) as any;
}

// ---- Implementation details ----

type UnitBaseSpec = { readonly symbols: RoNeTuple<SymbolSpec> };

type UnitSpec<F extends boolean, D extends boolean> =
  UnitBaseSpec & (
    F extends true
    ? D extends true
      ? Partial<DecimalSpec<0>>
      : Partial<ScaleSpec<1 | 1n>>
    : D extends true ? DecimalSpec : ScaleSpec
  );

type KindUnitsSpec<F extends boolean, D extends boolean> =
  D extends any
  ? F extends true
    ? readonly [UnitSpec<true, D>, ...UnitSpec<false, D>[]]
    : RoNeTuple<UnitSpec<false, D>>
  : never;

type KindUnits<U extends string> = { readonly [K in U]?: Unit };

type KindSystems<Y extends SystemInfo> = {
  readonly [Sys in Y as Sys["name"]]: Readonly<{
    symbols: RoArray<Sys["symbols"]>; //guaranteed to be in descending order by scale
    decimal: Sys["decimal"];
  }>;
};

type UnitSymbolsOf<U extends RoArray<UnitBaseSpec>> =
  U[number]["symbols"][number] extends infer S
  ? S extends SymbolSpec
    ? S["symbol"] | Extract<S["plural"], string>
    : never
  : never;

type SystemEntry<
  F extends boolean                   = boolean,
  N extends string                    = string,
  S extends KindUnitsSpec<F, boolean> = KindUnitsSpec<F, boolean>,
> = RoPair<N, S>;

type SystemsSpec = readonly [SystemEntry<true>, ...SystemEntry<false>[]];

type KindUnitsInput = KindUnitsSpec<true, boolean> | SystemsSpec;

type IsSystemDecimal<Spec extends KindUnitsSpec<boolean, boolean>> =
  Spec[0] extends DecimalSpec
  ? true
  : Spec[0] extends ScaleSpec
  ? false
  : Spec extends readonly [unknown] | readonly [unknown, DecimalSpec, ...unknown[]]
  ? true
  : false;

type SystemInfoOf<I extends KindUnitsInput> =
  I extends SystemsSpec
  ? { [K in keyof I & `${number}`]:
        I[K] extends SystemEntry<boolean, infer Name, infer Spec>
        ? SystemInfo<Name, UnitSymbolsOf<Spec>, IsSystemDecimal<Spec>>
        : never
    }[keyof I & `${number}`]
  : I extends KindUnitsSpec<true, boolean>
  ? SystemInfo<"default", UnitSymbolsOf<I>, IsSystemDecimal<I>>
  : never;

type UnitsSpecOf<I extends KindUnitsInput> =
  I extends SystemsSpec ? I[number][1] : I;

type StandardSystemOf<I extends KindUnitsInput> =
  I extends SystemsSpec ? I[0][0] : "default";

type StandardUnitOf<I extends KindUnitsInput> =
  I extends SystemsSpec
  ? I[0][1][0]["symbols"][0]["symbol"]
  : I extends KindUnitsSpec<boolean, boolean>
    ? I[0]["symbols"][0]["symbol"]
    : never;

type StandardInfoOf<I extends KindUnitsInput> =
  StandardInfo<StandardSystemOf<I>, StandardUnitOf<I>> extends infer S
    extends ValidStandardInfo<SystemInfoOf<I>> //tell tsc that this must hold
  ? S
  : never;

const metaSymbols = ["standard", "human", "atomic"] as const;
//Amount.toString takes a system name in the position of its mode argument, so a system named
//  like a mode could never be selected
const displayModes = ["approximate", "exact", "inUnit"] as const;
type MetaSymbols = typeof metaSymbols[number];
type DecimalMetaSymbolOf<K extends Kind, M extends MetaSymbols = MetaSymbols> =
  M extends MetaSymbols
  ? K extends Brand<unknown, `decimal${Capitalize<M>}`>
    ? M
    : never
  : never;

type DecimalSymbolsOfSystem<Y extends SystemInfo> =
  Y extends { symbols: infer Syms extends string; decimal: true }
  ? Syms
  : never;

type DecimalUnitSymbols<K extends Kind> =
  K["systems"][keyof K["systems"]] extends infer Sys
  ? Sys extends { symbols: RoArray<infer S extends string>; decimal: true } ? S : never
  : never;

type GetDecimalsOpts<K extends Kind> =
  DecimalSymbolsOf<K> extends infer D
  ? ("human"  extends D ? Opts<{ of: D }> : { readonly of: D }) &
    ("atomic" extends D ? Opts<{ in: D }> : { readonly in: D })
  : never;

const addScale = (spec: DecimalSpec) =>
  ({ oom: spec.oom, scale: Rational.powerOfTen(spec.oom) });

const ensureScale = (decimal: boolean, spec: UnitBaseSpec) =>
  "oom" in spec
  ? addScale(spec as DecimalSpec)
  : "scale" in spec
  ? { scale: Rational.from((spec as ScaleSpec).scale) } as const
  : decimal
  ? { oom: 0, scale: Rational.from(1n) } as const
  : { scale: Rational.from(1n) } as const;
