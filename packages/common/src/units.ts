import type { Identity } from "@onrail-xyz/utils";
import { column, zip, pickWithOrder } from "@onrail-xyz/utils";
import type { KindWithDecimalHumanAndAtomic,
              SystemInfo, ValidStandardInfo } from "@onrail-xyz/amount";
import { Amount, kind, scalar, toDecimalUnits,
         toScaleUnits, withPluralS, withPluralSBothCaps, allowOtherCap } from "@onrail-xyz/amount";

export const currencyFormats = ["default", "uniform", "fancy"] as const;
export type CurrencyFormat = (typeof currencyFormats)[number];

export type CurrencyKind<
  U extends string = string,
  N extends string = string,
  Y extends SystemInfo<CurrencyFormat, U, true> = SystemInfo<CurrencyFormat, U, true>,
  S extends ValidStandardInfo<Y> = ValidStandardInfo<Y>,
  H extends U = U,
  A extends U = U,
> = KindWithDecimalHumanAndAtomic<U, N, Y, S, H, A>;

const _PercentageKind = scalar(kind(
  "Percentage",
  toDecimalUnits([
    [  0, [{ symbol: "x", spacing: "compact" }, { symbol: "scalar" }] ],
    [ -2, [{ symbol: "%" }                                          ] ],
    [ -4, [withPluralS("bp")                                        ] ],
  ]),
  { human: "%" },
));
export interface PercentageKind extends Identity<typeof _PercentageKind> {}
export const Percentage = _PercentageKind as PercentageKind;
export type  Percentage = Amount<typeof Percentage>;
export const percentage = Amount.ofKind(Percentage);

const durationSpec = [
  //                  scale   long                          short
  [               1, [withPluralS("second")     ], [{ symbol: "s"  }, { symbol: "sec"  }] ],
  [            1e-3, [withPluralS("millisecond")], [{ symbol: "ms" }, { symbol: "msec" }] ],
  [            1e-6, [withPluralS("microsecond")], [{ symbol: "µs" }, { symbol: "µsec" }] ],
  [            1e-9, [withPluralS("nanosecond") ], [{ symbol: "ns" }, { symbol: "nsec" }] ],
  [              60, [withPluralS("minute")     ], [{ symbol: "m"  }, { symbol: "min"  }] ],
  [           60*60, [withPluralS("hour")       ], [{ symbol: "h"  }, { symbol: "hr"   }] ],
  [        24*60*60, [withPluralS("day")        ], [{ symbol: "d"  }, { symbol: "day"  }] ],
  [      7*24*60*60, [withPluralS("week")       ], [{ symbol: "w"  }, { symbol: "wk"   }] ],
  [ 365.25*24*60*60, [withPluralS("julianYear") ], [{ symbol: "y"  }, { symbol: "yr"   }] ],
] as const;

const _DurationKind = kind(
  "Duration",
  [ [ "long",  toScaleUnits(zip([column(durationSpec, 0), column(durationSpec, 1)])) ],
    [ "short", toScaleUnits(zip([column(durationSpec, 0), column(durationSpec, 2)])) ],
  ],
);
export interface DurationKind extends Identity<typeof _DurationKind> {}
export const Duration = _DurationKind as DurationKind;
export type  Duration = Amount<typeof Duration>;
export const duration = Amount.ofKind(Duration);

//technically tenor just means time to maturity in finance, so associating it with 30/360 is a bit
//  of a conflation, but there aren't really any better terms around...
//using uppercase for short codes so they never read as Duration's lowercase short units
const tenorSpec = [
  [   1, [withPluralS("day")  ], [{ symbol: "D" }] ],
  [   7, [withPluralS("week") ], [{ symbol: "W" }] ],
  [  30, [withPluralS("month")], [{ symbol: "M" }] ],
  [ 360, [withPluralS("year") ], [{ symbol: "Y" }] ],
] as const;

const _TenorKind = kind(
  "Tenor",
  [ [ "long",  toScaleUnits(zip([column(tenorSpec, 0), column(tenorSpec, 1)])) ],
    [ "short", toScaleUnits(zip([column(tenorSpec, 0), column(tenorSpec, 2)])) ],
  ],
  { human: "year", atomic: "day" },
);
export interface TenorKind extends Identity<typeof _TenorKind> {}
export const Tenor = _TenorKind as TenorKind;
export type  Tenor = Amount<typeof Tenor>;
export const tenor = Amount.ofKind(Tenor);

const symbolByte = withPluralS("byte");
const _ByteKind = kind(
  "Byte",
  [ [ "SI", toDecimalUnits([
      [  0, [  symbolByte    ] ],
      [  3, [{ symbol: "kB" }] ],
      [  6, [{ symbol: "MB" }] ],
      [  9, [{ symbol: "GB" }] ],
      [ 12, [{ symbol: "TB" }] ],
    ])],
    [ "binary", toScaleUnits([
      [       1/8, [{ symbol: "bit" }] ],
      [ 1024n**0n, [  symbolByte     ] ],
      [ 1024n**1n, [{ symbol: "KiB" }] ],
      [ 1024n**2n, [{ symbol: "MiB" }] ],
      [ 1024n**3n, [{ symbol: "GiB" }] ],
      [ 1024n**4n, [{ symbol: "TiB" }] ],
    ])],
  ],
  { human: "byte", atomic: "byte" },
);
export interface ByteKind extends Identity<typeof _ByteKind> {}
export const Byte = _ByteKind as ByteKind;
export type  Byte = Amount<typeof Byte>;
export const byte = Amount.ofKind(Byte);

