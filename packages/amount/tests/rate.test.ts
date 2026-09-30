import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Rate, invert, numKindOf, denKindOf } from "../src/rate.js";
import { Amount, scalar } from "../src/amount.js";
import { type Kind, kind } from "../src/kind.js";
import { Rational, tenToThe } from "../src/rational.js";

const Percentage = scalar(kind(
  "Percentage",
  [ { symbols: [{ symbol: "x"  }] },
    { symbols: [{ symbol: "%"  }], oom: -2 } ],
  { human: "%" },
));

const BTC = kind(
  "BTC",
  [ { symbols: [{ symbol: "satoshi" }]     },
    { symbols: [{ symbol: "BTC" }], oom: 8 } ],
  { human: "BTC", atomic: "satoshi" },
);

const USD = kind(
  "USD",
  [ { symbols: [{ symbol: "cent" }]        },
    { symbols: [{ symbol: "USD" }], oom: 2 } ],
  { human: "USD", atomic: "cent" },
);

const ETH = kind(
  "ETH",
  [ { symbols: [{ symbol: "wei" }] },
    { symbols: [{ symbol: "ETH" }], oom: 18 } ],
  { human: "ETH", atomic: "wei" },
);

const SAT = kind(
  "SAT",
  [{ symbols: [{ symbol: "sat" }] }],
  { atomic: "sat" },
);

const Duration = kind(
  "Duration",
  [ { symbols: [{ symbol: "s"    }]                          },
    { symbols: [{ symbol: "min"  }], scale: 60               },
    { symbols: [{ symbol: "h"    }], scale: 60 * 60          },
    { symbols: [{ symbol: "day"  }], scale: 24 * 60 * 60     },
    { symbols: [{ symbol: "week" }], scale: 7 * 24 * 60 * 60 },
    { symbols: [{ symbol: "yr"   }], scale: 365.25 * 24 * 60 * 60 },
  ],
);

