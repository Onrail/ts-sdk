//type-only assertion battery for getDecimals — typechecked via tsconfig.test.json,
//never executed (not picked up by the *.test.ts glob)
import type { Amount, Kind,
              KindWithHumanAndAtomic, KindWithDecimalHumanAndAtomic } from "../src/index.js";
import { kind, getDecimals } from "../src/index.js";

const ETH = kind(
  "ETH",
  [ { symbols: [{ symbol: "wei"  }]          },
    { symbols: [{ symbol: "Gwei" }], oom:  9 },
    { symbols: [{ symbol: "ETH"  }], oom: 18 } ],
  { human: "ETH", atomic: "wei" },
);

const Dur = kind(
  "Dur",
  [ { symbols: [{ symbol: "s" }]            },
    { symbols: [{ symbol: "m" }], scale: 60 } ],
);

const Byte = kind(
  "Byte",
  [ [ "SI", [
      { symbols: [{ symbol: "byte" }]         },
      { symbols: [{ symbol: "kB"   }], oom: 3 } ] ],
    [ "binary", [
      { symbols: [{ symbol: "byte" }], scale: 1    },
      { symbols: [{ symbol: "KiB"  }], scale: 1024 } ] ],
  ],
  { human: "byte", atomic: "byte" },
);

const SAT = kind("SAT", [{ symbols: [{ symbol: "sat" }] }], { atomic: "sat" });

//fully decimal kind with human+atomic: opts and both keys optional
getDecimals(ETH);
getDecimals(ETH, {});
getDecimals(ETH, { of: "Gwei" });
getDecimals(ETH, { in: "Gwei" });
getDecimals(ETH, { of: "human", in: "atomic" });
getDecimals(ETH, { of: "standard" });
// @ts-expect-error unknown symbol
getDecimals(ETH, { of: "bogus" });

//compound kind: no decimal symbols → uncallable
// @ts-expect-error
getDecimals(Dur);
// @ts-expect-error
getDecimals(Dur, { of: "s", in: "m" });
// @ts-expect-error meta symbols of a compound kind aren't decimal either
getDecimals(Dur, { of: "standard", in: "standard" });

//mixed systems: only decimal-system symbols allowed
getDecimals(Byte, { of: "kB" });
// @ts-expect-error KiB lives in the (compound) binary system
getDecimals(Byte, { of: "KiB" });

//atomic but no human: opts and `of` required, `in` optional
getDecimals(SAT, { of: "sat" });
getDecimals(SAT, { of: "standard", in: "atomic" });
// @ts-expect-error `of` has no default (no human)
getDecimals(SAT, {});
// @ts-expect-error opts required (not a KindWithDecimalHumanAndAtomic)
getDecimals(SAT);

//deferred generics (mirrors fork-svm createMint): a KindWithDecimalHumanAndAtomic bound proves the
//  defaults are safe; a plain KindWithHumanAndAtomic bound does not
export const _f = <const K extends KindWithDecimalHumanAndAtomic>(k: K) => getDecimals(k);
export const _g = <const K extends KindWithHumanAndAtomic>(k: K) =>
  // @ts-expect-error K's human/atomic aren't provably decimal
  getDecimals(k, { of: "human", in: "atomic" });

//regression pin: DecimalMetaSymbolOf must use the distributive `K extends Brand<unknown, ...>`
//  form - the equivalent-looking `Tag extends ExtractTags<K>` resolves K's variance in
//  _Amount to reliably-invariant and broke this relation
declare const anEth: Amount<typeof ETH>;
export const asBare: Amount<Kind> = anEth;