const usdSymbolic = toDecimalUnits([
  [  0, [{ symbol: "$", spacing: "compact", position: "prefix" }] ],
  [ -2, [{ symbol: "¢", spacing: "compact"                     }] ],
]);

const _UsdKind = kind(
  "Usd",
  [ [ "default", usdSymbolic ],
    [ "uniform", toDecimalUnits([
      [  0, [{ symbol: "USD" }                                       ] ],
      [ -2, [withPluralS("cent"), { symbol: "c", spacing: "compact" }] ],
    ])],
    [ "fancy", usdSymbolic ],
  ],
  { human: "$", atomic: "¢" },
);
export interface UsdKind extends Identity<typeof _UsdKind> {}
export const Usd = _UsdKind as UsdKind;
export type  Usd = Amount<typeof Usd>;
export const usd = Amount.ofKind(Usd);

const usdtUniform = toDecimalUnits([
  [  0, [{ symbol: "USDT" }                          ] ],
  [ -6, [{ symbol: "µUSDT" }, { symbol: "microUSDT" }] ],
]);

const _UsdtKind = kind(
  "Usdt",
  [ [ "default", usdtUniform ],
    [ "uniform", usdtUniform ],
    [ "fancy", toDecimalUnits([
      [  0, [{ symbol: "USD₮"  }] ],
      [ -6, [{ symbol: "µUSD₮" }] ],
    ])],
  ],
  { human: "USDT", atomic: "µUSDT" },
);
export interface UsdtKind extends Identity<typeof _UsdtKind> {}
export const Usdt = _UsdtKind as UsdtKind;
export type  Usdt = Amount<typeof Usdt>;
export const usdt = Amount.ofKind(Usdt);

const usdcUniform = toDecimalUnits([
  [  0, [{ symbol: "USDC" }                          ] ],
  [ -6, [{ symbol: "µUSDC" }, { symbol: "microUSDC" }] ],
]);

const _UsdcKind = kind(
  "Usdc",
  [ [ "default", usdcUniform ],
    [ "uniform", usdcUniform ],
    [ "fancy",   usdcUniform ],
  ],
  { human: "USDC", atomic: "µUSDC" },
);
export interface UsdcKind extends Identity<typeof _UsdcKind> {}
export const Usdc = _UsdcKind as UsdcKind;
export type  Usdc = Amount<typeof Usdc>;
export const usdc = Amount.ofKind(Usdc);

const btcUniform = toDecimalUnits([
  [  0, [{ symbol: "BTC" }                 ] ],
  [ -8, [...withPluralSBothCaps("satoshi")] ],
]);

const _BtcKind = kind(
  "Btc",
  [ [ "default", btcUniform ],
    [ "uniform", btcUniform ],
    [ "fancy", toDecimalUnits([
      [  0, [{ symbol: "₿" }               ] ],
      [ -8, [...withPluralSBothCaps("sat")] ],
    ])],
  ],
  { human: "BTC", atomic: "satoshi" },
);
export interface BtcKind extends Identity<typeof _BtcKind> {}
export const Btc = _BtcKind as BtcKind;
export type  Btc = Amount<typeof Btc>;
export const btc = Amount.ofKind(Btc);

const ethUniform = toDecimalUnits([
  [   0, [{ symbol: "ETH" }]   ],
  [  -9, allowOtherCap("Gwei") ],
  [ -18, allowOtherCap("wei")  ],
]);

const _EthKind = kind(
  "Eth",
  [ [ "default", ethUniform ],
    [ "uniform", ethUniform ],
    [ "fancy", [
      { oom: 0, symbols: [{ symbol: "Ξ" }] },
      ...pickWithOrder(ethUniform, [1, 2]),
    ]],
  ],
  { human: "ETH", atomic: "wei" },
);
export interface EthKind extends Identity<typeof _EthKind> {}
export const Eth = _EthKind as EthKind;
export type  Eth = Amount<typeof Eth>;
export const eth = Amount.ofKind(Eth);

const solUniform = toDecimalUnits([
  [   0, [{ symbol: "SOL" }                                   ] ],
  [  -9, [...withPluralSBothCaps("lamport")                   ] ],
  [ -15, [withPluralS("µLamport"), withPluralS("microLamport")] ],
]);

const _SolKind = kind(
  "Sol",
  [ [ "default", solUniform ],
    [ "uniform", solUniform ],
    [ "fancy",   solUniform ],
  ],
  { human: "SOL", atomic: "lamport" },
);
export interface SolKind extends Identity<typeof _SolKind> {}
export const Sol = _SolKind as SolKind;
export type  Sol = Amount<typeof Sol>;
export const sol = Amount.ofKind(Sol);