describe("Rate", () => {
  describe("from", () => {
    it("creates from ratio", () => {
      const conv = Rate.from(50_000n, USD, BTC);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("creates from amounts", () => {
      const usd = Amount.from(50_000n, USD);
      const btc = Amount.from(1n, BTC);
      const conv = Rate.from(usd, btc);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("creates from amount and kind", () => {
      const usd = Amount.from(50_000, USD);
      const conv = Rate.from(usd, BTC);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("throws on same kind", () => {
      assert.throws(() => Rate.from(1, BTC, BTC), /Must be distinct kinds: BTC vs BTC/);
    });

    //scalar kinds used to be rejected at the type level, which made pure reciprocal
    //  dimensions (APR: Percentage/Duration) unrepresentable
    it("accepts a scalar numerator (APR)", () => {
      const apr = Rate.from(Amount.from(5, Percentage), Amount.from(1, Duration, "yr"));
      assert.strictEqual(apr.toJSON(), "5 %/yr");

      const accrued = Amount.from(2, Duration, "yr").mul(apr);
      assert(accrued.eq(Amount.from(10, Percentage)));
      assert(Amount.from(10, Percentage).div(apr).eq(Amount.from(2, Duration, "yr")));
    });

    it("accepts a scalar denominator (DV01-style sensitivity)", () => {
      const dv01 = Rate.from(Amount.from(700, USD), Percentage);
      assert(Amount.from(2, Percentage).mul(dv01).eq(Amount.from(1400, USD)));
      assert.strictEqual(dv01.toJSON(), "700 USD/%");
    });
  });

  describe("arithmetic", () => {
    it("addition and subtraction (spread over a base rate)", () => {
      const base   = Rate.from(3, USD, BTC);
      const spread = Rate.from(Rational.from(1n, 2n), USD, BTC);
      assert.strictEqual(base.add(spread).in("USD", "BTC").toString(), "3.5");
      assert.strictEqual(base.sub(spread).in("USD", "BTC").toString(), "2.5");
    });

    it("throws on add/sub kind mismatch", () => {
      const usdBtc = Rate.from(3, USD, BTC);
      const usdEth = Rate.from(3, USD, ETH);
      // @ts-expect-error | Disabled by type system but possible at runtime
      assert.throws(() => usdBtc.add(usdEth), /Kind mismatch: USD\/BTC vs USD\/ETH/);
    });

    it("abs/neg/isZero/sign", () => {
      const conv = Rate.from(3, USD, BTC);
      assert(conv.neg().abs().eq(conv));
      assert.strictEqual(conv.neg().in("USD", "BTC").toString(), "-3");
      assert.strictEqual(conv.sign(), 1);
      assert.strictEqual(conv.neg().sign(), -1);
      assert(conv.sub(conv).isZero());
      assert.strictEqual(conv.sub(conv).sign(), 0);
      assert(!conv.isZero());
    });

    it("multiplication", () => {
      const conv = Rate.from(50_000, USD, BTC);
      const doubled = conv.mul(2);
      assert.strictEqual(doubled.in("USD", "BTC").toString(), "100000");
    });

    it("division", () => {
      const conv = Rate.from(50_000, USD, BTC);
      const halved = conv.div(2);
      assert.strictEqual(halved.in("USD", "BTC").toString(), "25000");
    });

    it("inversion", () => {
      const conv = Rate.from(50_000, USD, BTC);
      const inverted = conv.inv();
      assert.strictEqual(inverted.in("BTC", "USD").toString(), "0.00002");
    });
  });

  describe("rounding", () => {
    it("rounds to integer multiples of a unit pair", () => {
      const conv = Rate.from(Rational.from("1000.03"), USD, BTC);
      assert.strictEqual(conv.floorTo("USD", "BTC").in("USD", "BTC").toString(), "1000");
      assert.strictEqual(conv.ceilTo("USD", "BTC").in("USD", "BTC").toString(), "1001");
      assert.strictEqual(conv.roundTo("USD", "BTC").in("USD", "BTC").toString(), "1000");
      //already an integer number of cents per BTC, so rounding to that pair is the identity
      assert(conv.floorTo("cent", "BTC").eq(conv));
    });

    it("roundTo rounds half away from zero, matching Amount", () => {
      const half = Rate.from(Rational.from(1n, 2n), USD, BTC);
      assert.strictEqual(half.roundTo("USD", "BTC").in("USD", "BTC").toString(), "1");
      assert.strictEqual(half.neg().roundTo("USD", "BTC").in("USD", "BTC").toString(), "-1");
    });
  });

  describe("instance factories", () => {
    it("zero and ofSame construct rates of the receiver's kind pair", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert(conv.zero().isZero());
      assert(conv.zero().add(conv).eq(conv));
      assert(conv.ofSame(50_000, "USD", "BTC").eq(conv));
      assert.strictEqual(conv.ofSame(1, "cent", "satoshi").in("USD", "BTC").toString(), "1000000");
    });
  });

  describe("kind surgery", () => {
    it("numKindOf/denKindOf read the kinds, invert swaps them exactly", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(numKindOf(conv).name, "USD");
      assert.strictEqual(denKindOf(conv).name, "BTC");
      assert(invert(conv).eq(conv.inv()));
      assert(invert(invert(conv)).eq(conv));
    });
  });

  describe("combination", () => {
    it("keeps a Rate result through generic composition and throws on cancellation", () => {
      const usdToBtc = Rate.from(50_000, USD, BTC);
      const combine = <K extends Kind>(other: Rate<typeof BTC, K>): Rate<typeof USD, K> =>
        usdToBtc.combine(other);

      assert(combine(Rate.from(2, BTC, ETH)).in("USD", "ETH").eq(100_000));
      assert.throws(() => combine(usdToBtc.inv()), /Must be distinct kinds: USD vs USD/);
      assert.throws(() => usdToBtc.combine(usdToBtc.inv()), /Must be distinct kinds/);
    });

    it("combines conversions", () => {
      const usdToBtc = Rate.from(50_000, USD, BTC);
      const btcToEth = Rate.from(2, BTC, ETH);
      const usdToEth = usdToBtc.combine(btcToEth);
      assert.strictEqual(usdToEth.in("USD", "ETH").toString(), "100000");
    });

    it("cancels reciprocal dimensions to a Rational", () => {
      const usdToBtc = Rate.from(50_000, USD, BTC);
      const ratio: Rational = usdToBtc.cancel(usdToBtc.inv());
      assert(ratio.eq(1n));
      assert(usdToBtc.cancel(Rate.from(4, BTC, USD)).eq(Rational.from(200_000n)));
    });

    it("throws on kind mismatch", () => {
      const usdToBtc = Rate.from(50_000, USD, BTC);
      const ethToBtc = Rate.from(2n, ETH, BTC);
      // @ts-expect-error | Disabled by type system but possible at runtime
      assert.throws(() => usdToBtc.combine(ethToBtc), /Kind mismatch: BTC vs ETH/);
    });

    it("checks both reciprocal kinds when union kinds overlap", () => {
      const cancelKinds = <N extends Kind, D extends Kind>(rate: Rate<N, D>, other: Rate<D, N>) =>
        rate.cancel(other);
      const cancel = cancelKinds<typeof USD | typeof ETH, typeof BTC | typeof ETH>;
      const rate = Rate.from(50_000, USD, BTC);

      assert(cancel(rate, Rate.from(4, BTC, USD)).eq(200_000));
      assert.throws(() => cancel(rate, Rate.from(2, ETH, USD)), /Kind mismatch: BTC\/USD vs ETH\/USD/);
      assert.throws(() => cancel(rate, Rate.from(2, BTC, ETH)), /Kind mismatch: BTC\/USD vs BTC\/ETH/);
    });
  });

  describe("toString", () => {
    it("falls back to first unit symbol when human unit is not defined", () => {
      const conv = Rate.from(Amount.from(100, SAT, "sat"), Amount.from(2, USD));
      assert.strictEqual(conv.toString(), "50 sat/USD");
    });

    it("formats with default options", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toString(), "50,000 USD/BTC");
    });

    // a meta symbol as precision used to reach inUnit unresolved and throw on
    // `kind.units["human"].oom`; Amount.toString resolved it, Rate.toString did not
    it("accepts meta symbols as precision", () => {
      const conv = Rate.from(50_000.25, USD, BTC);
      //human -> USD (oom 2), so 2-2 = 0 decimals
      assert.strictEqual(conv.toString({ precision: "human"    }), "50,000 USD/BTC");
      assert.strictEqual(conv.toString({ precision: "USD"      }), "50,000 USD/BTC");
      //atomic/standard -> cent (oom 0), so 2-0 = 2 decimals
      assert.strictEqual(conv.toString({ precision: "atomic"   }), "50,000.25 USD/BTC");
      assert.strictEqual(conv.toString({ precision: "standard" }), "50,000.25 USD/BTC");
      assert.strictEqual(conv.toString({ precision: "cent"     }), "50,000.25 USD/BTC");
    });

    it("defaults to significant-figure precision, not fixed precision 0 (regression)", () => {
      const half = Rate.from(Rational.from(1n, 2n), BTC, ETH); // 0.5 BTC/ETH
      assert.strictEqual(half.toString(), "0.5 BTC/ETH");            // was "1 BTC/ETH"
      assert.strictEqual(half.toJSON(),   "0.5 BTC/ETH");

      const oneAndHalf = Rate.from(Rational.from(3n, 2n), BTC, ETH);
      assert.strictEqual(oneAndHalf.toString(), "1.5 BTC/ETH");

      // large values keep their integer part (sig figs limit decimals, like Amount)
      assert.strictEqual(Rate.from(1234, USD, BTC).toString(), "1,234 USD/BTC");

      // explicit precision still overrides the default
      assert.strictEqual(half.toString({ precision: 4 }), "0.5 BTC/ETH");
    });

    it("keeps significant digits for ratios below 1 [used to render as 0]", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.inv().toString(), "0.00002 BTC/USD");
      assert.strictEqual(conv.toString({ denSymbol: "satoshi" }), "0.0005 USD/satoshi");
      assert.strictEqual(conv.inv().mul(-1).toString(), "-0.00002 BTC/USD");
    });

    it("supports precision option", () => {
      const conv = Rate.from(50_000.5, USD, BTC);
      assert.strictEqual(conv.toString({ precision: 2 }), "50,000.5 USD/BTC");
    });

    it("supports thousandsSep option", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toString({ thousandsSep: "_" }), "50_000 USD/BTC");
      assert.strictEqual(conv.toString({ thousandsSep: "" }), "50000 USD/BTC");
    });

    it("supports numSymbol and denSymbol options", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toString({ numSymbol: "cent", denSymbol: "satoshi", precision: 2 }), "0.05 cent/satoshi");
      assert.strictEqual(conv.toString({ denSymbol: "satoshi", precision: 4 }), "0.0005 USD/satoshi");
      assert.strictEqual(conv.toString({ denSymbol: "BTC" }), "50,000 USD/BTC");
    });
  });

  describe("toJSON", () => {
    it("returns string representation", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toJSON(), "50,000 USD/BTC");
    });

    it("ignores what JSON.stringify hands it [toJSON used to declare a ToFixedOptions param, but JSON.stringify calls toJSON(key) with the property key]", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toJSON.length, 0);
      assert.strictEqual(JSON.stringify({ price: conv }), '{"price":"50,000 USD/BTC"}');
    });
  });

  describe("toString exact mode", () => {
    it("supports thousandsSep", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toString("exact", { thousandsSep: "_" }), "50_000 USD/BTC");
    });

    it("agrees with toJSON when given no options", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toString("exact"), conv.toJSON());
    });
  });

  describe("exact toJSON", () => {
    it("round-trips non-terminating ratios via the mixed-number form", () => {
      const thirds = Rate.from(Rational.from(1000n, 3n), USD, BTC);
      assert.strictEqual(thirds.toJSON(), "333 1/3 USD/BTC");
      assert(Rate.parse(thirds.toJSON(), USD, BTC).eq(thirds));
    });

    it("keeps the sign outside a prefix numerator symbol [used to emit \"$-3,000/BTC\"]", () => {
      const Dollar = kind(
        "Dollar",
        [{ symbols: [{ symbol: "$", spacing: "compact", position: "prefix" }] }],
        { human: "$" },
      );
      const neg = Rate.from(-3_000, Dollar, BTC);
      assert.strictEqual(neg.toJSON(), "-$3,000/BTC");
      assert(Rate.parse(neg.toJSON(), Dollar, BTC).eq(neg));
    });

    //an APR used to serialize against the standard den unit as a per-second mixed-number
    //  monstrosity ("1/6,311,520 %/s"); the den search finds the unit the ratio terminates
    //  against
    it("picks the denominator unit the ratio terminates against", () => {
      const apr = Rate.parse("5 %/yr", Percentage, Duration);
      assert.strictEqual(apr.toJSON(), "5 %/yr");
      assert(Rate.parse(apr.toJSON(), Percentage, Duration).eq(apr));
    });

    it("termination outranks total length in the den search", () => {
      //"1/3 x/s" renders shorter than any terminating pair, but only h and min terminate
      //  (both at total length 7, so the larger scale wins the tie)
      const rate = Rate.parse("1/3 x/s", Percentage, Duration);
      assert.strictEqual(rate.toJSON(), "1,200 x/h");
      assert(Rate.parse(rate.toJSON(), Percentage, Duration).eq(rate));
    });

    it("finds the one den unit that cancels the ratio's denominator", () => {
      const rate = Rate.parse("1/7 x/s", Percentage, Duration);
      assert.strictEqual(rate.toJSON(), "86,400 x/week");
      assert(Rate.parse(rate.toJSON(), Percentage, Duration).eq(rate));
    });

    it("stays on the mixed-number form when no den unit terminates", () => {
      //11 divides no scale in the ladder, so every den unit renders mixed; the numerator sits in
      //  the unit approximate would show it in (9.09 %), not the one with the shortest numeral
      const rate = Rate.parse("1/11 x/s", Percentage, Duration);
      assert.strictEqual(rate.toJSON(), "9 1/11 %/s");
      assert(Rate.parse(rate.toJSON(), Percentage, Duration).eq(rate));
    });

    it("quotes against the denominator's human unit when it has one, like toString", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.toJSON(), "50,000 USD/BTC");
      assert.strictEqual(conv.toJSON().split("/")[1], conv.toString().split("/")[1]);
    });

    it("renders a zero ratio in human units", () => {
      const conv = Rate.from(0, USD, BTC);
      assert.strictEqual(conv.toJSON(), "0 USD/BTC");
    });
  });

  describe("in", () => {
    it("returns ratio for human/human units", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("supports atomic denominator scaling", () => {
      const conv = Rate.from(50_000, USD, BTC);
      assert.strictEqual(conv.in("USD", "satoshi").toString(), "0.0005");
    });

    it("supports atomic numerator scaling", () => {
      const btcToEth = Rate.from(2, BTC, ETH);
      assert.strictEqual(btcToEth.in("satoshi", "ETH").toString(), "200000000");
    });

    it("works with combined conversions and different units", () => {
      const usdToBtc = Rate.from(50_000, USD, BTC);
      const btcToEth = Rate.from(2, BTC, ETH);
      const usdToEth = usdToBtc.combine(btcToEth);
      assert.strictEqual(usdToEth.in("USD", "ETH").toString(), "100000");

      const [num, den] = usdToEth.in("USD", "wei").unwrap();
      assert.strictEqual(num, 1n);
      assert.strictEqual(den, 10_000_000_000_000n);
    });
  });

  describe("hasNum", () => {
    it("narrows numerator kind", () => {
      const conv: Rate<typeof USD | typeof ETH, typeof BTC> =
        Rate.from(50_000, USD, BTC);
      if (!Rate.hasNum(conv, USD))
        throw new Error("unexpected");
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    //cast rather than annotated: a declared union narrows to its initializer on assignment
    it("returns false for non-matching kind", () => {
      const conv = Rate.from(50_000, USD, BTC) as Rate<typeof USD | typeof ETH, typeof BTC>;
      assert.strictEqual(Rate.hasNum(conv, ETH), false);
      // @ts-expect-error | a kind the union does not spell on that side
      Rate.hasNum(conv, BTC);
    });
  });

  describe("hasDen", () => {
    it("narrows denominator kind", () => {
      const conv: Rate<typeof USD, typeof BTC | typeof ETH> =
        Rate.from(50_000, USD, BTC);
      if (!Rate.hasDen(conv, BTC))
        throw new Error("unexpected");
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("returns false for non-matching kind", () => {
      const conv = Rate.from(50_000, USD, BTC) as Rate<typeof USD, typeof BTC | typeof ETH>;
      assert.strictEqual(Rate.hasDen(conv, ETH), false);
    });

    //regression: the guards took a name and narrowed a bare Rate<Kind, Kind> to never
    it("narrows a bare-kind rate to the kind given on that side", () => {
      const bare = Rate.from(50_000, USD, BTC) as Rate<Kind, Kind>;
      if (!Rate.hasNum(bare, USD) || !Rate.hasDen(bare, BTC))
        throw new Error("unexpected");
      const narrowed: Rate<typeof USD, typeof BTC> = bare;
      assert.strictEqual(narrowed.in("USD", "BTC").toString(), "50000");
    });
  });

  describe("parse", () => {
    it("parses simple conversion string", () => {
      const conv = Rate.parse("50,000 USD/BTC", USD, BTC);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("parses conversion with single kinds", () => {
      const conv = Rate.parse("2 BTC/ETH", BTC, ETH);
      assert.strictEqual(conv.in("BTC", "ETH").toString(), "2");
    });

    it("parses conversion with arrays of kinds", () => {
      const conv = Rate.parse("50,000 USD/BTC", [USD], [BTC]);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("parses conversion with multiple numerator candidates", () => {
      const conv = Rate.parse("50,000 USD/BTC", [USD, ETH], BTC);
      if (!Rate.hasNum(conv, USD))
        throw new Error("unexpected");
      assert.strictEqual(conv.in("USD", "BTC").toString(), "50000");
    });

    it("parses conversion with multiple denominator candidates", () => {
      const conv = Rate.parse("2 BTC/ETH", BTC, [ETH, USD]);
      if (!Rate.hasDen(conv, ETH))
        throw new Error("unexpected");
      assert.strictEqual(conv.in("BTC", "ETH").toString(), "2");
    });

    it("parses conversion with different unit symbols", () => {
      const conv = Rate.parse("100 cent/BTC", USD, BTC);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "1");
    });

    it("parses conversion with fractional numerator", () => {
      const conv = Rate.parse("0.5 BTC/ETH", BTC, ETH);
      assert.strictEqual(conv.in("BTC", "ETH").toString(), "0.5");
    });

    it("parses conversion with negative numerator", () => {
      const conv = Rate.parse("-100 USD/BTC", USD, BTC);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "-100");
    });

    it("throws on invalid format - no slash", () => {
      assert.throws(
        () => Rate.parse("50000 USD BTC", USD, BTC),
        /Expected string in format 'numerator\/denominator'/
      );
    });

    it("parses conversion with ratio in numerator", () => {
      const conv = Rate.parse("1/2 USD/BTC", USD, BTC);
      assert.strictEqual(conv.in("USD", "BTC").toString(), "0.5");
    });

    it("throws on unidentifiable numerator kind", () => {
      assert.throws(
        () => Rate.parse("50000 UNKNOWN/BTC", USD, BTC),
        /Could not identify kind from string/
      );
    });

    it("throws on unidentifiable denominator kind", () => {
      assert.throws(
        () => Rate.parse("50000 USD/UNKNOWN", USD, BTC),
        /Could not identify denominator kind from string/
      );
    });

    it("creates equivalent conversion to from method", () => {
      const parsed = Rate.parse("50000 USD/BTC", USD, BTC);
      const from = Rate.from(50_000n, USD, BTC);
      assert.strictEqual(parsed.in("USD", "BTC").toString(), from.in("USD", "BTC").toString());
    });
  });

  describe("precision type constraints", () => {
    const inch = Rational.from(254n, tenToThe(4));
    const Length = kind(
      "Length",
      [
        ["metric", [
          { symbols: [{ symbol: "m" }] },
          { symbols: [{ symbol: "cm" }], oom: -2 },
        ]],
        ["imperial", [
          { symbols: [{ symbol: "in" }], scale: inch },
          { symbols: [{ symbol: "ft" }], scale: inch.mul(12) },
        ]],
      ],
      { human: "m" },
    );

    it("rejects non-oom precision symbols at type level", () => {
      const conv = Rate.from(100, Length, USD);
      // Type-level verification only - never executed at runtime
      if (false as boolean) {
        // @ts-expect-error - "in" is not an oom symbol (imperial is non-decimal)
        conv.toString({ numSymbol: "m", precision: "in" });
        // @ts-expect-error - "ft" is non-decimal, so NO symbol precision allowed
        conv.toString({ numSymbol: "ft", precision: "cm" });
      }
    });
  });
});
